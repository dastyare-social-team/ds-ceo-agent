import assert from 'node:assert/strict';
import test from 'node:test';
import { isVoiceMessage, providerLabel, transcribeVoice, withTranscript } from '../src/mastra/voice.ts';

const voice = (extra: Record<string, unknown> = {}) => ({
  text: '',
  attachments: [{ type: 'audio', fetchData: async () => new Uint8Array([1, 2, 3]) }],
  ...extra,
});

// Provider routing is read from the environment on every call, and the hosted
// path talks to the network, so both are stubbed here rather than reached for
// real. The garbage-bytes case still exercises the genuine local decoder.

type Env = Record<string, string | undefined>;

async function withEnv(vars: Env, run: () => Promise<void>): Promise<void> {
  const saved: Env = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetch(response: () => Response, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

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
  // Pinned to local so this really runs the Opus decoder instead of posting the
  // junk to a hosted endpoint.
  await withEnv({ TRANSCRIBE_PROVIDER: 'local' }, async () => {
    await assert.rejects(
      transcribeVoice({
        text: '',
        attachments: [{ type: 'audio', fetchData: async () => new Uint8Array(512).fill(9) }],
      }),
    );
  });
});

// --- hosted transcription ---------------------------------------------------

test('a hosted transcript carries its duration and the engine that produced it', async () => {
  await withEnv({ GROQ_API_KEY: 'gsk_test', TRANSCRIBE_PROVIDER: 'groq' }, () =>
    withFetch(
      () => new Response(JSON.stringify({ text: 'ship it', duration: 4.25 }), { status: 200 }),
      async () => {
        const result = await transcribeVoice(voice());
        assert.equal(result.text, 'ship it');
        assert.equal(result.seconds, 4.25);
        assert.equal(result.provider, 'groq');
      },
    ),
  );
});

test('the API key is masked when a hosted error would otherwise echo it', async () => {
  // This is the whole reason redact() exists: the error text is posted to
  // Telegram, so an echoed key would be published to the chat.
  const key = 'gsk_supersecretvalue123';
  await withEnv({ GROQ_API_KEY: key, TRANSCRIBE_PROVIDER: 'groq' }, () =>
    withFetch(
      () => new Response(JSON.stringify({ error: { message: `invalid key ${key}` } }), { status: 401 }),
      async () => {
        const error = await transcribeVoice(voice()).then(() => null, (e: Error) => e);
        assert.ok(error, 'expected a rejection');
        assert.match(error.message, /401/);
        assert.ok(!error.message.includes(key), 'the key leaked into the error');
        assert.match(error.message, /gsk_\*\*\*/, 'the key should be masked, not merely dropped');
      },
    ),
  );
});

test('a transport error carrying a bearer token is masked as well', async () => {
  await withEnv({ GROQ_API_KEY: 'gsk_transporterror999', TRANSCRIBE_PROVIDER: 'groq' }, () =>
    withFetch(
      () => {
        throw new Error('socket closed while sending Bearer gsk_transporterror999');
      },
      async () => {
        const error = await transcribeVoice(voice()).then(() => null, (e: Error) => e);
        assert.ok(error, 'expected a rejection');
        assert.match(error.message, /Could not reach Groq/);
        assert.ok(!error.message.includes('gsk_transporterror999'), 'the bearer token leaked');
      },
    ),
  );
});

test('a non-JSON hosted body is reported without being trusted', async () => {
  await withEnv({ GROQ_API_KEY: 'gsk_test', TRANSCRIBE_PROVIDER: 'groq' }, () =>
    withFetch(() => new Response('<html>gateway</html>', { status: 200 }), async () => {
      await assert.rejects(transcribeVoice(voice()), /not JSON/i);
    }),
  );
});

test('a 200 with no transcript field is an error, not an empty message', async () => {
  await withEnv({ GROQ_API_KEY: 'gsk_test', TRANSCRIBE_PROVIDER: 'groq' }, () =>
    withFetch(() => new Response(JSON.stringify({ duration: 1 }), { status: 200 }), async () => {
      await assert.rejects(transcribeVoice(voice()), /no transcript/i);
    }),
  );
});

