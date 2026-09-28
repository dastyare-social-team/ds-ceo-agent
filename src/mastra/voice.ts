import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Voice notes, transcribed by Groq with a local sherpa-onnx fallback.
 *
 * Telegram delivers OGG/Opus. Groq's Whisper endpoint accepts that container
 * directly, so the hosted path uploads the bytes unmodified — no decoder, no
 * resampling, no WAV, no format sniffing. Measured 0.7s for a 4s voice note.
 *
 * Why hosted by default: the local path works, but only just. It needs a
 * platform-native ONNX binary that has to be present in the deployed function
 * for the exact platform Vercel picked, plus a ~2 min model download on every
 * cold start, because /tmp is wiped when an instance recycles. A hosted
 * endpoint has none of those failure modes and it is an order of magnitude
 * faster, so it is tried first whenever a key is present.
 *
 * The local recogniser is still here on purpose. It needs no API key, no credit
 * card and no network, it keeps audio on the machine, and nothing imports it
 * until it is actually the chosen provider — so a broken native binary can
 * never affect a run that Groq already served.
 *
 * Which one runs is decided by TRANSCRIBE_PROVIDER:
 *   auto  (default) Groq when GROQ_API_KEY is set, otherwise local
 *   groq             Groq only; a missing key is an error, never a silent switch
 *   local            sherpa-onnx only, ignoring any key
 */

/** Where the hosted path sends audio, and what to tell a reader about it. */
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3';
/** Generous next to the 0.7-1.8s it actually takes, short enough to still report an error. */
const GROQ_TIMEOUT_MS = 25_000;

const DEFAULT_LOCAL_MODEL = 'sherpa-onnx-whisper-tiny.en';
const ASR_SAMPLE_RATE = 16_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 5 * 60;

export type TranscribeProvider = 'groq' | 'local';

export interface TranscribedVoice {
  text: string;
  /** Seconds of audio, useful for logging and for the "too long" guard. */
  seconds: number;
  /** Which engine produced this, so the reply never mislabels the source. */
  provider: TranscribeProvider;
}

/** Human-readable engine name for the "Heard (...)" line the user sees. */
export function providerLabel(provider: TranscribeProvider): string {
  return provider === 'groq' ? 'Groq Whisper' : 'local Whisper';
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
 * Keeps a credential or a bearer token out of anything the user might see.
 *
 * The hosted error path is the one place a secret could plausibly escape: an
 * HTTP failure body or a thrown fetch error can echo the request headers back.
 * Since that detail ends up in a Telegram message, every provider error goes
 * through here first.
 */
function redact(detail: string): string {
  return detail
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
}

/**
 * Picks the engine for this call.
 *
 * The key is read on every call rather than at import time so a redeploy that
 * only changes an environment variable takes effect, and so tests can exercise
 * both branches without reloading the module.
 *
 * The *mode* is kept separate from the engine it resolves to, because the two
 * behave differently: an explicit `groq` must fail rather than quietly fall
 * back, while `auto` is precisely the request to fall back.
 */
function resolveMode(): 'auto' | 'groq' | 'local' {
  const requested = (process.env.TRANSCRIBE_PROVIDER ?? 'auto').trim().toLowerCase();
  if (requested === 'groq' || requested === 'local') return requested;
  return 'auto';
}

/** Pulls the message out of a Groq error body, falling back to a raw excerpt. */
function groqErrorBody(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON. Fall through to the raw excerpt below.
  }
  return raw.slice(0, 300);
}

async function transcribeWithGroq(bytes: Uint8Array): Promise<{ text: string; seconds: number }> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('TRANSCRIBE_PROVIDER=groq but GROQ_API_KEY is empty');

  const form = new FormData();
  // Telegram voice notes are OGG/Opus. Whisper reads the container as-is, so the
  // bytes are uploaded exactly as received and the filename is the only fiction.
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'voice.ogg');
  form.set('model', process.env.GROQ_STT_MODEL?.trim() || DEFAULT_GROQ_MODEL);
  // verbose_json rather than json, because the duration is what the "Heard (Ns)"
  // line reports and there is no way to measure it without decoding the audio.
  form.set('response_format', 'verbose_json');

  let response: Response;
  try {
    response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`Could not reach Groq: ${redact(String((cause as Error)?.message ?? cause))}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Groq returned HTTP ${response.status}: ${redact(groqErrorBody(raw))}`);
  }

  let payload: { text?: string; duration?: number };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new Error(`Groq sent a body that was not JSON: ${redact(raw.slice(0, 300))}`);
  }
  if (typeof payload.text !== 'string') {
    throw new Error(`Groq sent no transcript: ${redact(raw.slice(0, 300))}`);
  }
  return { text: payload.text, seconds: payload.duration ?? 0 };
}

