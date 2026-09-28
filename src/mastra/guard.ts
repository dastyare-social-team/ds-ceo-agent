import type { ChannelHandler, ChannelHandlerContext } from '@mastra/core/channels';
import { isAllowedUser, REJECTION_NOTICE } from './access.ts';

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
      await defaultHandler(thread, message);
      return;
    }

    logBlocked(ctx, kind, userId);

    if (notifySender) {
      await thread.post(REJECTION_NOTICE);
    }
  };
}
