import type { ChannelHandler, ChannelHandlerContext } from '@mastra/core/channels';
import { isAllowedUser, REJECTION_NOTICE } from './access.ts';
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  approvalCard,
  pendingDraftFor,
  rejectDraft,
  summariseDraft,
} from './approve.ts';
import {
  chatHistory,
  parseChatCommand,
  recallSession,
  startNewChat,
  transcribeFromUrl,
} from './commands.ts';
import type { SentMessageLike } from './processors/progress-types.ts';
import { isVoiceMessage, transcribeVoice, withTranscript } from './voice.ts';
import {
  describeInboundMedia,
  isMediaMessage,
  publishInboundMedia,
  withMediaSummary,
} from './media/inbound.ts';

/**
 * Plain text of an incoming message.
 *
 * The channel `Message` carries text on a top-level `text` property. It has no
 * `content.parts` — that shape belongs to Mastra's *stored* messages, not to the
 * object a channel handler receives. Reading the wrong one returned '' for every
 * message, so every command silently fell through to the model.
 *
 * The stored-message shape is kept as a fallback, since a text part is the other
 * plausible place text can live.
 */
/**
 * Memory resource for a channel thread.
 *
 * The Telegram adapter encodes a DM thread as `telegram:<chatId>`, which is also the
 * memory resourceId Mastra assigns to that chat, so the platform thread id is the
 * resource. Verified against the store: a DM for user 8440954997 lands under
 * resourceId `telegram:8440954997`, and that is the platform thread id too.
 */
function memoryResourceId(thread: { id: string }): string {
  return thread.id;
}

function messageText(message: unknown): string {
  const msg = message as { text?: unknown; content?: { parts?: unknown; content?: unknown } };

  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text;

  const parts = msg.content?.parts;
  if (Array.isArray(parts)) {
    let out = '';
    for (const part of parts) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') out += text;
      }
    }
    if (out.trim()) return out;
  }

  const raw = msg.content?.content;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Records a blocked message.
 *
 * Falls back to console when the Mastra logger is absent on the context: a
 * silent access-control decision is indistinguishable from a bot that simply is
 * not responding, which is a miserable thing to debug at 2am.
 */
function logBlocked(ctx: ChannelHandlerContext, kind: string, userId?: string) {
  const line = `[access] Blocked ${kind} from unauthorised Telegram user ${userId ?? 'unknown'}`;
  const logger = ctx?.mastra?.getLogger?.();
  if (logger) logger.warn(line);
  else console.warn(line);
}

export interface GuardOptions {
  /**
   * Whether to tell the sender they were turned away. Defaults to true.
   *
   * Off for subscribed-thread messages: in a group, replying "access denied" to
   * one person broadcasts it to everyone in the chat, which draws attention to
   * the bot's existence and confirms the account exists. Staying quiet is the
   * better behaviour there.
   */
  notifySender?: boolean;
}

/**
 * Wraps a channel handler so the agent only ever runs for allowlisted Telegram
 * users. Rejected messages never reach the model, the tools, or storage.
 *
 * Extracted from the agent config so it can be tested directly, without
 * depending on Telegram transport mode or a live webhook.
 */
const THINKING_LABEL = '🧠 Thinking';
/** Listed when an unrecognised slash command arrives. */
const KNOWN_COMMANDS = ['/new', '/clear', '/history', '/recall <n>', '/transcribe <url>'];
const THINKING_TICK_MS = 5_000;

/**
 * Telegram messages are 4096 characters and a wall of text is worse than none, so
 * the reason is trimmed. Secrets are the other risk: provider errors sometimes
 * echo a key or a connection string back, so those are masked before it reaches
 * a chat that more than the two of us can read.
 */
function errorDetail(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error);
  const redacted = raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(/(postgres(?:ql)?|rediss?):\/\/[^\s@]+@/gi, '$1://***@');
  const single = redacted.replace(/\s+/g, ' ').trim() || 'unknown error';
  return single.length > 300 ? `${single.slice(0, 300)}\u2026` : single;
}

