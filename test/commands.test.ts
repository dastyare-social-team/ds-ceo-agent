/**
 * Chat lifecycle command tests. Run with: npm test
 *
 * These hit the real Postgres store, because the interesting behaviour is what
 * survives in storage — an archive that reports success but copies nothing would
 * pass a mocked test and lose a real conversation. Each test uses a unique
 * resource id and removes its own threads afterwards.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { storage } from '../src/mastra/db.ts';
import { chatHistory, parseChatCommand, startNewChat } from '../src/mastra/commands.ts';

/**
 * The PG store has no `createThread` — threads are created by the channel or the
 * agent — so the fixture inserts the row directly. That keeps the test off the
 * model entirely, which matters because these assertions are about storage
 * behaviour, not generation.
 */
async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL!.replace('sslmode=require', 'sslmode=verify-full')
    .replace(/&?channel_binding=require/, '');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let seq = 0;
function scratchResource(): string {
  seq += 1;
  return `telegram:test-cmd-${Date.now()}-${seq}`;
}

async function cleanup(resourceId: string) {
  const memory = (await storage.getStore('memory'))!;
  for (const target of [resourceId, `${resourceId}:archive`]) {
    const { threads } = await memory.listThreads({ filter: { resourceId: target }, perPage: 50 });
    for (const t of threads) await memory.deleteThread({ threadId: t.id });
  }
}

/** Creates a thread row and writes messages into it. */
async function seed(resourceId: string, threadId: string, texts: string[]) {
  await withClient(async c => {
    await c.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt", "createdAtZ", "updatedAtZ")
       VALUES ($1, $2, $3, '{}'::jsonb, NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [threadId, resourceId, 'seed'],
    );
  });

  const memory = (await storage.getStore('memory'))!;
  await memory.saveMessages({
    messages: texts.map((text, i) => ({
      id: `${threadId}-${i}`,
      threadId,
      resourceId,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: { format: 2 as const, parts: [{ type: 'text' as const, text }] },
      createdAt: new Date(),
    })),
  });
  return threadId;
}

test('only exact commands are recognised, and /clear aliases /new', () => {
  assert.equal(parseChatCommand('/new'), 'new');
  assert.equal(parseChatCommand('/new '), 'new');
  assert.equal(parseChatCommand('/NEW'), 'new');
  assert.equal(parseChatCommand('/clear'), 'new');
  assert.equal(parseChatCommand('/history'), 'history');
});

test('ordinary messages are not treated as commands', () => {
  for (const text of ['hello', '', '/start', '/newer', 'new chat please', 'what does /new do?']) {
    assert.equal(parseChatCommand(text), null, `should not be a command: ${text}`);
  }
});

test('/new archives the conversation instead of discarding it', async () => {
  const resource = scratchResource();
  try {
    const threadId = await seed(resource, 't-seed', ['hello', 'hi there', 'and again']);
    const memory = (await storage.getStore('memory'))!;
    assert.equal((await memory.listMessages({ threadId })).messages.length, 3);

    const result = await startNewChat(resource);
    assert.equal(result.ok, true);
    assert.match(result.reply, /3 messages/);

    // The live thread is gone, so the next message starts genuinely empty.
    const live = await memory.listThreads({ filter: { resourceId: resource }, perPage: 5 });
    assert.equal(live.threads.length, 0, 'live thread must be deleted');

    // And the old conversation is still readable, in full.
    const archived = await memory.listThreads({
      filter: { resourceId: `${resource}:archive` },
      perPage: 5,
    });
    assert.equal(archived.threads.length, 1, 'exactly one archive');
    assert.equal((await memory.listMessages({ threadId: archived.threads[0].id })).messages.length, 3);
  } finally {
    await cleanup(resource);
  }
});

test('/history reports archived sessions and says so when there are none', async () => {
  const resource = scratchResource();
  try {
    const empty = await chatHistory(resource);
    assert.match(empty.reply, /No archived sessions/);

    await seed(resource, 't-seed', ['one', 'two']);
    await startNewChat(resource);

    const listed = await chatHistory(resource);
    assert.match(listed.reply, /Archived sessions \(1\)/);
    assert.match(listed.reply, /2 messages/);
  } finally {
    await cleanup(resource);
  }
});

test('/new on a chat with no history is harmless', async () => {
  const resource = scratchResource();
  try {
    const result = await startNewChat(resource);
    assert.equal(result.ok, true);
    assert.match(result.reply, /Nothing to clear/);
  } finally {
    await cleanup(resource);
  }
});
