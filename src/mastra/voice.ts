/**
 * Voice notes, transcribed by Groq.
 *
 * Telegram delivers OGG/Opus. Groq's Whisper endpoint reads that container
 * directly, so the bytes are uploaded exactly as received: no decoder, no
 * resampling, no WAV, no format sniffing. Measured 0.7s for a 4s note, and more
 * accurate than the local engine that preceded it.
 *
 * There is no local fallback. It was there to keep audio on the machine, but it
 * needed a platform-native ONNX binary present in the deployed artifact for
 * whichever platform Vercel picked, plus an int8 model download on every cold
 * start because /tmp dies with the instance. That is a lot of machinery and
 * roughly 12MB of WASM decoders to keep a privacy property nobody was using, and
 * the hosted call has none of those failure modes. If a deployment must not send
 * audio anywhere, run it somewhere self-hosted and point GROQ_API_KEY at an
 * internal endpoint instead.
 */

/** Where audio is sent, and what the caller is told about it. */
const GROQ_ENDPOINT = process.env.GROQ_STT_URL ?? 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_GROQ_MODEL = 'whisper-large-v3';
/** Generous next to the 0.7-1.8s it actually takes, short enough to still report an error. */
const GROQ_TIMEOUT_MS = 25_000;
/** Telegram's own bot-API download ceiling, so an oversized note fails fast. */
const MAX_BYTES = 20 * 1024 * 1024;

export interface TranscribedVoice {
  text: string;
  /** Seconds of audio, from the provider. Useful for logging. */
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

/**
 * The message to hand to the agent once a transcript exists: text replaced by the
 * transcript, audio attachments removed.
 *
 * Dropping the audio is the point. Setting the text is not enough, because the
 * voice note arrives as an attachment and the adapter forwards it to the model
 * along with the text. A text-only model then answers that it can see the audio
 * file but cannot play or transcribe it, and ignores the real transcript. Nothing
 * is listening twice, so the file has no reason to be forwarded.
 */
export function withTranscript(message: unknown, transcript: string): unknown {
  const original = (message ?? {}) as { attachments?: unknown };
  const attachments = (original.attachments ?? []) as AudioAttachment[];
  return {
    ...original,
    text: transcript,
    attachments: attachments.filter((a) => a?.type !== 'audio'),
  };
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
 * The request path is the one place a secret could plausibly escape: an HTTP
 * failure body or a thrown fetch error can echo the request headers back. Since
 * that detail ends up in a Telegram message, it goes through here first.
 */
function redact(detail: string): string {
  return detail
    .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1***');
}

/** Pulls the message out of an error body, falling back to a raw excerpt. */
function errorBody(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON. Fall through to the raw excerpt below.
  }
  return raw.slice(0, 300);
}

/** Transcribes a Telegram voice message. */
export async function transcribeVoice(message: unknown): Promise<TranscribedVoice> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('GROQ_API_KEY is not set, so voice notes cannot be transcribed');

  const bytes = await audioBytes(message);
  if (bytes.byteLength === 0) throw new Error('Voice message was empty');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`Voice message is ${Math.round(bytes.byteLength / 1024 / 1024)}MB; limit is 20MB`);
  }

  const form = new FormData();
  // Telegram voice notes are OGG/Opus. Whisper reads the container as-is, so the
  // bytes are uploaded exactly as received and the filename is the only fiction.
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'voice.ogg');
  form.set('model', process.env.GROQ_STT_MODEL?.trim() || DEFAULT_GROQ_MODEL);
  // verbose_json rather than json, because the duration is what the log reports
  // and there is no way to measure it without decoding the audio.
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
    throw new Error(`Could not reach the speech service: ${redact(String((cause as Error)?.message ?? cause))}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Speech service returned HTTP ${response.status}: ${redact(errorBody(raw))}`);
  }

  let payload: { text?: string; duration?: number };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new Error(`Speech service sent a body that was not JSON: ${redact(raw.slice(0, 300))}`);
  }
  if (typeof payload.text !== 'string') {
    throw new Error(`Speech service sent no transcript: ${redact(raw.slice(0, 300))}`);
  }

  return { text: payload.text.trim(), seconds: payload.duration ?? 0 };
}