export function createGuardedHandler(
  kind: string,
  options: GuardOptions = {},
): ChannelHandler {
  const { notifySender = true } = options;

  return async (thread, message, defaultHandler, ctx) => {
    const userId = message.author?.userId;

    if (isAllowedUser(userId)) {
      /**
       * Lifecycle commands are handled here rather than sent to the model, so
       * `/new` cannot be answered with prose while the thread stays full, and so
       * the command itself never becomes part of the conversation history.
       */
      const parsed = parseChatCommand(messageText(message));
      if (parsed) {
        const { command, arg } = parsed;
        try {
          const result =
            command === 'new'
              ? await startNewChat(memoryResourceId(thread))
              : command === 'recall'
                ? await recallSession(memoryResourceId(thread), arg)
                : command === 'transcribe'
                  ? await transcribeFromUrl(arg)
                  : await chatHistory(memoryResourceId(thread));
          await thread.post(result.reply);
        } catch (error) {
          const logger = ctx?.mastra?.getLogger?.();
          const detail = String((error as Error)?.message ?? error);
          const line = `[commands] ${command} failed: ${detail}`;
          if (logger) logger.error(line);
          else console.error(line);
          await thread.post(`Could not run /${command}. Try again in a moment.`);
        }
        return;
      }

      /**
       * A slash command the bot does not recognise is reported as unknown rather
       * than passed to the model.
       *
       * This cost a whole diagnostic cycle: `/transcribe <url>` was sent while the
       * build carrying it had not deployed, so it fell through as ordinary text.
       * The model read the URL, reached for its web tools, failed on a binary file,
       * and concluded — reasonably, from its own point of view — that no
       * transcription capability existed. The real cause was a deployment lag that
       * nothing in the reply could have revealed.
       *
       * An unknown command is the one case where the model is the wrong responder
       * by definition: it has no way to know which commands this bot implements.
       */
      const raw = messageText(message).trim();
      if (raw.startsWith('/')) {
        await thread.post(
          `Unknown command. Available: ${KNOWN_COMMANDS.join(', ')}`,
        );
        return;
      }

      /**
       * Video, image and document attachments are uploaded to storage and handed
       * to the model as a URL plus an explicit statement that it cannot see them.
       *
       * Without this a video arrived as an "[Attached file: IMG_2515.MP4]"
       * placeholder and a text-only model responded by inventing platforms and
       * engagement statistics about them. A model cannot decline what it believes
       * it can see, so the fix is to tell it plainly that it cannot.
       *
       * Audio is deliberately not handled here: voice is transcribed, and that path
       * is below.
       */
      if (isMediaMessage(message as never)) {
        try {
          const media = await publishInboundMedia(message as never);
          await thread.post(
            `**uploaded — ** ${media.kind}, ${(media.bytes / 1024 / 1024).toFixed(1)}MB`,
          );
          ctx?.mastra?.getLogger?.().debug?.(`[media] uploaded ${media.kind} to ${media.url}`);

          /**
           * Video is transcribed here rather than asked about, because "describe
           * the video" is a question the user should never have to answer twice.
           *
           * A failure is reported to the user rather than swallowed. It used to
           * degrade silently into "you cannot see this file, ask the user", which
           * made an API failure indistinguishable from a design decision: the bot
           * said it had no transcription tool when the truth was that the tool
           * ran and the call failed. Saying which it was is the difference between
           * a fixable problem and a dead end.
           */
          let transcript: string | null = null;
          if (media.kind === 'video') {
            const attempt = await transcribeVideoFor(message as never, media, ctx);
            transcript = attempt.transcript;
            if (!transcript && attempt.reason) {
              await thread.post(`**transcription failed — ** ${attempt.reason}`);
            }
          }

          await defaultHandler(
            thread,
            withMediaSummary(
              message,
              transcript
                ? `${describeInboundMedia(media)}\n\nTranscript of what the video says:\n"""\n${transcript}\n"""`
                : describeInboundMedia(media),
              media.kind,
            ) as never,
          );
        } catch (error) {
          const detail = errorDetail(error);
          ctx?.mastra?.getLogger?.().error(`[media] upload failed: ${detail}`);
          await thread.post(`Could not upload that file. ${detail}`);
        }
        return;
      }

      /**
       * Voice is transcribed before the model sees it, because no free chat model
       * on the chain accepts audio. The transcript is shown to the user so a
       * misheard message can be corrected rather than answered wrongly.
       *
       * The audio is stripped before the model is called. A text-only model given
       * "[Attached file: file (audio/ogg)]" alongside real words does the only
       * sensible thing and refuses, and worse, that placeholder is written into
       * memory, so the refusal repeats on later turns that are pure text until
       * the row is cleaned. See scripts/clean-voice-history.mjs.
       */
      if (isVoiceMessage(message as never)) {
        try {
          const { text: transcript, seconds } = await transcribeVoice(message as never);
          // Posted as an object, not a string: the Telegram adapter only applies
          // MarkdownV2 to an object with a `markdown` key. A bare string is sent
          // verbatim in "plain" mode, so ** would arrive as literal asterisks.
          await thread.post({ markdown: `**you said — ** ${transcript}` });
          ctx?.mastra?.getLogger?.().debug?.(`[voice] transcribed ${Math.round(seconds)}s of audio`);

          // The transcript as plain text with every attachment stripped. The
          // message the model finally sees is indistinguishable from a typed one.
          await defaultHandler(thread, withTranscript(message, transcript) as never);
        } catch (error) {
          const detail = String((error as Error)?.message ?? error);
          const logger = ctx?.mastra?.getLogger?.();
          const line = `[voice] transcription failed: ${detail}`;
          if (logger) logger.error(line);
          else console.error(line);
          await thread.post(`Could not transcribe that voice message. ${detail}`);
        }
        return;
      }


      /**
       * Progress is shown from here, in the handler, rather than from an output
       * processor inside the run. That placement is the whole point: posting to
       * Telegram while the agent is running deadlocks, because the channel cannot
       * deliver its own reply until the run finishes and the run cannot finish
       * until the post resolves. From out here the same I/O is safe, and the run
       * is still in progress for the timer to report against.
       */
      const started = Date.now();
      const status = await thread.post(`${THINKING_LABEL}…`);
      const tick = setInterval(() => {
        const seconds = Math.round((Date.now() - started) / 1000);
        // Not awaited: this fires on a timer while the run owns the channel.
        void status.edit?.(`${THINKING_LABEL}… ${seconds}s`).catch(() => undefined);
      }, THINKING_TICK_MS);

      let failed: unknown;
      try {
        await defaultHandler(thread, message);
      } catch (error) {
        failed = error;
      } finally {
        clearInterval(tick);
      }

      if (failed !== undefined) {
        // Leave the message up, rewritten as the error, so the failure is
        // visible rather than looking like the agent ignored the request.
        const detail = errorDetail(failed);
        ctx?.mastra?.getLogger?.().error(`[agent] run failed: ${detail}`);
        try {
          await status.edit?.(`❌ ${detail}`);
        } catch {
          await thread.post(`❌ ${detail}`).catch(() => undefined);
        }
        return;
      }

      try {
        await status?.delete?.();
      } catch {
        // The channel may refuse or the message may already be gone.
      }

      /**
       * If the agent left a proposal waiting, offer it as buttons.
       *
       * Posted after the reply rather than before it, so the card appears under
       * the explanation of what is being published. Tapping Approve is a discrete
       * event carrying the draft id, which is a far stronger signal than parsing
       * free text for a confirmation — and it is the same confirmed_at write, so
       * the gate in publish-approved is unchanged.
       */
      try {
        const pending = await pendingDraftFor(memoryResourceId(thread));
        if (pending) {
          await thread.post(approvalCard(pending.id, summariseDraft(pending.proposals)));
        }
      } catch (error) {
        // Never fail a reply because the card could not be attached. The user can
        // still approve in words, and publish-approved still requires confirmation.
        ctx?.mastra?.getLogger?.().warn(`[approve] could not post card: ${String(error)}`);
      }
      return;
    }

    logBlocked(ctx, kind, userId);

    if (notifySender) {
      await thread.post(REJECTION_NOTICE);
    }
  };
}

