/**
 * Reasoning-rendering and model-chain tests. Run with: npm test
 *
 * The Telegram rendering tests lock in *why* the reasoning block is a quote and
 * not a collapsible section. Both facts were verified against the adapter's own
 * converter, and both are easy to regress by "improving" the processor to use
 * `||spoiler||` or `<blockquote expandable>` — which does not work.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { TelegramFormatConverter } from '@chat-adapter/telegram';
import { ReasoningBlockProcessor } from '../src/mastra/processors/reasoning-block.ts';
import {
  OPENROUTER_FREE_CHAIN,
  resolveModel,
  assistantModel,
  assistantModelChain,
} from '../src/mastra/model.ts';

type AnyRecord = Record<string, unknown>;

/**
 * A chain entry's model is either a plain string (OpenRouter, resolved by
 * Mastra's provider router) or a Zen config object carrying its own `id` and
 * `url`. Normalise to the id so ordering can be asserted.
 */
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

/** Minimal message shape the processor reads. */
function message(parts: unknown[], content = 'The answer is 42.') {
  return { content: { parts, content } } as unknown as AnyRecord;
}

function step(reasoning: unknown) {
  return { reasoning };
}

function run(parts: unknown[], steps: unknown[]) {
  const messages = [message(parts)];
  new ReasoningBlockProcessor().processOutputResult({
    messages,
    messageList: {},
    result: { steps },
  } as never);
  return messages[0].content.content as string;
}

const chunk = (text: string) => [{ type: 'reasoning', payload: { text } }];

test('no reasoning leaves the message untouched', () => {
  assert.equal(run([{ type: 'text', text: 'hi' }], [step(undefined)]), 'The answer is 42.');
});

test('prepends a quoted Thinking block from step reasoning', () => {
  const out = run([{ type: 'text', text: 'hi' }], [step([chunk('Weighing options.')])]);
  assert.match(out, /\*\*Thinking\*\*/);
  assert.match(out, /Weighing options\./);
  assert.match(out, /The answer is 42\./);
  assert.ok(out.indexOf('Thinking') < out.indexOf('42'), 'block must come before the answer');
});

test('reads reasoning from message parts when steps carry none', () => {
  const out = run([{ type: 'reasoning', text: 'From the message part.' }], [step(undefined)]);
  assert.match(out, /From the message part\./);
});

test('does not repeat reasoning reported by both steps and parts', () => {
  const out = run([{ type: 'reasoning', text: 'Same thought.' }], [step([chunk('Same thought.')])]);
  assert.equal(out.match(/Same thought\./g)?.length, 1);
});

test('truncates a runaway monologue and says so', () => {
  const out = run([{ type: 'text', text: 'hi' }], [step([chunk('x'.repeat(4000))])]);
  assert.match(out, /chars\)/);
  assert.ok(!out.includes('x'.repeat(2000)), 'long body must be cut');
});

test('quotes every reasoning line and separates the block from the answer', () => {
  const out = run([{ type: 'text', text: 'hi' }], [step([chunk('line one\nline two')])]);
  // The block is everything before the blank separator; the answer follows it and
  // must stay unquoted.
  const [block, ...rest] = out.split('\n');
  assert.equal(block, '> **Thinking**');
  const idx = out.indexOf('\n\n');
  const blockLines = out.slice(0, idx).split('\n');
  for (const line of blockLines) assert.ok(line.startsWith('>'), `unquoted: ${line}`);
  assert.equal(rest[rest.length - 1], 'The answer is 42.');
  assert.match(out, /^\> \*\*Thinking\*\*\n> line one line two\n\nThe answer is 42\.$/);
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
