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

// Telegram escaping rules the channel still depends on, whatever renders the text.
const converter = new TelegramFormatConverter();

test('a spoiler is NOT reachable: raw || is escaped to literal characters', () => {
  const out = converter.renderPostable({ markdown: '**T** ||hidden||' } as never);
  assert.ok(!out.includes('||'), 'spoiler entity must not appear');
  assert.match(out, /\\\|\\\|/, 'pipe characters are escaped, so it renders literally');
});
