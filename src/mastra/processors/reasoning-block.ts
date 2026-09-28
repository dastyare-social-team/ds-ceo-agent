import type { Processor, ProcessOutputResultArgs } from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/memory';

/**
 * Character budget for the shown reasoning.
 *
 * There is no tap-to-expand behind this, so the limit is about keeping the
 * answer readable rather than hiding text — set high enough that ordinary
 * reasoning is shown in full, and only a runaway monologue is cut.
 */
const PREVIEW_LIMIT = 1000;

const LABEL = 'Thinking';

/**
 * Read the reasoning text out of a structured message part.
 *
 * Narrowed with an `in` check rather than a cast: Mastra's reasoning part is
 * `ReasoningUIPart & MastraPartExtensions`, and that intersection does not
 * reliably expose `text` to the compiler even though the value is there.
 */
function reasoningText(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return undefined;
  if ((part as { type?: unknown }).type !== 'reasoning') return undefined;
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function reasoningFromMessage(message: MastraDBMessage): string[] {
  return (message.content.parts ?? [])
    .map(reasoningText)
    .filter((t): t is string => Boolean(t));
}

/**
 * `step.reasoning` is a list of reasoning-chunk batches; each chunk carries the
 * text on `payload.text`, not directly.
 */
function reasoningFromStep(reasoning: unknown): string[] {
  if (!Array.isArray(reasoning)) return [];
  return reasoning
    .flat()
    .map((chunk) => {
      const payload = (chunk as { payload?: { text?: unknown } })?.payload;
      return typeof payload?.text === 'string' && payload.text.trim()
        ? payload.text.trim()
        : undefined;
    })
    .filter((t): t is string => Boolean(t));
}

/** `first words… (+N chars)` — signals there is more behind the block. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, PREVIEW_LIMIT).trimEnd()}… (+${flat.length - PREVIEW_LIMIT} chars)`;
}

/**
 * Renders a model's reasoning as a Telegram blockquote above the answer, so the
 * user can see the agent thought about something without it burying the reply.
 *
 * Limits worth knowing:
 *
 * - True collapsible reasoning is not reachable through this adapter, verified
 *   against its own converter:
 *     * Telegram's expandable blockquote (`<blockquote expandable>`) needs
 *       `parse_mode: HTML`. This adapter ships no HTML support at all —
 *       `toBotApiParseMode` only ever returns `MarkdownV2`.
 *     * A spoiler is the one collapsible feature MarkdownV2 does have
 *       (`||like this||`), but it is only produced by a `spoiler` AST node. Raw
 *       `||` in markdown text is escaped to `\|\|` and renders as literal
 *       characters. An output processor can only emit text, so it cannot build
 *       that node.
 *   Hence a distinct quoted section, which is the alternative to collapsing.
 * - Only models that actually emit reasoning produce a block. The free models in
 *   the chain mostly do not, so in practice this is usually invisible.
 */
export class ReasoningBlockProcessor implements Processor<'reasoning-block'> {
  readonly id = 'reasoning-block' as const;

  processOutputResult({ messages, messageList, result }: ProcessOutputResultArgs) {
    const fromSteps = (result.steps ?? []).flatMap((step) => reasoningFromStep(step.reasoning));
    const fromMessages = messages.flatMap(reasoningFromMessage);

    // Steps are the authoritative per-call reasoning. De-duplicate so a model
    // reporting the same thinking in both places does not print it twice.
    const reasoning = [...new Set([...fromSteps, ...fromMessages])].filter(Boolean);

    const last = messages.at(-1);
    if (reasoning.length === 0 || !last) return messageList;

    const body = preview(reasoning.join('\n\n'));
    const block = `> **${LABEL}**\n> ${body.split('\n').join('\n> ')}`;

    last.content.parts ??= [];
    last.content.parts.unshift({ type: 'text', text: `${block}\n\n` });
    last.content.content = `${block}\n\n${last.content.content ?? ''}`;

    return messageList;
  }
}
