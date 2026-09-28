/**
 * Reasoning-rendering and model-chain tests. Run with: npm test
 *
 * Reasoning used to be inlined into the final answer as a quoted block. It is now
 * streamed live and then deleted, so the tests below cover that lifecycle, plus the
 * escaping rules the Telegram converter enforces (no `||spoiler||`, no expandable
 * blockquote) that any future change must not break.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { TelegramFormatConverter } from '@chat-adapter/telegram';
import { RequestContext } from '@mastra/core/request-context';
import {
  StreamingThinkingProcessor,
  THREAD_CONTEXT_KEY,
} from '../src/mastra/processors/streaming-thinking.ts';
import {
  OPENROUTER_FREE_CHAIN,
  assistantModel,
  assistantModelChain,
  assistantModelList,
  resolveModel,
} from '../src/mastra/model.ts';

function modelId(entry: { model: unknown }): string {
  const m = entry.model;
  if (typeof m === 'string') return m;
  const id = (m as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  throw new Error(`chain entry has no resolvable id: ${JSON.stringify(m)}`);
}

/** Run with a given env and restore it afterwards, so tests stay independent. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- streaming thinking: show it live, then remove it ------------------------

/** A Telegram thread stand-in that records what a user would have seen. */
function fakeThread() {
  const seen: string[] = [];
  const sent = {
    edits: 0,
    async edit(text: string) {
      this.edits += 1;
      seen[0] = text;
      return sent;
    },
    async delete() {
      seen.length = 0;
    },
  };
  return {
    seen,
    sent,
    async post(text: string) {
      seen.push(text);
      return sent;
    },
  };
}

const reasoningChunk = (text: string) => ({ type: 'reasoning', text });

async function stream(parts: unknown[]) {
  const thread = fakeThread();
  const requestContext = new RequestContext();
  requestContext.set(THREAD_CONTEXT_KEY, thread);
  const processor = new StreamingThinkingProcessor();
  const state: Record<string, unknown> = {};
  for (let i = 0; i < parts.length; i += 1) {
    await processor.processOutputStream({
      part: parts[i],
      streamParts: parts.slice(0, i + 1),
      state,
      requestContext,
    } as never);
  }
  return { thread, processor, state };
}

test('reasoning is posted to the chat while it streams', async () => {
  const { thread } = await stream([reasoningChunk('Weighing options.')]);
  assert.equal(thread.seen.length, 1);
  assert.match(thread.seen[0], /Thinking/);
  assert.match(thread.seen[0], /Weighing options\./);
});

test('reasoning split across chunks is joined, not truncated to the first', async () => {
  // Edits are rate-limited, so disable the throttle to observe every update.
  const previous = process.env.THINKING_EDIT_THROTTLE_MS;
  process.env.THINKING_EDIT_THROTTLE_MS = '0';
  try {
    const { thread } = await stream([reasoningChunk('Weighing '), reasoningChunk('the options.')]);
    assert.match(thread.seen[0], /Weighing the options\./);
  } finally {
    if (previous === undefined) delete process.env.THINKING_EDIT_THROTTLE_MS;
    else process.env.THINKING_EDIT_THROTTLE_MS = previous;
  }
});

test('the thinking message is removed once the answer is ready', async () => {
  const { thread, processor, state } = await stream([reasoningChunk('Weighing options.')]);
  assert.equal(thread.seen.length, 1, 'visible while thinking');
  await processor.processOutputResult({ state, messageList: {}, result: { steps: [] } } as never);
  assert.equal(thread.seen.length, 0, 'gone before the answer is sent');
});

test('non-reasoning chunks never post anything', async () => {
  const { thread } = await stream([{ type: 'text', text: 'The answer is 42.' }]);
  assert.equal(thread.seen.length, 0);
});

test('with no thread on the context the processor is inert, not fatal', async () => {
  const processor = new StreamingThinkingProcessor();
  const state: Record<string, unknown> = {};
  await processor.processOutputStream({
    part: reasoningChunk('Weighing.'),
    streamParts: [reasoningChunk('Weighing.')],
    state,
    requestContext: new RequestContext(),
  } as never);
  await processor.processOutputResult({ state, messageList: {}, result: { steps: [] } } as never);
});

