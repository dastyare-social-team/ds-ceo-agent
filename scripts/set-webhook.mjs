#!/usr/bin/env node
/**
 * Registers the Mastra-generated Telegram webhook against a deployed URL.
 *
 *   node scripts/set-webhook.mjs https://my-app.vercel.app
 *   node scripts/set-webhook.mjs --remove
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET_TOKEN from the
 * environment or a local .env file. The secret token must match the value
 * configured on Vercel, otherwise Telegram's requests are rejected with 401.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const AGENT_ID = 'ceo-agent';
const WEBHOOK_PATH = `/api/agents/${AGENT_ID}/channels/telegram/webhook`;
const API = 'https://api.telegram.org';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(projectRoot, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env is fine — real env vars may be set instead.
  }
}

loadDotEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN (set it in .env or the environment).');
  process.exit(1);
}

if (!/^\d+:[\w-]+$/.test(token)) {
  console.error('TELEGRAM_BOT_TOKEN does not look like a Telegram bot token.');
  process.exit(1);
}

async function call(method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram ${method} failed: ${data.description ?? res.status}`);
    process.exit(1);
  }
  return data.result;
}

const remove = process.argv.includes('--remove');
const baseUrl = process.argv.find((a) => a.startsWith('http'));

if (remove) {
  await call('deleteWebhook', { drop_pending_updates: false });
  console.log('✓ Webhook removed. The bot now ignores incoming updates.');
  process.exit(0);
}

if (!baseUrl && !process.env.PUBLIC_URL) {
  console.error(
    'Pass your deployed URL as the first argument, or set PUBLIC_URL.\n' +
      'Example: node scripts/set-webhook.mjs https://my-app.vercel.app',
  );
  process.exit(1);
}

if (!secret) {
  console.error(
    'Missing TELEGRAM_WEBHOOK_SECRET_TOKEN. It must be set both here and in ' +
      'your Vercel env vars, and must match exactly.',
  );
  process.exit(1);
}

const publicUrl = (baseUrl ?? process.env.PUBLIC_URL).replace(/\/+$/, '');
const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`;

const me = await call('getMe');
console.log(`Bot: @${me.username} (${me.first_name})`);

await call('setWebhook', {
  url: webhookUrl,
  secret_token: secret,
  // Messages only. Keeps callback_query spam out of the webhook.
  allowed_updates: ['message'],
  drop_pending_updates: true,
});

await call('setMyCommands', {
  commands: [{ command: 'start', description: 'Start chatting' }],
});

const info = await call('getWebhookInfo');
console.log('✓ Webhook registered');
console.log(`  url:            ${info.url}`);
console.log(`  pending:        ${info.pending_update_count}`);
if (info.last_error_message) {
  console.warn(`  last error:     ${info.last_error_message}`);
}
console.log(`\nOpen Telegram and message @${me.username}.`);
