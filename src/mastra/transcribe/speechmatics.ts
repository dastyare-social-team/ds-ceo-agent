import { getCredentialSecret } from '../db/client.ts';

/**
 * Speechmatics batch transcription.
 *
 * Video is the one media type the model cannot work from: it has no way to watch
 * a file, so without a transcript every video dead-ends at "describe it for me".
 * Speechmatics is the video counterpart to the Groq call that handles voice.
 *
 * Batch, not realtime, because there is nothing to stream. A Telegram video
 * arrives complete, so the job is submitted, polled within a budget, and the
 * transcript returned. Realtime would buy latency on a stream that does not
 * exist.
 *
 * The API is three calls: POST /v2/jobs with the audio as the body, poll
 * GET /v2/jobs/{id} until the status settles, then GET /v2/jobs/{id}/transcript.
 * Auth is `Authorization: Bearer <key>`, and the key is versioned per account in
 * the encrypted store so several workspaces can be switched between by name.
 */

const BASE = process.env.SPEECHMATICS_API_URL ?? 'https://api.speechmatics.com/v2';
/**
 * Speechmatics is asynchronous, so a job may outlive one webhook invocation. The
 * budget is bounded by how long the platform will hold the function: long enough
 * for a typical phone-recorded clip, short enough to fail visibly rather than
 * time out silently. A job that outruns it stays queryable, so the transcript can
 * be collected on a later turn instead of being lost.
 */
const POLL_BUDGET_MS = Number(process.env.SPEECHMATICS_POLL_BUDGET_MS ?? 60_000);
const POLL_INTERVAL_MS = 2_000;
/** Speechmatics rejects oversized uploads; refuse locally with a clearer message. */
const MAX_BYTES = 100 * 1024 * 1024;

export interface Transcript {
  text: string;
  language?: string;
  durationSeconds?: number;
  jobId: string;
}

/** Speechmatics' own error bodies are JSON, but a proxy may return HTML. */
function redact(detail: string): string {
  return detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer ***')
    .slice(0, 300);
}

async function apiKey(account = 'default'): Promise<string> {
  const key =
    (await getCredentialSecret('speechmatics', account)) ?? process.env.SPEECHMATICS_API_KEY;
  if (!key) {
    throw new Error(
      'No Speechmatics key is stored. Paste one in chat and it will be saved encrypted.',
    );
  }
  return key;
}

/**
 * Speechmatics infers the decoder from the content type, so a Telegram video sent
 * as an mp4 must be declared mp4. A mismatch is rejected outright rather than
 * guessed at.
 */
function contentTypeFor(kind: string, fileName?: string | null): string {
  if (fileName?.toLowerCase().endsWith('.mov')) return 'video/quicktime';
  if (fileName?.toLowerCase().endsWith('.webm')) return 'video/webm';
  if (fileName?.toLowerCase().endsWith('.mp4')) return 'video/mp4';
  return kind === 'audio' ? 'audio/mpeg' : 'video/mp4';
}

/** Submits a job and returns its id. The job outlives this call. */
export async function submitJob(
  bytes: Uint8Array,
  options: { kind?: string; fileName?: string | null; account?: string; language?: string } = {},
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error('Nothing to transcribe: the file was empty');

  // Speechmatics bills per audio minute against a real account, so a test run
  // must never submit a job. The same reasoning as the Zernio publish guard.
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error('Transcription blocked: this process is a test run.');
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `File is ${(bytes.byteLength / 1024 / 1024).toFixed(0)}MB; the transcription limit is 100MB`,
    );
  }

  const key = await apiKey(options.account);
  const url = new URL(`${BASE}/jobs`);
  // Diarisation is off by default: captions are single-voice, and paying for
  // speaker labels nobody asked for spends credits for nothing.
  if (options.language) url.searchParams.set('language', options.language);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': contentTypeFor(options.kind ?? 'video', options.fileName),
      },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach Speechmatics: ${redact(String((cause as Error)?.message ?? cause))}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Speechmatics rejected the API key. Add a fresh one.');
  }
  if (response.status === 402 || response.status === 429) {
    // Speechmatics bills by audio minute, so an exhausted balance looks like this.
    throw new Error(
      `Speechmatics refused the job (HTTP ${response.status}) — usually out of credits or rate limited.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Speechmatics returned HTTP ${response.status}: ${redact((await response.text()).slice(0, 300))}`,
    );
  }

  const payload = (await response.json()) as { id?: string };
  if (!payload?.id) throw new Error('Speechmatics accepted the job but returned no id');
  return payload.id;
}

