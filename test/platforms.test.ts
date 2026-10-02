import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captionWarnings,
  describeTargets,
  resolveTargets,
  suggestedPlatforms,
  type ConnectedAccount,
} from '../src/mastra/media/platforms.ts';

// --- platform rules ---------------------------------------------------------

test('short video goes to the short-form platforms', () => {
  const platforms = suggestedPlatforms({ kind: 'video', seconds: 30 });
  for (const expected of ['tiktok', 'instagram', 'youtube', 'linkedin', 'telegram']) {
    assert.ok(platforms.includes(expected as never), `expected ${expected} in ${platforms.join(',')}`);
  }
});

test('long video drops TikTok, which caps clips at ten minutes', () => {
  const platforms = suggestedPlatforms({ kind: 'video', seconds: 900 });
  assert.equal(platforms.includes('tiktok' as never), false);
  assert.ok(platforms.includes('youtube' as never));
  assert.ok(platforms.includes('linkedin' as never));
});

test('exactly ten minutes is still TikTok-eligible', () => {
  // The boundary matters: the rule is "over ten minutes", not "ten minutes".
  assert.ok(suggestedPlatforms({ kind: 'video', seconds: 600 }).includes('tiktok' as never));
  assert.equal(suggestedPlatforms({ kind: 'video', seconds: 601 }).includes('tiktok' as never), false);
});

test('voice only ever goes to Telegram', () => {
  assert.deepEqual(suggestedPlatforms({ kind: 'voice', seconds: 20 }), ['telegram']);
});

test('images go to the image-friendly platforms', () => {
  const platforms = suggestedPlatforms({ kind: 'image' });
  assert.ok(platforms.includes('instagram' as never));
  assert.ok(platforms.includes('telegram' as never));
  assert.equal(platforms.includes('tiktok' as never), true);
});

test('a video with no known duration is not assumed to be long', () => {
  // Telegram sometimes reports no duration. Defaulting to "long" would silently
  // drop TikTok for a clip that is perfectly eligible.
  const platforms = suggestedPlatforms({ kind: 'video' });
  assert.ok(platforms.includes('tiktok' as never));
});

// --- intersecting with what is actually connected ---------------------------

const account = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  platform: 'instagram',
  zernioAccountId: 'acc-1',
  username: 'dastyare',
  isActive: true,
  needsReconnection: false,
  ...over,
});

test('only platforms that are both a fit and connected are offered', () => {
  const availability = resolveTargets({ kind: 'image' }, [account()]);
  assert.equal(availability.available.length, 1);
  assert.equal(availability.available[0].platform, 'instagram');
  assert.equal(availability.available[0].zernioAccountId, 'acc-1');
});

test('a suggested platform with no account is reported as missing, not offered', () => {
  const availability = resolveTargets({ kind: 'image' }, [account()]);
  assert.ok(availability.missing.includes('pinterest'));
  assert.equal(
    availability.available.some((a) => a.platform === 'pinterest'),
    false,
  );
});

test('an account needing reconnection is never offered as a target', () => {
  // Zernio rejects a dead token at publish time, so offering it wastes a round
  // trip and produces a confusing failure after the user approved.
  const availability = resolveTargets(
    { kind: 'image' },
    [account({ needsReconnection: true })],
  );
  assert.equal(availability.available.length, 0);
  assert.equal(availability.needsReconnect.length, 1);
  assert.equal(availability.needsReconnect[0].platform, 'instagram');
});

test('an inactive account is not a target', () => {
  const availability = resolveTargets({ kind: 'image' }, [account({ isActive: false })]);
  assert.equal(availability.available.length, 0);
  assert.ok(availability.missing.includes('instagram'));
});

test('two accounts on one platform are both offered, each with its own id', () => {
  // This is the case Zernio refuses to guess at, so the agent must pass an id.
  const availability = resolveTargets(
    { kind: 'image' },
    [
      account({ zernioAccountId: 'acc-a', username: 'dastyare' }),
      account({ zernioAccountId: 'acc-b', username: 'dastyare_2' }),
    ],
  );
  assert.equal(availability.available.length, 2);
  assert.deepEqual(
    availability.available.map((a) => a.zernioAccountId).sort(),
    ['acc-a', 'acc-b'],
  );
});

test('a connected platform that does not fit the asset is listed as not applicable', () => {
  const availability = resolveTargets(
    { kind: 'voice' },
    [account({ platform: 'instagram', username: 'dastyare' })],
  );
  // Voice is Telegram-only, so Instagram is healthy but not a target.
  assert.deepEqual(availability.available, []);
  assert.equal(availability.notApplicable.length, 1);
  assert.equal(availability.notApplicable[0].platform, 'instagram');
});

test('no connected accounts yields everything as missing, and says so', () => {
  const availability = resolveTargets({ kind: 'voice' }, []);
  assert.deepEqual(availability.available, []);
  assert.deepEqual(availability.missing, ['telegram']);
  assert.match(describeTargets(availability), /No connected account for: telegram/);
});

test('the summary names each account so the approval is unambiguous', () => {
  const availability = resolveTargets(
    { kind: 'video', seconds: 30 },
    [account({ platform: 'telegram', username: 'dastyare' })],
  );
  assert.match(describeTargets(availability), /telegram \(@dastyare\)/);
});

// --- caption limits ---------------------------------------------------------

test('an over-long caption is flagged per platform rather than truncated', () => {
  const warnings = captionWarnings('x'.repeat(300), ['telegram', 'x']);
  // Telegram allows 4096, X allows 280.
  assert.deepEqual(
    warnings.map((w) => w.platform).sort(),
    ['x'],
  );
  assert.equal(warnings[0].limit, 280);
});

test('a caption within every limit is not flagged', () => {
  assert.deepEqual(captionWarnings('short caption', ['telegram', 'x', 'instagram']), []);
});

test('each platform is measured against its own limit', () => {
  // 500 chars: over X's 280, under Instagram's 2200 and Telegram's 4096. Only the
  // platform it actually breaks is reported, so the user is not asked to shorten
  // a caption that three other destinations accept fine.
  const warnings = captionWarnings('y'.repeat(500), ['telegram', 'instagram', 'x']);
  assert.deepEqual(warnings.map((w) => w.platform), ['x']);
  assert.equal(warnings[0].limit, 280);
  assert.equal(warnings[0].length, 500);
});

test('a caption that breaks several platforms reports each one with its own limit', () => {
  // 3100 chars clears X (280), Instagram (2200) and LinkedIn (3000), but not
  // Telegram (4096). A caption exactly at a limit is fine, not over it.
  const warnings = captionWarnings('z'.repeat(3100), ['telegram', 'instagram', 'linkedin', 'x']);
  const byPlatform = Object.fromEntries(warnings.map((w) => [w.platform, w.limit]));
  assert.deepEqual(Object.keys(byPlatform).sort(), ['instagram', 'linkedin', 'x']);
  assert.equal(byPlatform.instagram, 2200);
  assert.equal(byPlatform.linkedin, 3000);
  assert.equal(byPlatform.x, 280);
});

test('a caption exactly at the limit is not flagged', () => {
  assert.deepEqual(captionWarnings('a'.repeat(4096), ['telegram']), []);
});