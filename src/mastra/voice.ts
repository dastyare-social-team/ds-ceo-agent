import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Voice notes, transcribed locally.

/**
 * Voice notes, transcribed locally.
 *
 * Telegram delivers voice messages as OGG/Opus. Whisper wants raw PCM, so the
 * bytes go through a pure-WASM Opus decoder first, then into a Whisper model
 * running in-process through transformers.js. No audio leaves the machine and
 * no transcription API key is required.
 *
 * Why these two libraries: `ogg-opus-decoder` is WASM, so it needs no native
 * build and behaves the same on Vercel, Docker, or a laptop. `onnxruntime-node`
 * (pulled in by transformers.js) does ship a native binary, but it has prebuilt
 * builds for linux/darwin/win32, which is why `vercel.json` includes its `bin`
 * directory — see the note there.
 *
 * The model is fetched from Hugging Face on first use and cached on disk. On
 * Vercel that cache is per-instance in `/tmp`, so the first voice note after a
 * cold start pays the download; later ones are warm. That is the trade for not
 * shipping ~40MB of weights inside the function bundle.
 */

const DEFAULT_MODEL = 'Xenova/whisper-tiny.en';
const DEFAULT_DTYPE = 'q8';

/** Telegram voice notes are Opus at 48kHz; anything much longer is not a message. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 5 * 60;

export interface TranscribedVoice {
  text: string;
  /** Seconds of audio, useful for logging and for the "too long" guard. */
  seconds: number;
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string }>;

/**
 * One pipeline per process, reused across calls. Loading a model costs seconds,
 * so a warm lambda should never pay it twice. The promise (not the value) is
 * cached so concurrent first calls share a single load instead of racing.
 */
let modelPromise: Promise<AsrPipeline> | undefined;

/**
 * transformers.js caches downloaded weights next to its own module by default,
 * i.e. node_modules/@huggingface/transformers/.cache. On Vercel that resolves to
 * /var/task/node_modules/... which is read-only, so the first voice note failed
 * with ENOENT on mkdir. Point the cache somewhere writable instead.
 */
function writableCacheDir(): string {
  const candidates = [
    process.env.WHISPER_CACHE_DIR,
    // Vercel and most container hosts allow writes to /tmp and nowhere else.
    existsSync('/tmp') ? '/tmp/whisper-models' : undefined,
    join(process.cwd(), '.cache', 'whisper-models'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Try the next candidate rather than failing the voice note outright.
    }
  }
  throw new Error('No writable directory for the Whisper model cache');
}

function asr(): Promise<AsrPipeline> {
  if (!modelPromise) {
    const model = process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
    const dtype = (process.env.WHISPER_DTYPE ?? DEFAULT_DTYPE) as never;
    modelPromise = import('@huggingface/transformers').then(({ env, pipeline }) => {
      env.cacheDir = writableCacheDir();
      // Model files come from the Hub, not from disk next to the bundle.
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', model, { dtype }).then(
        (p) => p as unknown as AsrPipeline,
      );
    });
  }
  return modelPromise;
}


type AudioAttachment = { type?: string; fetchData?: () => Promise<unknown> };

/** True for a voice message: audio attached, and no caption that already says it. */
export function isVoiceMessage(message: unknown): boolean {
  const m = message as { text?: unknown; attachments?: unknown };
  if (typeof m?.text === 'string' && m.text.trim().length > 0) return false;
  const attachments = (m?.attachments ?? []) as AudioAttachment[];
  return attachments.some((a) => a?.type === 'audio' && typeof a?.fetchData === 'function');
}

async function audioBytes(message: unknown): Promise<Uint8Array> {
  const attachments = ((message as { attachments?: unknown })?.attachments ?? []) as AudioAttachment[];
  const attachment = attachments.find((a) => a?.type === 'audio' && typeof a?.fetchData === 'function');
  if (!attachment?.fetchData) throw new Error('No audio attachment on the message');

  const data = await attachment.fetchData();
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof (data as Blob).arrayBuffer === 'function') {
    return new Uint8Array(await (data as Blob).arrayBuffer());
  }
  throw new Error(`Unexpected audio payload: ${typeof data}`);
}

/** OGG/Opus bytes to mono 16-bit-normalised float samples. */
async function decodeOpus(bytes: Uint8Array): Promise<{ audio: Float32Array; seconds: number }> {
  // The published types say this is sync, but decode() is async at runtime.
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const pcm = (await (new OggOpusDecoder().decode(bytes) as unknown as Promise<{
    channelData: Float32Array[] | Float32Array;
    samplesDecoded: number;
    sampleRate: number;
  }>));
  {
      const { channelData, samplesDecoded, sampleRate } = pcm;
      // Voice notes are mono, but average channels rather than trusting that.
      const channels = Array.isArray(channelData) ? channelData : [channelData];
      const length = channels[0]?.length ?? samplesDecoded ?? 0;
      const audio = new Float32Array(length);
      for (const channel of channels) {
        for (let i = 0; i < length; i += 1) audio[i] += (channel[i] ?? 0) / channels.length;
      }
      const seconds = length / (sampleRate || 48000);
      if (seconds > MAX_SECONDS) {
        throw new Error(`Voice message is ${Math.round(seconds)}s; limit is ${MAX_SECONDS}s`);
      }
    return { audio, seconds };
  }
}

/** Transcribes a Telegram voice message on this machine. */
export async function transcribeVoice(message: unknown): Promise<TranscribedVoice> {
  const bytes = await audioBytes(message);
  if (bytes.byteLength === 0) throw new Error('Voice message was empty');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`Voice message is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; limit is 20MB`);
  }

  const { audio, seconds } = await decodeOpus(bytes);
  if (audio.length === 0) throw new Error('Voice message decoded to no audio');

  const { text } = await (await asr())(audio, {
    chunk_length_s: 30,
    return_timestamps: false,
    // Voice notes are conversational; without this the model invents punctuation
    // and capitalises in a way that misleads the agent reading the transcript.
    condition_on_previous_text: false,
  });

  return { text: text.trim(), seconds };
}
