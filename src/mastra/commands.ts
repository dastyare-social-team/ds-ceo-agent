import { storage } from './db.ts';

/**
 * Chat lifecycle commands.
 *
 * The Telegram adapter derives its memory thread deterministically from the chat
 * id, so a chat always maps to one thread and history is continuous. That is the
 * right default — you do not want to lose context mid-conversation — but it
 * means there is no way to start over from inside Telegram unless the app
 * handles it.
 *
 * `/new` therefore archives the live thread and deletes it, rather than merely
 * truncating it. The archive is a real thread in the same Postgres store under
 * `…:archive`, so the old conversation is still there and the next message
 * starts a genuinely empty thread.
 *
 * Mastra exposes `resolveThreadId` for choosing a thread id, but it only runs
 * when a thread is first created and the platform-thread mapping is persisted
 * afterwards, so it cannot re-point an existing chat. Archive-and-delete is the
 * only route that works through the documented storage API.
 */

/** Commands recognised in a direct message. */
const COMMANDS = {
  new: /^\/new\b/i,
  clear: /^\/clear\b/i,
  history: /^\/history\b/i,
} as const;

export type ChatCommand = 'new' | 'history' | null;

export function parseChatCommand(text: string | undefined | null): ChatCommand {
  const value = (text ?? '').trim();
  if (!value) return null;
  // `/clear` is an alias for `/new`: both mean "start over", and both archive
  // first, so they are deliberately not separate behaviours.
  if (COMMANDS.new.test(value) || COMMANDS.clear.test(value)) return 'new';
  if (COMMANDS.history.test(value)) return 'history';
  return null;
}

function archiveResource(resourceId: string): string {
  return `${resourceId}:archive`;
}

/** The live thread for a chat, or undefined if the chat has no history yet. */
async function findLiveThread(resourceId: string) {
  const memory = (await storage.getStore('memory'))!;
  const { threads } = await memory.listThreads({
    filter: { resourceId },
    perPage: 1,
    orderBy: { field: 'updatedAt', direction: 'DESC' },
  });
  return threads[0];
}

async function countMessages(threadId: string): Promise<number> {
  const memory = (await storage.getStore('memory'))!;
  const { messages } = await memory.listMessages({ threadId });
  return messages.length;
}

async function listArchives(resourceId: string) {
  const memory = (await storage.getStore('memory'))!;
  const { threads } = await memory.listThreads({
    filter: { resourceId: archiveResource(resourceId) },
    perPage: 5,
    orderBy: { field: 'updatedAt', direction: 'DESC' },
  });
  return threads;
}

export interface NewChatResult {
  ok: boolean;
  reply: string;
}

/**
 * Archives the current conversation and clears it, so the next message starts
 * fresh. The archive is kept, not discarded.
 */
export async function startNewChat(resourceId: string): Promise<NewChatResult> {
  const live = await findLiveThread(resourceId);
  if (!live) {
    return { ok: true, reply: 'Nothing to clear — this chat has no history yet.' };
  }

  const kept = await countMessages(live.id);
  const memory = (await storage.getStore('memory'))!;
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  await memory.copyThread({
    sourceThreadId: live.id,
    resourceId: archiveResource(resourceId),
    title: `Archived ${when}`,
    metadata: { archivedFrom: resourceId, archivedAt: new Date().toISOString() },
  });
  await memory.deleteThread({ threadId: live.id });

  return {
    ok: true,
    reply:
      `Started a new chat. The previous conversation (${kept} message${kept === 1 ? '' : 's'}) ` +
      `is archived — send /history to see past sessions.`,
  };
}

/** Reports how many archived sessions exist, without restoring them. */
export async function chatHistory(resourceId: string): Promise<NewChatResult> {
  const archives = await listArchives(resourceId);
  if (archives.length === 0) {
    return { ok: true, reply: 'No archived sessions yet. Send /new to start a fresh chat.' };
  }

  const lines: string[] = [];
  for (const t of archives) {
    const count = await countMessages(t.id);
    const when = t.updatedAt instanceof Date ? t.updatedAt : new Date(String(t.updatedAt));
    lines.push(`• ${when.toISOString().slice(0, 16).replace('T', ' ')} — ${count} message${count === 1 ? '' : 's'}`);
  }

  return {
    ok: true,
    reply: `Archived sessions (${archives.length}):\n${lines.join('\n')}\n\nThese stay in the database. /new archives the current chat and starts over.`,
  };
}
