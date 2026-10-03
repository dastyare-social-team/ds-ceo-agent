import assert from 'node:assert/strict';
import test from 'node:test';
import { needsCompression, TRIGGER_BYTES, TARGET_BYTES } from '../src/mastra/media/compress.ts';

// Compression is exercised against a real encode in the manual verification; these
// pin the decision logic, which is where a wrong answer costs an upload.

test('a small file is passed through untouched', () => {
  // Re-encoding something that was never going to fail costs time and quality for
  // nothing, and degrades a perfectly good upload.
  assert.equal(needsCompression(5 * 1024 * 1024), false);
  assert.equal(needsCompression(TRIGGER_BYTES), false);
});

test('a file above the trigger is compressed', () => {
  assert.equal(needsCompression(TRIGGER_BYTES + 1), true);
});

test('the target sits below the trigger, so one pass has headroom', () => {
  // The target is not the same number as the trigger on purpose: a single encode
  // does not reliably land on an exact byte count, so the target leaves margin
  // under the ceiling.
  assert.ok(TARGET_BYTES < TRIGGER_BYTES);
  assert.equal(needsCompression(TARGET_BYTES), false);
});