/**
 * Handles a button tap.
 *
 * Mastra routes inline-keyboard presses here through the channel's `onAction`, so
 * an approval is a discrete event carrying the id of the exact draft it applies
 * to, rather than a phrase in free text that has to be interpreted.
 *
 * The allowlist is checked here for the same reason as on messages: a card posted
 * into a group stays there, and anyone who can see the buttons must not be able to
 * approve someone else's post.
 */
interface ActionEvent {
  actionId: string;
  value?: string;
  threadId?: string;
  thread?: {
    author?: { userId?: string | number };
    post?: (message: unknown) => Promise<unknown>;
  } | null;
}

export function createGuardedActionHandler() {
  return async (event: unknown, defaultHandler: () => Promise<void>) => {
    const { actionId, value, thread } = event as ActionEvent;
    const userId = thread?.author?.userId;
    if (!isAllowedUser(userId)) {
      logBlocked('button action' as never, 'unauthorised telegram user', userId === undefined ? undefined : String(userId));
      return;
    }

    const draftId = value;
    if (!draftId) {
      // Not one of our cards, or the payload was lost. Let the default handler
      // deal with it rather than silently doing nothing.
      await defaultHandler();
      return;
    }

    if (actionId === REJECT_ACTION) {
      const rejected = await rejectDraft(draftId);
      await thread?.post?.(
        rejected ? 'Cancelled. Nothing was published.' : 'That draft is no longer pending.',
      );
      return;
    }

    if (actionId === APPROVE_ACTION) {
      await thread?.post?.(await publishApprovedFor(draftId));
      return;
    }

    await defaultHandler();
  };
}

