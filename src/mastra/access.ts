import { env } from './env.ts';

/**
 * Telegram user IDs permitted to talk to this bot. Everyone else is turned
 * away before the agent runs, so an unauthorised message never reaches the
 * model, the tools, or storage.
 */
const DEFAULT_ALLOWED_USER_IDS = ['2063150861', '8440954997'];

const allowedUserIds = new Set(
  (env('TELEGRAM_ALLOWED_USER_IDS') ?? DEFAULT_ALLOWED_USER_IDS.join(','))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

export function isAllowedUser(userId: string | number | undefined | null): boolean {
  if (userId === undefined || userId === null) return false;
  return allowedUserIds.has(String(userId));
}

export const REJECTION_NOTICE =
  'Access denied. This bot is private and only authorised accounts can use it.';

export function allowedUserIdList(): string[] {
  return [...allowedUserIds];
}
