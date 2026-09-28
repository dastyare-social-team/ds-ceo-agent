/**
 * Access-control tests. Run with: npm test
 *
 * These exercise the guard directly rather than through Telegram's webhook.
 * Transport mode, Telegram's own retry behaviour, and whether the adapter
 * classifies a message as a DM all make synthetic-update tests unreliable —
 * the decision logic is what matters here, and this tests it exactly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedUser } from '../src/mastra/access.ts';
import { createGuardedHandler } from '../src/mastra/guard.ts';

const ALLOWED = ['2063150861', '8440954997'];
const STRANGERS = ['1112223334', '31415926535', '', '0', '20631508610', '2063150861 '];

function harness() {
  const calls = { agentRuns: 0, posts: [] as string[] };
  return {
    calls,
    thread: { post: async (m: string) => void calls.posts.push(m) },
    defaultHandler: async () => void calls.agentRuns++,
    ctx: { requestContext: {} } as never,
  };
}

const message = (userId: string | undefined) =>
  ({ author: { userId }, text: 'hello' }) as never;

test('allowlist accepts exactly the two configured accounts', () => {
  for (const id of ALLOWED) assert.equal(isAllowedUser(id), true, `${id} should be allowed`);
  for (const id of STRANGERS) assert.equal(isAllowedUser(id), false, `${id} should be blocked`);
  assert.equal(isAllowedUser(undefined), false);
  assert.equal(isAllowedUser(null), false);
});

test('direct messages: allowed users reach the agent and see progress', async () => {
  const handler = createGuardedHandler('direct message');
  for (const id of ALLOWED) {
    const h = harness();
    await handler(h.thread, message(id), h.defaultHandler, h.ctx);
    assert.equal(h.calls.agentRuns, 1, `${id} should reach the agent`);
    // One message, the transient Thinking placeholder, and no rejection notice.
    assert.equal(h.calls.posts.length, 1, `${id} should see the progress placeholder only`);
    assert.doesNotMatch(h.calls.posts[0], /not allowed|rejection/i);
  }
});

test('direct messages: strangers are blocked and told why', async () => {
  const handler = createGuardedHandler('direct message');
  for (const id of STRANGERS) {
    const h = harness();
    await handler(h.thread, message(id), h.defaultHandler, h.ctx);
    assert.equal(h.calls.agentRuns, 0, `${id} must never reach the agent`);
    assert.equal(h.calls.posts.length, 1, `${id} should be told access was denied`);
  }
});

test('subscribed threads: strangers are blocked without a group broadcast', async () => {
  const handler = createGuardedHandler('subscribed-thread message', { notifySender: false });

  const stranger = harness();
  await handler(stranger.thread, message('1112223334'), stranger.defaultHandler, stranger.ctx);
  assert.equal(stranger.calls.agentRuns, 0);
  assert.equal(stranger.calls.posts.length, 0, 'must stay quiet in a group chat');

  const allowed = harness();
  await handler(allowed.thread, message(ALLOWED[0]), allowed.defaultHandler, allowed.ctx);
  assert.equal(allowed.calls.agentRuns, 1, 'allowlisted users still work in groups');
});