// --- local path -------------------------------------------------------------
// Everything below is the sherpa-onnx recogniser and its one-time model unpack.
// It is only reached when local is the chosen provider, or as a fallback after a
// hosted failure, so the heavy imports stay dynamic and off the hosted path.

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
  return process.env.WHISPER_MODEL ?? DEFAULT_LOCAL_MODEL;
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
  const url = `${base}/${name}.tar.bz2`;

  mkdirSync(dir, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the speech model (HTTP ${response.status}) from ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await extractBzip2Tar(bytes, cacheRoot());

  if (!existsSync(files.encoder) || !existsSync(files.decoder) || !existsSync(files.tokens)) {
    throw new Error(`Speech model archive did not contain the expected files in ${dir}`);
  }
  return dir;
}

/**
 * Unpacks a .tar.bz2 entirely in JavaScript.
 *
 * This used to shell out to `tar xjf`, which worked on a laptop and failed on
 * Vercel with `spawn tar ENOENT`: the serverless Node runtime has no tar on
 * PATH, and a missing binary is a runtime error the bot can only report after
 * deployment. tar-stream plus unbzip2-stream have no native build and no external
 * process, so the same path works on Vercel, Docker, and a workstation.
 *
 * Entries are written only under the destination directory; a path traversal in
 * the archive is skipped rather than followed.
 */
async function extractBzip2Tar(bytes: Buffer, destination: string): Promise<void> {
  // Both packages are CommonJS. unbzip2-stream's module.exports is the stream
  // factory itself rather than an object with createBzip2 on it, so it is
  // resolved through createRequire and called directly.
  const require = createRequire(import.meta.url);
  const createBzip2 = require('unbzip2-stream') as () => NodeJS.ReadWriteStream;
  const { extract } = require('tar-stream') as {
    extract: () => NodeJS.ReadWriteStream & {
      on: (e: string, f: (h: { name: string; type?: string }, s: NodeJS.ReadableStream, n: (err?: Error | null) => void) => void) => void;
    };
  };

  const extractor = extract();
  const written: Promise<void>[] = [];

  extractor.on('entry', (header, stream, next) => {
    const target = join(destination, header.name);
    // Refuse anything that would escape the destination directory.
    if (!target.startsWith(destination) || header.type === 'directory') {
      stream.resume();
      next();
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    written.push(
      streamPipeline(stream, createWriteStream(target)).then(() => next()),
    );
  });

  await streamPipeline(
    Readable.from([bytes]),
    createBzip2(),
    extractor,
  );
  await Promise.all(written);
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

async function transcribeLocally(bytes: Uint8Array): Promise<{ text: string; seconds: number }> {
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

// --- entry point ------------------------------------------------------------

/** Transcribes a Telegram voice message, hosted first when a key is configured. */
export async function transcribeVoice(message: unknown): Promise<TranscribedVoice> {
  const bytes = await audioBytes(message);
  if (bytes.byteLength === 0) throw new Error('Voice message was empty');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`Voice message is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; limit is 20MB`);
  }

  const mode = resolveMode();

  if (mode === 'groq') {
    // An explicit groq must not quietly become a local run, so a missing key here
    // is an error rather than a fallback.
    return { ...(await transcribeWithGroq(bytes)), provider: 'groq' };
  }

  if (mode === 'local') {
    return { ...(await transcribeLocally(bytes)), provider: 'local' };
  }

  // auto without a key is just local: do not open a socket to find that out.
  if (!process.env.GROQ_API_KEY?.trim()) {
    return { ...(await transcribeLocally(bytes)), provider: 'local' };
  }

  // auto with a key: hosted first, local as the rescue.
  try {
    return { ...(await transcribeWithGroq(bytes)), provider: 'groq' };
  } catch (hosted) {
    const hostedDetail = String((hosted as Error)?.message ?? hosted);
    try {
      return { ...(await transcribeLocally(bytes)), provider: 'local' };
    } catch (local) {
      // Both failed. The hosted reason leads, because on a serverless deploy the
      // local failure is usually just a missing native binary and the hosted one
      // is the part a reader can act on.
      throw new Error(
        `${hostedDetail} — local fallback also failed: ${redact(String((local as Error)?.message ?? local))}`,
      );
    }
  }
}

/** Models available for WHISPER_MODEL, for the error message when one is missing. */
export function cachedModels(): string[] {
  try {
    return readdirSync(cacheRoot());
  } catch {
    return [];
  }
}
