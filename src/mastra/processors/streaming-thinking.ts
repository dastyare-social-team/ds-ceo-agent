import type { Processor, ProcessOutputStreamArgs, ProcessOutputResultArgs } from '@mastra/core/processors';
import type { RequestContext } from '@mastra/core/request-context';
import type { MastraDBMessage } from '@mastra/core/memory';

/**
 * Live "thinking", then gone.
 *
 * The model streams reasoning before its answer. This shows that reasoning as it
 * arrives — a message posted once and then edited in place, so the chat does not
 * fill up with one line per token — and then **deletes it** when the answer is
 * ready. What is left is the answer alone, which is what you actually wanted to
 * read; the reasoning was only ever a progress signal.
 *
 * How it reaches the chat: the guarded channel handler puts the thread on the
 * per-message `requestContext` before handing off to the default handler, and this
 * processor reads it back from there. Processors do not otherwise get the thread,
 * and the alternative — reimplementing the channel's stream-and-post loop — would
 * bypass Mastra's signal and tool-approval handling on a path that is already
 * fragile (see the streaming notes in src/mastra/index.ts).
 */

/** requestContext key holding the channel thread. Set by the guarded handler. */
export const THREAD_CONTEXT_KEY = 'ds:channelThread';

export interface ChannelThreadLike {
  post: (message: string) => Promise<{ edit?: (m: string) => Promise<unknown>; delete?: () => Promise<void> }>;
}

const LABEL = 'Thinking';

/**
 * Only edit on new content, and at most this often, to stay under Telegram's rate
 * limits. Overridable because the right value depends on the chat's Telegram plan.
 */
function editThrottleMs(): number {
  const raw = Number(process.env.THINKING_EDIT_THROTTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 900;
}
const PREVIEW_LIMIT = 400;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, PREVIEW_LIMIT).trimEnd()}…`;
}

function threadFrom(context: unknown): ChannelThreadLike | undefined {
  const rc = context as RequestContext | undefined;
  if (!rc || typeof rc.get !== 'function') return undefined;
  const value = rc.get(THREAD_CONTEXT_KEY) as ChannelThreadLike | undefined;
  return value && typeof value.post === 'function' ? value : undefined;
}

type Sent = { edit?: (m: string) => Promise<unknown>; delete?: () => Promise<void> } | undefined;

interface ThinkState {
  sent?: Sent;
  text: string;
  lastEdit: number;
  done: boolean;
}

export class StreamingThinkingProcessor implements Processor<'streaming-thinking'> {
  readonly id = 'streaming-thinking' as const;

  /** Records reasoning as it streams, editing the live message in place. */
  async processOutputStream({ streamParts, state, requestContext }: ProcessOutputStreamArgs) {
    // Mastra types processor state as a bare record; narrow once, then reuse.
    const bag = state as Record<string, unknown>;
    if (!bag.__think) bag.__think = { text: '', lastEdit: 0, done: false };
    const s = bag.__think as ThinkState;
    const thread = threadFrom(requestContext);
    if (!thread || s.done) return null;

    // Rebuild from all chunks so reasoning split across several parts is not lost.
    const reasoning = streamParts
      .map((p) => (p as { type?: string }).type === 'reasoning' ? (p as { text?: string }).text : undefined)
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .join(' ');

    if (!reasoning) return null;
    const changed = reasoning !== s.text;
    s.text = reasoning;

    const body = `🧠 *${LABEL}*\n${preview(reasoning)}`;

    if (!s.sent) {
      try {
        s.sent = await thread.post(body);
        s.lastEdit = Date.now();
      } catch {
        // Nothing to show progress with; the answer will still be delivered.
        s.sent = undefined;
      }
      return null;
    }

    if (!changed) return null;
    const now = Date.now();
    if (now - s.lastEdit < editThrottleMs()) return null;
    s.lastEdit = now;
    try {
      await s.sent?.edit?.(body);
    } catch {
      // A failed edit is cosmetic; ignore it rather than break the run.
    }
    return null;
  }

  /** Removes the thinking message once the answer is on its way. */
  async processOutputResult({ state, messageList }: ProcessOutputResultArgs) {
    const s = (state as Record<string, unknown>).__think as ThinkState | undefined;
    if (!s?.sent) return messageList;
    s.done = true;
    try {
      await s.sent?.delete?.();
    } catch {
      // Already gone, or Telegram refused; not worth failing the run over.
    }
    s.sent = undefined;
    return messageList;
  }
}

/** Reasoning text from a completed result, for the fallback path. */
export function reasoningFromResult(result: unknown): string {
  const steps = (result as { steps?: unknown[] })?.steps ?? [];
  return steps
    .flatMap((step) => (Array.isArray((step as { reasoning?: unknown }).reasoning) ? ((step as { reasoning: unknown[] }).reasoning) : []))
    .map((chunk) => (chunk as { payload?: { text?: unknown } })?.payload?.text)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .join(' ');
}

export type { MastraDBMessage };
