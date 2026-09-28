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
import { chatHistory, parseChatCommand, recallSession, startNewChat } from '../src/mastra/commands.ts';

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
/** What the Telegram adapter writes onto the live thread. */
function channelMetadata(resourceId: string) {
  return {
    channel_ownerId: 'ceo-agent',
    channel_platform: 'telegram',
    channel_subscribed: 'true',
    channel_externalThreadId: resourceId,
    channel_externalChannelId: resourceId,
  };
}

async function seed(
  resourceId: string,
  threadId: string,
  texts: string[],
  opts: { title?: string; externalId?: string; age?: string } = {},
) {
  const meta = opts.externalId ? channelMetadata(opts.externalId) : {};
  // "age" shifts the timestamps so newest-first ordering is deterministic.
  const age = opts.age ?? null;
  const at = age ? '$5::timestamptz' : 'NOW()';
  await withClient(async c => {
    await c.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt", "createdAtZ", "updatedAtZ")
       VALUES ($1, $2, $3, $4::jsonb, ${at}, ${at}, ${at}, ${at})
       ON CONFLICT (id) DO NOTHING`,
      age === null
        ? [threadId, resourceId, opts.title ?? 'seed', JSON.stringify(meta)]
        : [threadId, resourceId, opts.title ?? 'seed', JSON.stringify(meta), age],
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
  assert.deepEqual(parseChatCommand('/new'), { command: 'new', arg: '' });
  assert.deepEqual(parseChatCommand('/new '), { command: 'new', arg: '' });
  assert.deepEqual(parseChatCommand('/NEW'), { command: 'new', arg: '' });
  assert.deepEqual(parseChatCommand('/clear'), { command: 'new', arg: '' });
  assert.deepEqual(parseChatCommand('/history'), { command: 'history', arg: '' });
});

test('/recall carries its session number', () => {
  assert.deepEqual(parseChatCommand('/recall 2'), { command: 'recall', arg: '2' });
  assert.deepEqual(parseChatCommand('/recall  12  '), { command: 'recall', arg: '12' });
  assert.deepEqual(parseChatCommand('/recall'), { command: 'recall', arg: '' });
  assert.equal(parseChatCommand('/recallable'), null);
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

/** How the Telegram adapter finds its memory thread, reproduced from Mastra. */
async function resolveLiveThread(resourceId: string) {
  const memory = (await storage.getStore('memory'))!;
  const { threads } = await memory.listThreads({
    filter: { metadata: { channel_externalThreadId: resourceId, channel_ownerId: 'ceo-agent' } },
    perPage: 1,
  });
  return threads[0] ?? null;
}

test('archives stay invisible to the channel, so /new really resets context', async () => {
  const resource = scratchResource();
  try {
    await seed(resource, 't-live', ['secret earlier context'], { externalId: resource });
    assert.ok(await resolveLiveThread(resource), 'channel must see the live thread');

    await startNewChat(resource);

    assert.equal(
      await resolveLiveThread(resource),
      null,
      'no thread may resolve after /new, or the old context would come back',
    );
  } finally {
    await cleanup(resource);
  }
});

test('/recall restores an archived session as the live thread', async () => {
  const resource = scratchResource();
  try {
    // Session 1, then /new, then a different session 2.
    await seed(resource, 't-one', ['ALPHA context'], { externalId: resource, age: '2026-01-01T10:00:00Z' });
    await startNewChat(resource);
    await seed(resource, 't-two', ['BETA context'], { externalId: resource });

    assert.match(
      JSON.stringify(await (await (await storage.getStore('memory'))!).listMessages({ threadId: (await resolveLiveThread(resource))!.id })),
      /BETA context/,
      'session 2 should be live',
    );

    const recalled = await recallSession(resource, '1');
    assert.equal(recalled.ok, true);
    assert.match(recalled.reply, /Reopened session 1/);

    const live = await resolveLiveThread(resource);
    assert.ok(live, 'the restored thread must be resolvable by the channel');
    const messages = await (await storage.getStore('memory'))!.listMessages({ threadId: live.id });
    assert.match(
      JSON.stringify(messages.messages),
      /ALPHA context/,
      'the agent must have the old context again',
    );
  } finally {
    await cleanup(resource);
  }
});

test('/recall archives what was live rather than discarding it', async () => {
  const resource = scratchResource();
  try {
    await seed(resource, 't-one', ['ALPHA'], { externalId: resource, age: '2026-01-01T10:00:00Z' });
    await startNewChat(resource);
    await seed(resource, 't-two', ['BETA'], { externalId: resource });

    const recalled = await recallSession(resource, '1');
    assert.match(recalled.reply, /archived as well/, 'BETA must be kept');

    const memory = (await storage.getStore('memory'))!;
    const { threads } = await memory.listThreads({
      filter: { resourceId: `${resource}:archive` },
      perPage: 50,
    });
    const all = JSON.stringify(
      await Promise.all(threads.map(async t => (await memory.listMessages({ threadId: t.id })).messages)),
    );
    assert.match(all, /BETA/, 'the conversation we left must still exist');
  } finally {
    await cleanup(resource);
  }
});

test('/recall rejects a session number that does not exist', async () => {
  const resource = scratchResource();
  try {
    await seed(resource, 't-one', ['ALPHA'], { externalId: resource });
    await startNewChat(resource);

    for (const bad of ['9', '0', '-1', 'abc']) {
      const result = await recallSession(resource, bad);
      assert.equal(result.ok, false, `${bad} should be rejected`);
      assert.match(result.reply, /no session 9|Send \/history/);
    }

    const noArg = await recallSession(resource, '');
    assert.match(noArg.reply, /Usage: \/recall <number>/);
  } finally {
    await cleanup(resource);
  }
});
