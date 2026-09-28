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

export type ChatCommandName = 'new' | 'history' | 'recall';

export interface ParsedCommand {
  command: ChatCommandName;
  /** Trailing argument, trimmed. Only `/recall` uses one. */
  arg: string;
}

const COMMANDS: readonly { command: ChatCommandName; pattern: RegExp }[] = [
  { command: 'recall', pattern: /^\/recall\b\s*(.*)$/i },
  // `/clear` is an alias for `/new`: both mean "start over", and both archive
  // first, so they are deliberately not separate behaviours.
  { command: 'new', pattern: /^\/new\b/i },
  { command: 'new', pattern: /^\/clear\b/i },
  { command: 'history', pattern: /^\/history\b/i },
];

export function parseChatCommand(text: string | undefined | null): ParsedCommand | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  for (const { command, pattern } of COMMANDS) {
    const match = pattern.exec(value);
    if (!match) continue;
    // A word boundary still allows a trailing query, e.g. "/history?x".
    if (command === 'recall') return { command, arg: (match[1] ?? '').trim() };
    return { command, arg: '' };
  }
  return null;
}

function archiveResource(resourceId: string): string {
  return `${resourceId}:archive`;
}

/** Channel metadata that makes Mastra resolve a memory thread for a chat. */
const CHANNEL_METADATA_KEYS = [
  'channel_ownerId',
  'channel_platform',
  'channel_subscribed',
  'channel_externalThreadId',
  'channel_externalChannelId',
] as const;

/**
 * Pulls the channel metadata off a thread.
 *
 * The Telegram adapter finds its memory thread by `channel_externalThreadId`
 * (scoped by `channel_ownerId`), with `perPage: 1` and no explicit ordering — and
 * the PG store defaults that to newest-first, verified by inserting two threads
 * with the same external id and confirming the newer wins. So whichever thread
 * carries this metadata and was created most recently is the live one.
 *
 * `copyThread` does not propagate it, which is exactly why archives stay invisible
 * to the channel and `/new` really does reset. Reopening has to put it back.
 */
function channelMetadata(
  source: Record<string, unknown> | null | undefined,
  resourceId: string,
): Record<string, string> {
  const src = source ?? {};
  const owner = typeof src.channel_ownerId === 'string' ? src.channel_ownerId : 'ceo-agent';
  // A DM's external thread id is `telegram:<chatId>`, which is the resource id.
  // Preferring the recorded value keeps forum-topic chats working too.
  const external =
    typeof src.channel_externalThreadId === 'string' ? src.channel_externalThreadId : resourceId;
  return {
    channel_ownerId: owner,
    channel_platform: 'telegram',
    channel_subscribed: 'true',
    channel_externalThreadId: external,
    channel_externalChannelId:
      typeof src.channel_externalChannelId === 'string' ? src.channel_externalChannelId : external,
  };
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

/**
 * Copies the live thread into the archive set and deletes it, so the chat starts
 * empty next time. Returns the number of messages preserved.
 */
async function archiveLiveThread(resourceId: string): Promise<number> {
  const live = await findLiveThread(resourceId);
  if (!live) return 0;

  const memory = (await storage.getStore('memory'))!;
  const kept = await countMessages(live.id);
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  await memory.copyThread({
    sourceThreadId: live.id,
    resourceId: archiveResource(resourceId),
    title: `Archived ${when}`,
    metadata: {
      archivedFrom: resourceId,
      archivedAt: new Date().toISOString(),
    },
  });
  await memory.deleteThread({ threadId: live.id });
  return kept;
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

  const kept = await archiveLiveThread(resourceId);
  return {
    ok: true,
    reply:
      `Started a new chat. The previous conversation (${kept} message${kept === 1 ? '' : 's'}) ` +
      `is archived — send /history to see past sessions.`,
  };
}

/**
 * Reopens a previously archived session, so the agent has that conversation's
 * context again and the exchange continues from there.
 *
 * The current chat is archived first, never discarded — going back and forth
 * should not cost you either conversation.
 */
export async function recallSession(
  resourceId: string,
  rawIndex: string,
): Promise<NewChatResult> {
  if (!rawIndex) {
    const listing = await chatHistory(resourceId);
    return {
      ok: false,
      reply: `Usage: /recall <number>\n\n${listing.reply}`,
    };
  }

  const archives = await listArchives(resourceId);
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(index) || index < 1 || index > archives.length) {
    return {
      ok: false,
      reply: `There is no session ${rawIndex}. Send /history to see the numbers.`,
    };
  }

  const target = archives[index - 1];
  const memory = (await storage.getStore('memory'))!;

  // Preserve whatever is live now, so switching back later is possible.
  const preserved = await archiveLiveThread(resourceId);

  // Restore the chosen session as the live thread. copyThread does not carry the
  // channel metadata across, so it is re-applied here; without it the channel
  // would not resolve this thread and the next message would start empty.
  const restoredMessages = await countMessages(target.id);
  await memory.copyThread({
    sourceThreadId: target.id,
    resourceId,
    title: target.title ?? undefined,
    metadata: channelMetadata(target.metadata, resourceId),
  });

  const when = (target.updatedAt instanceof Date ? target.updatedAt : new Date(String(target.updatedAt)))
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');

  const extra = preserved
    ? ` The conversation you were in is archived as well (${preserved} message${preserved === 1 ? '' : 's'}).`
    : '';

  return {
    ok: true,
    reply: `Reopened session ${index} from ${when} — ${restoredMessages} message${restoredMessages === 1 ? '' : 's'} of context restored.${extra}`,
  };
}

/** Reports archived sessions, numbered so `/recall <n>` can address one. */
export async function chatHistory(resourceId: string): Promise<NewChatResult> {
  const archives = await listArchives(resourceId);
  if (archives.length === 0) {
    return { ok: true, reply: 'No archived sessions yet. Send /new to start a fresh chat.' };
  }

  const lines: string[] = [];
  for (const [i, t] of archives.entries()) {
    const count = await countMessages(t.id);
    const when = t.updatedAt instanceof Date ? t.updatedAt : new Date(String(t.updatedAt));
    lines.push(
      `${i + 1}. ${when.toISOString().slice(0, 16).replace('T', ' ')} — ${count} message${count === 1 ? '' : 's'}`,
    );
  }

  return {
    ok: true,
    reply: `Archived sessions (${archives.length}):\n${lines.join('\n')}\n\nSend /recall <number> to continue an old conversation.`,
  };
}
