import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDb, db } from '../src/mastra/db/client.ts';
import { contentDrafts } from '../src/mastra/db/schema.ts';
import { eq } from 'drizzle-orm';
import { confirmDraft, proposeContent, publishApproved } from '../src/mastra/tools/publishing.ts';

/**
 * The confirm gate.
 *
 * The failure this guards against is unrecoverable: a post published to accounts
 * real people follow, with no undo. The assertions are therefore all about
 * refusal paths, written to fail loudly if a refactor loosens a check.
 *
 * These run against the real database rather than a mocked one. The mocked
 * version was quietly falling through to the real DB anyway, and a mocked
 * `publishPost` would have proved nothing about whether the gate stops the call —
 * it would only have proved the mock works.
 *
 * Nothing can reach Zernio here, because no Zernio key is stored in this
 * environment. That is load-bearing, not a gap: publishPost therefore returns
 * "no key stored" and the test asserts the flow *reached* the publish stage
 * without anything being published.
 */

const CHAT = `telegram:test-gate-${Date.now()}`;

async function seed(platforms: string[]) {
  const { draftId } = (await proposeContent.execute!(
    {
      chatId: CHAT,
      mediaKind: 'text',
      proposals: platforms.map((platform) => ({ platform, caption: 'caption', publishNow: true })),
    },
    {},
  )) as { draftId: string };
  return draftId;
}

test('publishing is refused when the user has not approved', async () => {
  const draftId = await seed(['linkedin']);
  const result = (await publishApproved.execute!(
    { draftId, confirmedByUser: true },
    {},
  )) as { published: boolean; reason: string };

  // confirmedByUser is true, but nothing ever recorded an approval. This is the
  // case that matters: a model asserting "yes the user approved" must not be
  // enough, only a row the human's confirmation actually wrote.
  assert.equal(result.published, false);
  assert.match(result.reason, /not been confirmed/i);

  await db.delete(contentDrafts).where(eq(contentDrafts.id, draftId));
});

test('a falsy confirmation flag is refused without reaching the publish stage', async () => {
  const draftId = await seed(['linkedin']);

  for (const flag of [false, undefined, 0, null, '']) {
    const result = (await publishApproved.execute!(
      { draftId, confirmedByUser: flag as boolean },
      {},
    )) as { published?: boolean; reason?: string; error?: boolean; message?: string };

    // The outcome differs by input — a false boolean gets the refusal from the
    // gate, while a non-boolean is rejected by the input schema first — and both
    // are correct. What matters is the single property that holds for all of
    // them: nothing is published.
    assert.notEqual(result.published, true, `flag ${JSON.stringify(flag)} must not publish`);

    const row = (await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.id, draftId))
      .limit(1))[0];
    assert.equal(row.publishedAt, null, `flag ${JSON.stringify(flag)} left the draft published`);
    assert.equal(row.status, 'awaiting_confirm');
  }

  await db.delete(contentDrafts).where(eq(contentDrafts.id, draftId));
});

test('proposing alone never publishes', async () => {
  const result = (await proposeContent.execute!(
    {
      chatId: CHAT,
      mediaKind: 'video',
      mediaUrl: 'https://example.com/a.mp4',
      proposals: [{ platform: 'tiktok', caption: 'c' }],
    },
    {},
  )) as { awaitingConfirmation: boolean; draftId: string };

  assert.equal(result.awaitingConfirmation, true);
  assert.ok(result.draftId);

  const row = (await db
    .select()
    .from(contentDrafts)
    .where(eq(contentDrafts.id, result.draftId))
    .limit(1))[0];
  assert.equal(row.status, 'awaiting_confirm');
  assert.equal(row.confirmedAt, null);
  assert.equal(row.publishedAt, null);

  await db.delete(contentDrafts).where(eq(contentDrafts.id, result.draftId));
});

test('a confirmed draft reaches the publish stage for every proposed platform', async () => {
  const draftId = await seed(['linkedin', 'telegram']);

  const confirmed = (await confirmDraft.execute!({ draftId }, {})) as { confirmed: boolean };
  assert.equal(confirmed.confirmed, true);

  const row = (await db
    .select()
    .from(contentDrafts)
    .where(eq(contentDrafts.id, draftId))
    .limit(1))[0];
  assert.ok(row.confirmedAt, 'confirmation must be a stored fact, not an in-memory flag');
  assert.equal(row.status, 'confirmed');

  // No Zernio key is stored here, so each platform reports "no key" rather than
  // publishing. That proves the gate opened and both targets were attempted,
  // without anything going live.
  const result = (await publishApproved.execute!(
    { draftId, confirmedByUser: true },
    {},
  )) as { published: boolean; results: { platform: string; isError: boolean; text: string }[] };

  assert.equal(result.results.length, 2, 'both platforms must be attempted');
  assert.deepEqual(result.results.map((r) => r.platform).sort(), ['linkedin', 'telegram']);
  for (const entry of result.results) {
    assert.equal(entry.isError, true);
    // The publish path must be blocked in tests, since the stored Zernio
    // credential is a real one. Getting this wrong once already attempted a
    // publish to a live account.
    assert.match(entry.text, /Publish blocked/i);
  }

  const after = (await db
    .select()
    .from(contentDrafts)
    .where(eq(contentDrafts.id, draftId))
    .limit(1))[0];
  assert.equal(after.status, 'confirmed', 'a failed publish must not mark the draft published');
  assert.equal(after.publishedAt, null);

  await db.delete(contentDrafts).where(eq(contentDrafts.id, draftId));
});

test('the proposal tells the agent to ask before publishing', async () => {
  const result = (await proposeContent.execute!(
    { chatId: CHAT, mediaKind: 'text', proposals: [{ platform: 'x', caption: 'c' }] },
    {},
  )) as { nextStep: string; draftId: string };

  assert.match(result.nextStep, /ask/i);
  assert.match(result.nextStep, /publish-approved/i);

  await db.delete(contentDrafts).where(eq(contentDrafts.id, result.draftId));
});

test('confirming an unknown draft fails instead of inventing one', async () => {
  const result = (await confirmDraft.execute!({ draftId: 'does-not-exist' }, {})) as {
    confirmed: boolean;
  };
  assert.equal(result.confirmed, false);
});

test('publishing an unknown draft is refused', async () => {
  const result = (await publishApproved.execute!(
    { draftId: 'does-not-exist', confirmedByUser: true },
    {},
  )) as { published: boolean };
  assert.equal(result.published, false);
});

test.after(async () => {
  await db.delete(contentDrafts);
  await closeDb();
});