/** Confirms then publishes, reporting what happened in one message. */
async function publishApprovedFor(draftId: string): Promise<string> {
  const { confirmDraft, publishApproved } = await import('./tools/publishing.ts');
  const ctx = {} as never;
  const confirmed = (await confirmDraft.execute!({ draftId }, ctx)) as { confirmed: boolean };
  if (!confirmed.confirmed) return 'This draft is no longer pending, so nothing was published.';

  const outcome = (await publishApproved.execute!({ draftId, confirmedByUser: true }, ctx)) as {
    published: boolean;
    results?: { platform: string; text: string; isError: boolean }[];
  };

  if (outcome.published) return 'Published.';

  const failures = (outcome.results ?? [])
    .filter((r) => r.isError)
    .map((r) => `${r.platform}: ${r.text}`)
    .join('\n');
  return `Not published.\n${failures || 'No detail was returned by Zernio.'}`;
}

/**
 * Transcribes an uploaded video.
 *
 * Returns the transcript, or null plus a reason the user can act on. Never throws:
 * a video that cannot be transcribed is still publishable, so failing the whole
 * message over a caption would be a worse outcome than telling the user what went
 * wrong.
 */
async function transcribeVideoFor(
  message: unknown,
  media: { kind: string; fileName: string | null },
  ctx: unknown,
): Promise<{ transcript: string | null; reason?: string }> {
  const logger = (
    ctx as {
      mastra?: {
        getLogger?: () => {
          debug?: (m: string) => void;
          warn?: (m: string) => void;
        };
      };
    }
  )?.mastra?.getLogger?.();

  try {
    const { audioBytesOf } = await import('./media/inbound.ts');
    const { transcribeMedia } = await import('./transcribe/speechmatics.ts');

    const outcome = await transcribeMedia(await audioBytesOf(message), {
      kind: media.kind,
      fileName: media.fileName,
    });

    if (outcome.ok && outcome.transcript) {
      logger?.debug?.(
        `[media] transcribed ${outcome.transcript.durationSeconds ?? '?'}s of video`,
      );
      return { transcript: outcome.transcript.text };
    }

    // Either still processing or refused. Reported rather than swallowed, because
    // silence here is indistinguishable from the model ignoring the video.
    logger?.warn?.(`[media] transcript unavailable: ${outcome.message}`);
    return { transcript: null, reason: outcome.message };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    logger?.warn?.(`[media] transcription failed: ${reason}`);
    return { transcript: null, reason };
  }
}
