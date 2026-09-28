import type { ChannelHandler, ChannelHandlerContext } from '@mastra/core/channels';
import { isAllowedUser, REJECTION_NOTICE } from './access.ts';
import { chatHistory, parseChatCommand, recallSession, startNewChat } from './commands.ts';
import { isVoiceMessage, transcribeVoice } from './voice.ts';

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
       * Voice is transcribed before the model sees it, because no free chat
       * model on the chain accepts audio. The transcript replaces the text so the
       * agent reasons over words, and the user is shown what was heard so a
       * misheard message can be corrected instead of answered wrongly.
       */
      if (isVoiceMessage(message as never)) {
        try {
          const { text: transcript, seconds } = await transcribeVoice(message as never);
          await thread.post(`🎤 Heard (local Whisper, ${Math.round(seconds)}s): ${transcript}`);
          await defaultHandler(
            thread,
            // Same message with the transcript as its text, so threading, memory
            // and the agent all behave exactly as they do for typed input.
            { ...message, text: transcript } as never,
          );
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


      await defaultHandler(thread, message);
      return;
    }

    logBlocked(ctx, kind, userId);

    if (notifySender) {
      await thread.post(REJECTION_NOTICE);
    }
  };
}