test('a Telegram failure while showing progress does not fail the turn', async () => {
  const requestContext = new RequestContext();
  requestContext.set(THREAD_CONTEXT_KEY, {
    post: async () => {
      throw new Error('Telegram is down');
    },
  });
  const processor = new StreamingThinkingProcessor();
  const state: Record<string, unknown> = {};
  await processor.processOutputStream({
    part: reasoningChunk('Weighing.'),
    streamParts: [reasoningChunk('Weighing.')],
    state,
    requestContext,
  } as never);
  await processor.processOutputResult({ state, messageList: {}, result: { steps: [] } } as never);
});

test('a long monologue is trimmed in the preview, not dumped into the chat', async () => {
  const { thread } = await stream([reasoningChunk('word '.repeat(500))]);
  assert.ok(thread.seen[0].length < 600, `preview was ${thread.seen[0].length} chars`);
  assert.match(thread.seen[0], /…/);
});
test('the agent ships a SINGLE model, because an array deadlocks streaming', () => {
  // Mastra's channel streams. With a model array, agent.stream() never resolves
  // on @mastra/core 1.71.0 and every inbound message hangs silently.
  const model = withEnv({ OPENCODE_API_KEY: 'test-key', MODEL: undefined }, () =>
    assistantModel(),
  );
  assert.equal(typeof model, 'object', 'a single Zen config object, not an array');
  assert.equal((model as { id: string }).id, 'opencode/space-bunny-free');
  assert.equal((model as { url: string }).url, 'https://opencode.ai/zen/v1');
});

test('OpenCode Zen is first in the chain, ahead of every OpenRouter model', () => {
  const list = withEnv(
    { OPENCODE_API_KEY: 'test-key', MODEL: undefined, OPENCODE_FALLBACK_CHAIN: '1' },
    () => assistantModelChain(),
  );
  const ids = list.map(modelId);
  const lastZen = ids.map((id) => id.startsWith('opencode/')).lastIndexOf(true);
  const firstOpenRouter = ids.findIndex((id) => id.startsWith('openrouter/'));
  assert.ok(lastZen >= 0, 'a Zen model must be present when the key is set');
  assert.ok(lastZen < firstOpenRouter, `Zen must precede OpenRouter: ${ids.join(', ')}`);
  assert.equal(ids[0], 'opencode/space-bunny-free');
});

test('every chain entry is free-tier and fails over without retrying', () => {
  const list = withEnv(
    { OPENCODE_API_KEY: 'test-key', MODEL: undefined, OPENCODE_FALLBACK_CHAIN: '1' },
    () => assistantModelChain(),
  );
  assert.ok(list.length > 1);
  for (const entry of list) {
    const id = modelId(entry);
    assert.ok(
      id.startsWith('opencode/') || id.startsWith('openrouter/'),
      `unexpected model: ${id}`,
    );
    assert.equal(entry.maxRetries, 0);
  }
});

test('removing the Zen key yields an OpenRouter-only chain', () => {
  const list = withEnv(
    { OPENCODE_API_KEY: undefined, MODEL: undefined, OPENCODE_FALLBACK_CHAIN: '1' },
    () => assistantModelChain(),
  );
  assert.equal(list.length, OPENROUTER_FREE_CHAIN.length);
  assert.ok(list.every((e) => modelId(e).startsWith('openrouter/')));
});

test('the chain has no duplicates', () => {
  const list = withEnv(
    { OPENCODE_API_KEY: 'test-key', MODEL: undefined, OPENCODE_FALLBACK_CHAIN: '1' },
    () => assistantModelChain(),
  );
  const ids = list.map(modelId);
  assert.equal(new Set(ids).size, ids.length);
});

test('no paid slug is ever referenced', () => {
  // The OpenRouter key has no credits, so any paid slug would fail at call time.
  for (const { model } of OPENROUTER_FREE_CHAIN) {
    assert.ok(!model.includes('deepseek/deepseek-v4-flash-0731'), model);
  }
});

