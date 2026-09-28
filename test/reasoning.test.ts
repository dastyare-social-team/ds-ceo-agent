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
import { TelegramFormatConverter } from '@chat-adapter/telegram';
import { ReasoningBlockProcessor } from '../src/mastra/processors/reasoning-block.ts';
import { FREE_MODEL_CHAIN, resolveModel, assistantModelList } from '../src/mastra/model.ts';

type AnyRecord = Record<string, unknown>;

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

test('chain is OpenRouter free-only with immediate failover', () => {
  const list = assistantModelList();
  assert.ok(list.length > 1);
  for (const entry of list) {
    assert.match(String(entry.model), /^openrouter\//);
    assert.equal(entry.maxRetries, 0);
  }
});

test('chain has no duplicates', () => {
  const ids = assistantModelList().map((e) => String(e.model));
  assert.equal(new Set(ids).size, ids.length);
});

test('chain never references a zero-credit paid slug', () => {
  for (const { model } of FREE_MODEL_CHAIN) {
    assert.ok(!model.includes('deepseek/deepseek-v4-flash-0731'), model);
  }
});

test('verified tier is ordered by descending context', () => {
  const contexts = FREE_MODEL_CHAIN.slice(0, 10).map((e) => e.context);
  assert.deepEqual(contexts, [...contexts].sort((a, b) => b - a));
});

test('rate-limited models stay in the chain as a deeper tier', () => {
  const ids = FREE_MODEL_CHAIN.map((e) => e.model);
  assert.ok(ids.includes('openrouter/qwen/qwen3.8-27b:free'));
  assert.ok(ids.includes('openrouter/poolside/laguna-xs-2.1:free'));
});

test('agentic-only and non-chat models are excluded', () => {
  const ids = FREE_MODEL_CHAIN.map((e) => e.model);
  assert.ok(!ids.some((m) => m.includes('thinkingmachines/inkling')), '403 agentic-only');
  assert.ok(!ids.some((m) => m.includes('lyria')), 'music model');
  assert.ok(!ids.some((m) => m.includes('content-safety')), 'moderation model');
  assert.ok(!ids.some((m) => m.includes('nano-omni-30b-a3b-reasoning')), 'no tool support');
});

test('MODEL pins a single model and disables the chain', () => {
  const previous = process.env.MODEL;
  process.env.MODEL = 'openrouter/liquid/lfm-2.5-2.6b:free';
  try {
    const list = assistantModelList();
    assert.equal(list.length, 1);
    assert.equal(list[0].model, 'openrouter/liquid/lfm-2.5-2.6b:free');
  } finally {
    if (previous === undefined) delete process.env.MODEL;
    else process.env.MODEL = previous;
  }
});

test('opencode/<id> maps to a Zen config, others pass through', () => {
  const zen = resolveModel('opencode/space-bunny-free') as { url: string; id: string };
  assert.equal(zen.url, 'https://opencode.ai/zen/v1');
  assert.equal(zen.id, 'opencode/space-bunny-free');
  assert.equal(resolveModel('openrouter/liquid/lfm-2.5-2.6b:free'), 'openrouter/liquid/lfm-2.5-2.6b:free');
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
