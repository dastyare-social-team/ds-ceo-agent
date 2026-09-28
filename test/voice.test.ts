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