interface JobDetails {
  job?: { status?: string; format?: { output?: string; error?: string } };
}

/** Current status, or 'done'. */
export async function jobStatus(jobId: string, account = 'default'): Promise<string> {
  const key = await apiKey(account);
  const response = await fetch(`${BASE}/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not read job ${jobId}: HTTP ${response.status}`);
  }
  const details = (await response.json()) as JobDetails;
  return details.job?.status ?? 'unknown';
}

interface TranscriptResponse {
  results?: {
    type?: string;
    alternatives?: { content?: string; confidence?: number }[];
  }[];
  metadata?: {
    transcription_config?: { language?: string; diarization?: string };
    duration?: number;
  };
}

/**
 * Pulls readable text out of a transcript.
 *
 * The wire format is a flat list of word results, which is wrong for a caption —
 * a caption needs punctuation and sentence boundaries. Speechmatics also returns
 * paragraph results when enabled, so those are preferred and the word list is only
 * the fallback.
 */
export function extractText(payload: TranscriptResponse): string {
  const results = payload.results ?? [];
  const paragraphs = results.filter((r) => r.type === 'paragraph');
  if (paragraphs.length) {
    return paragraphs
      .map((p) => p.alternatives?.[0]?.content?.trim())
      .filter(Boolean)
      .join('\n\n');
  }
  return results
    .map((r) => r.alternatives?.[0]?.content)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

/** Fetches the transcript for a finished job. */
export async function fetchTranscript(
  jobId: string,
  account = 'default',
): Promise<Transcript> {
  const key = await apiKey(account);
  const response = await fetch(`${BASE}/jobs/${jobId}/transcript`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 410) {
    throw new Error('That transcript has expired. Transcribe the file again.');
  }
  if (!response.ok) {
    throw new Error(`Could not read transcript: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as TranscriptResponse;
  return {
    text: extractText(payload),
    language: payload.metadata?.transcription_config?.language,
    durationSeconds: payload.metadata?.duration,
    jobId,
  };
}

export interface TranscribeOutcome {
  ok: boolean;
  transcript?: Transcript;
  /** True when the job is still running and can be collected later. */
  pending?: boolean;
  message: string;
}

/**
 * Submits and waits, within a bounded budget.
 *
 * `pending` is a real outcome rather than a failure: Speechmatics keeps the job
 * and the caller can collect it on a later turn, which is the right behaviour for
 * a long file on a platform that will not hold a function open indefinitely.
 */
export async function transcribeMedia(
  bytes: Uint8Array,
  options: { kind?: string; fileName?: string | null; account?: string; language?: string } = {},
): Promise<TranscribeOutcome> {
  const jobId = await submitJob(bytes, options);
  const account = options.account ?? 'default';
  const deadline = Date.now() + POLL_BUDGET_MS;

  while (Date.now() < deadline) {
    const status = await jobStatus(jobId, account);
    if (status === 'done') {
      const transcript = await fetchTranscript(jobId, account);
      if (!transcript.text) {
        return { ok: false, message: 'Speechmatics returned no speech to transcribe.' };
      }
      return { ok: true, transcript, message: 'Transcribed.' };
    }
    if (status === 'rejected') {
      return {
        ok: false,
        message: `Speechmatics rejected the job. Job ${jobId}.`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    pending: true,
    message: `Still transcribing (job ${jobId}). Send the video again in a moment to collect the transcript.`,
  };
}