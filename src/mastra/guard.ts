import type { ChannelHandler, ChannelHandlerContext } from '@mastra/core/channels';
import { isAllowedUser, REJECTION_NOTICE } from './access.ts';
import { chatHistory, parseChatCommand, startNewChat } from './commands.ts';

/**
 * Plain text of an incoming message, or '' when it carries no text part.
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
  const parts = (message as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') out += text;
    }
  }
  return out;
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
      const command = parseChatCommand(messageText(message));
      if (command) {
        try {
          const result =
            command === 'new'
              ? await startNewChat(memoryResourceId(thread))
              : await chatHistory(memoryResourceId(thread));
          await thread.post(result.reply);
        } catch (error) {
          const logger = ctx?.mastra?.getLogger?.();
          const detail = String((error as Error)?.message ?? error);
          const line = `[commands] /${command} failed: ${detail}`;
          if (logger) logger.error(line);
          else console.error(line);
          await thread.post(`Could not run /${command}. Try again in a moment.`);
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
