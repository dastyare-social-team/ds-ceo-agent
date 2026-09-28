import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGuardedHandler } from '../src/mastra/guard.ts';

// The progress message, its timer, and its error reporting all live in the
// handler rather than in an output processor. That is not a stylistic choice:
// posting to Telegram while the agent run is in progress deadlocks, because the
// channel cannot deliver its own reply until the run completes and the run cannot
// complete until the post resolves. The symptom is total silence with a 200 from
// the webhook, which is what took the bot offline once already.

const ALLOWED = '8440954997';

type Sent = { text: string; deleted: boolean; edit: (m: string) => Promise<unknown> };

function fakeThread() {
  const sent: Sent[] = [];
  return {
    sent,
    async post(message: string) {
      const s: Sent = {
        text: message,
        deleted: false,
        async edit(m: string) {
          s.text = m;
          return s;
        },
      };
      (s as unknown as { delete: () => Promise<void> }).delete = async () => {
        s.deleted = true;
      };
      sent.push(s);
      return s as unknown as { edit: (m: string) => Promise<unknown> };
    },
  };
}

const message = (text: string) => ({
  text,
  author: { userId: ALLOWED },
  attachments: [],
  id: 'm1',
  threadId: 't1',
});

const logger = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };
const ctx = { mastra: { getLogger: () => logger } } as never;

function run(handler: ReturnType<typeof createGuardedHandler>, thread: ReturnType<typeof fakeThread>, msg: unknown, def: () => Promise<void>) {
  return handler(thread as never, msg as never, def as never, ctx);
}

test('a thinking message is posted before the run and removed after it', async () => {
  const thread = fakeThread();
  let ran = false;
  const handler = createGuardedHandler('dm', { preHandler: false });

  await run(handler, thread, message('hello'), async () => {
    ran = true;
    // While the run is in flight the message must be on screen.
    assert.equal(thread.sent.length, 1);
    assert.match(thread.sent[0].text, /Thinking/);
    assert.equal(thread.sent[0].deleted, false);
  });

  assert.equal(ran, true, 'the agent was actually called');
  assert.equal(thread.sent[0].deleted, true, 'and the progress message cleaned up');
});

test('an error is surfaced in the chat instead of failing silently', async () => {
  const thread = fakeThread();
  const handler = createGuardedHandler('dm', { preHandler: false });

  await run(handler, thread, message('boom'), async () => {
    throw new Error('model exploded');
  });

  assert.equal(thread.sent.length, 1);
  assert.match(thread.sent[0].text, /model exploded/);
  assert.equal(thread.sent[0].deleted, false, 'the error stays on screen');
});

test('a secret in an error message is masked before it is shown', async () => {
  const thread = fakeThread();
  const handler = createGuardedHandler('dm', { preHandler: false });

  await run(handler, thread, message('boom'), async () => {
    throw new Error('rejected key sk-abcdef0123456789 and postgres://u:p@host/db');
  });

  const shown = thread.sent[0].text;
  assert.ok(!shown.includes('sk-abcdef0123456789'), 'api key must not leak to the chat');
  assert.ok(!shown.includes('u:p@'), 'database credentials must not leak');
  assert.match(shown, /rejected key/);
});

test('a blocked sender gets the rejection notice and never a thinking message', async () => {
  const thread = fakeThread();
  const handler = createGuardedHandler('dm', { preHandler: false });
  let called = false;

  await run(handler, thread, { ...message('hi'), author: { userId: '999' } }, async () => {
    called = true;
  });

  assert.equal(called, false, 'the agent must not run');
  assert.equal(thread.sent.length, 1);
  assert.doesNotMatch(thread.sent[0].text, /Thinking/);
});

test('a command is answered without a thinking message', async () => {
  const thread = fakeThread();
  const handler = createGuardedHandler('dm', { preHandler: false });
  let called = false;

  await run(handler, thread, message('/history'), async () => {
    called = true;
  });

  assert.equal(called, false, 'commands are handled here, not by the model');
  assert.equal(thread.sent.length, 1);
  assert.doesNotMatch(thread.sent[0].text, /Thinking/);
});
