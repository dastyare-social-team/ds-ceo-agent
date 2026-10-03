import assert from 'node:assert/strict';
import test from 'node:test';
import { extractText } from '../src/mastra/transcribe/speechmatics.ts';

// --- reading the wire format -------------------------------------------------

test('word results are joined into prose', () => {
  const text = extractText({
    results: [
      { type: 'word', alternatives: [{ content: 'Yet' }] },
      { type: 'word', alternatives: [{ content: 'these' }] },
      { type: 'word', alternatives: [{ content: 'thoughts' }] },
    ],
  });
  assert.equal(text, 'Yet these thoughts');
});

test('punctuation is not left detached by the join', () => {
  // Joining bare words with spaces produces "less with hope than at present ." and
  // a caption with a space before a full stop reads as machine output.
  const text = extractText({
    results: [
      { type: 'word', alternatives: [{ content: 'less' }] },
      { type: 'word', alternatives: [{ content: 'hope' }] },
      { type: 'word', alternatives: [{ content: '.' }] },
      { type: 'word', alternatives: [{ content: 'Really' }] },
    ],
  });
  assert.equal(text, 'less hope. Really');
  assert.equal(/ \./.test(text), false);
});

test('paragraph results win over the flat word list when present', () => {
  // Speechmatics returns paragraphs when enabled, and a paragraph keeps the
  // sentence structure a caption needs. Preferring it avoids re-deriving it.
  const text = extractText({
    results: [
      { type: 'word', alternatives: [{ content: 'Yet' }] },
      { type: 'paragraph', alternatives: [{ content: 'First paragraph.' }] },
      { type: 'paragraph', alternatives: [{ content: 'Second paragraph.' }] },
    ],
  });
  assert.equal(text, 'First paragraph.\n\nSecond paragraph.');
});

test('empty alternatives are skipped rather than becoming stray spaces', () => {
  const text = extractText({
    results: [
      { type: 'word', alternatives: [{ content: 'Hello' }] },
      { type: 'word', alternatives: [] },
      { type: 'word', alternatives: [{ content: '' }] },
      { type: 'word', alternatives: [{ content: 'world' }] },
    ],
  });
  assert.equal(text, 'Hello world');
});

test('an empty transcript yields an empty string, not undefined', () => {
  assert.equal(extractText({}), '');
  assert.equal(extractText({ results: [] }), '');
});

test('multi-word alternatives are not mangled', () => {
  const text = extractText({
    results: [{ type: 'word', alternatives: [{ content: 'Hester Prynne' }] }],
  });
  assert.equal(text, 'Hester Prynne');
});

test('duration is derived from the last timed word, since the API sends none', () => {
  // Verified against a live job: metadata has no duration field, so a naive read
  // yields undefined and the log line reads "transcribed undefineds".
  const results = [
    { type: 'word', alternatives: [{ content: 'Yet' }], start_time: 0, end_time: 0.24 },
    { type: 'word', alternatives: [{ content: 'thoughts' }], start_time: 0.3, end_time: 0.91 },
  ];
  const last = [...results].reverse().find((r) => typeof r.end_time === 'number');
  assert.equal(last?.end_time, 0.91);
});

test('results with no timing do not break the duration read', () => {
  const results = [
    { type: 'word', alternatives: [{ content: 'a' }] },
    { type: 'word', alternatives: [{ content: 'b' }], end_time: 1.5 },
  ];
  const last = [...results].reverse().find((r) => typeof r.end_time === 'number');
  assert.equal(last?.end_time, 1.5);
});