test('asking for groq without a key fails loudly instead of silently going local', async () => {
  await withEnv({ GROQ_API_KEY: undefined, TRANSCRIBE_PROVIDER: 'groq' }, async () => {
    await assert.rejects(transcribeVoice(voice()), /GROQ_API_KEY is empty/);
  });
});

test('auto reaches for the network only when a key is configured', async () => {
  let calls = 0;
  const counting = () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ text: 'ok', duration: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  };

  const withKey = counting();
  await withEnv({ GROQ_API_KEY: 'gsk_x', TRANSCRIBE_PROVIDER: 'auto' }, async () => {
    const result = await transcribeVoice(voice());
    assert.equal(result.provider, 'groq');
  });
  withKey();
  assert.equal(calls, 1, 'a key should produce exactly one hosted call');

  calls = 0;
  const withoutKey = counting();
  await withEnv({ GROQ_API_KEY: undefined, TRANSCRIBE_PROVIDER: 'auto' }, async () => {
    // The local decoder rejects three junk bytes, which is the point: the
    // assertion is that no hosted call was attempted on the way there.
    await transcribeVoice(voice()).catch(() => undefined);
  });
  withoutKey();
  assert.equal(calls, 0, 'auto without a key must not attempt a hosted call');
});

test('when both engines fail the hosted reason is reported first', async () => {
  await withEnv({ GROQ_API_KEY: 'gsk_x', TRANSCRIBE_PROVIDER: 'auto' }, () =>
    withFetch(
      () => new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), { status: 429 }),
      async () => {
        const error = await transcribeVoice(
          voice({ attachments: [{ type: 'audio', fetchData: async () => new Uint8Array(512).fill(9) }] }),
        ).then(() => null, (e: Error) => e);
        assert.ok(error, 'expected a rejection');
        assert.match(error.message, /rate limit reached/);
        assert.match(error.message, /local fallback also failed/);
      },
    ),
  );
});

test('the engine is named so the Heard line does not misreport where audio went', () => {
  assert.equal(providerLabel('groq'), 'Groq Whisper');
  assert.equal(providerLabel('local'), 'local Whisper');
});

// --- the message the agent finally receives ---------------------------------

test('the transcript replaces the text', () => {
  const handed = withTranscript(voice(), 'can you hear me') as { text: string };
  assert.equal(handed.text, 'can you hear me');
});

test('the voice file is not handed to the model alongside the transcript', () => {
  // The bug this pins: a voice note is an *attachment*, so replacing the text
  // left the audio in place. The model then answered that it could see the audio
  // file but could not play or transcribe it, and ignored the transcript.
  const handed = withTranscript(voice(), 'can you hear me') as { attachments: { type: string }[] };
  assert.deepEqual(handed.attachments, []);
  assert.equal(handed.attachments.some((a) => a.type === 'audio'), false);
});

test('non-audio attachments survive, so a caption photo is not silently dropped', () => {
  const withPhoto = {
    text: '',
    attachments: [
      { type: 'image', fetchData: async () => new Uint8Array([1]) },
      { type: 'audio', fetchData: async () => new Uint8Array([2]) },
    ],
  };
  const handed = withTranscript(withPhoto, 'look at this') as { attachments: { type: string }[] };
  assert.deepEqual(handed.attachments.map((a) => a.type), ['image']);
});

test('other fields are preserved, since memory keys off the message shape', () => {
  const handed = withTranscript(
    { ...voice(), id: 'm-1', channelMessageId: 'c-1', from: 'u-1' },
    'hi',
  ) as Record<string, unknown>;
  assert.equal(handed.id, 'm-1');
  assert.equal(handed.channelMessageId, 'c-1');
  assert.equal(handed.from, 'u-1');
});

test('a message with no attachments at all does not throw', () => {
  const handed = withTranscript({ text: '' }, 'hi') as { text: string; attachments: unknown[] };
  assert.equal(handed.text, 'hi');
  assert.deepEqual(handed.attachments, []);
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