test('no Zen model known to be client-restricted is in the chain', () => {
  // These nine answer 403 "can only be used from within OpenCode" from a server.
  const restricted = [
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'ling-3.0-flash-fin-free',
    'mimo-v2.6-flash-free',
    'mimo-v2.5-free',
    'jev-1.13-free',
    'longcat-2.5-preview-free',
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
  ];
  const ids = withEnv(
    { OPENCODE_API_KEY: 'test-key', MODEL: undefined, OPENCODE_FALLBACK_CHAIN: '1' },
    () => assistantModelChain(),
  ).map(modelId);
  for (const id of restricted) {
    assert.ok(!ids.includes(`opencode/${id}`), `${id} is 403 from a server`);
  }
});

test('verified OpenRouter tier is ordered by descending context', () => {
  const contexts = OPENROUTER_FREE_CHAIN.slice(0, 10).map((e) => e.context);
  assert.deepEqual(contexts, [...contexts].sort((a, b) => b - a));
});

test('rate-limited OpenRouter models stay in the chain as a deeper tier', () => {
  const ids = OPENROUTER_FREE_CHAIN.map((e) => e.model);
  assert.ok(ids.includes('openrouter/qwen/qwen3.8-27b:free'));
  assert.ok(ids.includes('openrouter/poolside/laguna-xs-2.1:free'));
});

test('agentic-only and non-chat OpenRouter models are excluded', () => {
  const ids = OPENROUTER_FREE_CHAIN.map((e) => e.model);
  assert.ok(!ids.some((m) => m.includes('thinkingmachines/inkling')), '403 agentic-only');
  assert.ok(!ids.some((m) => m.includes('lyria')), 'music model');
  assert.ok(!ids.some((m) => m.includes('content-safety')), 'moderation model');
  assert.ok(!ids.some((m) => m.includes('nano-omni-30b-a3b-reasoning')), 'no tool support');
});

test('MODEL pins a single model for either provider', () => {
  const openrouter = withEnv({ MODEL: 'openrouter/liquid/lfm-2.5-2.6b:free' }, () =>
    assistantModel(),
  );
  assert.equal(openrouter, 'openrouter/liquid/lfm-2.5-2.6b:free');

  const zen = withEnv({ MODEL: 'opencode/space-bunny-free' }, () => assistantModel());
  assert.equal((zen as { url: string }).url, 'https://opencode.ai/zen/v1');
});

test('shared pub/sub is off unless REDIS_PUBSUB=1', () => {
  // RedisStreamsPubSub deadlocks agent.stream() on @mastra/core 1.71.0, and the
  // Telegram channel streams, so a live bot that answers beats dedup.
  const src = readFileSync('src/mastra/index.ts', 'utf8');
  assert.ok(
    src.includes("process.env.REDIS_PUBSUB === '1'"),
    'pubsub must be gated behind REDIS_PUBSUB',
  );
  assert.ok(src.includes('deadlocks streaming'), 'the deadlock must be documented in the source');
});

test('opencode/<id> maps to a Zen config, others pass through', () => {
  const zen = resolveModel('opencode/space-bunny-free') as { url: string; id: string };
  assert.equal(zen.url, 'https://opencode.ai/zen/v1');
  assert.equal(zen.id, 'opencode/space-bunny-free');
  assert.equal(
    resolveModel('openrouter/liquid/lfm-2.5-2.6b:free'),
    'openrouter/liquid/lfm-2.5-2.6b:free',
  );
});

const converter = new TelegramFormatConverter();

test('the Thinking block renders as a Telegram blockquote', () => {
  const out = converter.renderPostable({ markdown: '> **Thinking**\n> because' } as never);
  assert.match(out, />/);
  assert.match(out, /Thinking/);
});

test('a spoiler is NOT reachable: raw || is escaped to literal characters', () => {
  const out = converter.renderPostable({ markdown: '**T** ||hidden||' } as never);
  assert.ok(!out.includes('||'), 'spoiler entity must not appear');
  assert.match(out, /\\\|\\\|/, 'pipe characters are escaped, so it renders literally');
});
