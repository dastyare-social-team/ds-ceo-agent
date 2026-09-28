import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Voice notes, transcribed locally.
 *
 * Telegram delivers OGG/Opus. sherpa-onnx wants 16kHz mono PCM, so the bytes go
 * through a pure-WASM Opus decoder, get resampled, and are recognised in-process.
 * No API key, and no audio leaves the machine.
 *
 * Why sherpa-onnx and not transformers.js: the Whisper runtime it replaces pulled
 * in onnxruntime-node and onnxruntime-web as hard dependencies, which is 427MB of
 * inference backends for every platform at once, and the Vercel function limit is
 * 250MB. sherpa-onnx is a 0MB JS wrapper over one platform-specific binary —
 * 31MB on linux-x64 — with int8 models fetched at runtime. Same job, a fraction of
 * the weight, and measured far faster: 0.1s versus 60s for the same file.
 *
 * Nothing is imported eagerly. The Opus decoder and the recogniser are both loaded
 * on first use, so a text-only run never pays for them.
 */

const run = promisify(execFile);

const DEFAULT_MODEL = 'sherpa-onnx-whisper-tiny.en';
const ASR_SAMPLE_RATE = 16_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 5 * 60;

export interface TranscribedVoice {
  text: string;
  /** Seconds of audio, useful for logging and for the "too long" guard. */
  seconds: number;
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

/**
 * Model files are downloaded on first use. transformers.js defaulted its cache to a
 * directory inside node_modules, which is read-only on Vercel and failed with
 * ENOENT on mkdir, so the same rule applies here: only a genuinely writable path
 * is used.
 */
function cacheRoot(): string {
  const candidates = [
    process.env.WHISPER_CACHE_DIR,
    existsSync('/tmp') ? '/tmp/sherpa-models' : undefined,
    join(process.cwd(), '.cache', 'sherpa-models'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // Try the next candidate rather than failing the voice note outright.
    }
  }
  throw new Error('No writable directory for the speech model cache');
}

function modelName(): string {
  return process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
}

/**
 * sherpa-onnx-whisper-tiny.en contains tiny.en-encoder.int8.onnx, so the
 * "whisper-" segment goes too. This is the one naming quirk worth knowing about.
 */
function stem(name: string): string {
  return name.replace(/^sherpa-onnx-whisper-/, '');
}

/** The file set a model must have before it is considered present. */
function modelFiles(dir: string, stem: string): { encoder: string; decoder: string; tokens: string } {
  return {
    encoder: join(dir, `${stem}-encoder.int8.onnx`),
    decoder: join(dir, `${stem}-decoder.int8.onnx`),
    tokens: join(dir, `${stem}-tokens.txt`),
  };
}

/**
 * Returns the model directory, downloading and unpacking it on first use. The
 * archive is int8 quantised, so it stays small, and /tmp is wiped on Vercel
 * whenever the instance recycles, which means a cold start may pay this again.
 */
async function ensureModel(): Promise<string> {
  const name = modelName();
  // The archive unpacks into a directory named after the model, but the files
  // inside drop the "whisper-" part too: sherpa-onnx-whisper-tiny.en contains
  // tiny.en-encoder.int8.onnx, not whisper-tiny.en-encoder.int8.onnx.
  const dir = join(cacheRoot(), name);
  const files = modelFiles(dir, stem(name));
  if (existsSync(files.encoder) && existsSync(files.decoder) && existsSync(files.tokens)) {
    return dir;
  }

  const base = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
  // The archive unpacks into a directory of the same name, so extract one level up
  // and let tar create it. Writing the archive inside it first fails with ENOENT.
  const archive = join(cacheRoot(), `${name}.tar.bz2`);
  const url = `${base}/${name}.tar.bz2`;

  mkdirSync(dir, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the speech model (HTTP ${response.status}) from ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(archive, bytes);
  // `tar` is present on the platforms this runs on; bzip2 is what the archive uses.
  await run('tar', ['xjf', archive, '-C', cacheRoot()]);

  if (!existsSync(files.encoder) || !existsSync(files.decoder) || !existsSync(files.tokens)) {
    throw new Error(`Speech model archive did not contain the expected files in ${dir}`);
  }
  return dir;
}

let recognizer: unknown;
let loading: Promise<unknown> | undefined;

function asr(): Promise<unknown> {
  if (recognizer) return Promise.resolve(recognizer);
  if (!loading) {
    loading = ensureModel().then((dir) => {
      const require = createRequire(import.meta.url);
      const sherpa = require('sherpa-onnx-node') as {
        OfflineRecognizer: new (config: unknown) => never;
      };
      const files = modelFiles(dir, stem(modelName()));
      recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          whisper: {
            encoder: files.encoder,
            decoder: files.decoder,
            tokens: files.tokens,
            language: 'en',
            task: 'transcribe',
          },
          // The binding validates this top-level copy too, even for whisper models.
          tokens: files.tokens,
          numThreads: 2,
          provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
      });
      return recognizer;
    });
  }
  return loading;
}

/** OGG/Opus bytes to 16kHz mono float samples. */
async function toPcm16k(bytes: Uint8Array): Promise<{ samples: Float32Array; seconds: number }> {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const pcm = (await (new OggOpusDecoder().decode(bytes) as unknown as Promise<{
    channelData: Float32Array[] | Float32Array;
    samplesDecoded: number;
    sampleRate: number;
  }>));

  const channels = Array.isArray(pcm.channelData) ? pcm.channelData : [pcm.channelData];
  const first = channels[0];
  const length = first?.length ?? pcm.samplesDecoded ?? 0;
  // Voice notes are mono, but average channels rather than trusting that.
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += (channel[i] ?? 0) / channels.length;
  }

  const sourceRate = pcm.sampleRate || 48_000;
  const outLength = Math.ceil((length / sourceRate) * ASR_SAMPLE_RATE);
  const samples = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const source = Math.min(length - 1, Math.floor((i / ASR_SAMPLE_RATE) * sourceRate));
    samples[i] = mono[source];
  }

  const seconds = length / sourceRate;
  if (seconds > MAX_SECONDS) {
    throw new Error(`Voice message is ${Math.round(seconds)}s; limit is ${MAX_SECONDS}s`);
  }
  return { samples, seconds };
}

/** Transcribes a Telegram voice message on this machine. */
export async function transcribeVoice(message: unknown): Promise<TranscribedVoice> {
  const bytes = await audioBytes(message);
  if (bytes.byteLength === 0) throw new Error('Voice message was empty');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`Voice message is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; limit is 20MB`);
  }

  const { samples, seconds } = await toPcm16k(bytes);
  if (samples.length === 0) throw new Error('Voice message decoded to no audio');

  const engine = (await asr()) as {
    createStream: () => { acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void };
    decode: (stream: unknown) => void;
    getResult: (stream: unknown) => { text: string };
  };

  const stream = engine.createStream();
  stream.acceptWaveform({ sampleRate: ASR_SAMPLE_RATE, samples });
  engine.decode(stream);
  const { text } = engine.getResult(stream);

  return { text: text.trim(), seconds };
}

/** Models available for WHISPER_MODEL, for the error message when one is missing. */
export function cachedModels(): string[] {
  try {
    return readdirSync(cacheRoot());
  } catch {
    return [];
  }
}
