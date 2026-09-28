import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoiceMessage, transcribeVoice } from '../src/mastra/voice.ts';

const voice = (extra: Record<string, unknown> = {}) => ({
  text: '',
  attachments: [{ type: 'audio', fetchData: async () => new Uint8Array([1, 2, 3]) }],
  ...extra,
});

test('a bare voice message is a voice message', () => {
  assert.equal(isVoiceMessage(voice()), true);
});

test('a caption wins over transcription, since the text is already the message', () => {
  assert.equal(isVoiceMessage(voice({ text: 'what does this mean' })), false);
});

test('plain text and non-audio attachments are not voice', () => {
  assert.equal(isVoiceMessage({ text: 'hello', attachments: [] }), false);
  assert.equal(
    isVoiceMessage({ text: '', attachments: [{ type: 'image', fetchData: async () => new Uint8Array() }] }),
    false,
  );
});

test('an empty audio payload is reported, not silently transcribed', async () => {
  await assert.rejects(
    transcribeVoice({ text: '', attachments: [{ type: 'audio', fetchData: async () => new Uint8Array(0) }] }),
    /empty/i,
  );
});

test('a missing audio attachment is reported clearly', async () => {
  await assert.rejects(transcribeVoice({ text: '' }), /no audio attachment/i);
});

test('garbage bytes fail with a decode error rather than a crash', async () => {
  await assert.rejects(
    transcribeVoice({
      text: '',
      attachments: [{ type: 'audio', fetchData: async () => new Uint8Array(512).fill(9) }],
    }),
  );
});

// --- deployment config guard ------------------------------------------------
// Vercel rejects an unknown top-level key in vercel.json, and a rejected config
// fails the deploy before any code runs. `excludeFiles` only exists per-function
// and must be a string, so both mistakes are locked out here. (These came from a
// real failed deploy; the full schema check needs network, so this is the
// offline subset that actually went wrong.)

test('vercel.json has no top-level excludeFiles, which the schema rejects', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal('excludeFiles' in config, false);
  assert.equal('includeFiles' in config, false);
});

test('vercel.json function options use the shapes Vercel accepts', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const [path, options] of Object.entries(config.functions ?? {})) {
    for (const [key, value] of Object.entries(options)) {
      if (key === 'excludeFiles' || key === 'includeFiles') {
        assert.equal(typeof value, 'string', `functions."${path}".${key} must be a glob string`);
        assert.ok(value.length <= 256, `functions."${path}".${key} exceeds the 256 char limit`);
      }
      if (key === 'memory') assert.ok(value >= 128 && value <= 10240, `${path} memory out of range`);
      if (key === 'maxDuration') assert.equal(typeof value, 'number');
    }
  }
});

test('the native ONNX build for other platforms is pruned, not all of them', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const excluded = Object.values(config.functions ?? {}).map((o) => o.excludeFiles ?? '').join(',');
  assert.match(excluded, /darwin/, 'darwin binaries are the largest and are not needed on Vercel');
  assert.match(excluded, /win32/);
  assert.equal(/linux/.test(excluded), false, 'linux is the platform Vercel runs, so it must survive');
});
