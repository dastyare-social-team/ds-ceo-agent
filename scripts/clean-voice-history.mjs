#!/usr/bin/env node
/**
 * Strip `[Attached file: ... (audio/ogg)]` placeholders out of stored messages.
 *
 * A voice note reaches Mastra as an attachment. When the model was handed the
 * transcript *and* the attachment, it stored both, and a text-only model reading
 * "[Attached file: file (audio/ogg)]" in its own history concludes it cannot
 * handle audio — even for a turn that is nothing but text. Those rows sit inside
 * the memory recall window (lastMessages: 20) for many turns after the fact, so
 * the bot kept refusing long after the attachment stopped being passed.
 *
 * The handler now strips audio before the model sees a message, but rows written
 * before that fix are still in Postgres and still in context. This removes the
 * placeholder text part, keeping the row and the real transcript.
 *
 *   node scripts/clean-voice-history.mjs            # dry run, prints what it would do
 *   node scripts/clean-voice-history.mjs --apply    # actually delete
 */

import { Client } from 'pg';

const APPLY = process.argv.includes('--apply');
const THREAD_ID = process.env.TARGET_THREAD_ID; // optional: scope to one thread

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Run with --env-file=.env or export it.');
  process.exit(1);
}

/**
 * The placeholder is a text part whose content is the attachment label. Only
 * those parts go; the transcript text part is the row's real content and stays.
 */
const PLACEHOLDER = /\[Attached (file|audio|image|video)[^\]]*\]|\[Attachment unavailable:[^\]]*\]|\[Attached [^\]]*file[^\]]*\]/i;

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

const rows = await (async () => {
  await client.connect();
  const params = [];
  let where = `content::text ~* '\\[Attached' OR content::text ~* '\\[Attachment unavailable'`;
  if (THREAD_ID) {
    params.push(THREAD_ID);
    where += ` AND thread_id = $1`;
  }
  const res = await client.query(
    `select id, thread_id, role, content::text as content from mastra_messages where ${where} order by "createdAt"`,
    params,
  );
  return res.rows;
})();

let touched = 0;
const updates = [];

for (const row of rows) {
  let content;
  try {
    content = JSON.parse(row.content);
  } catch {
    continue;
  }
  if (!Array.isArray(content.parts)) continue;

  const kept = content.parts.filter((p) => !(p?.type === 'text' && PLACEHOLDER.test(p.text ?? '')));
  if (kept.length === content.parts.length) continue;

  // The fallback `content` field is a denormalised string copy; rebuild it so
  // nothing downstream reads a stale placeholder.
  const textOf = kept
    .filter((p) => p?.type === 'text' && (p.text ?? '').trim())
    .map((p) => p.text)
    .join('\n\n')
    .trim();

  const next = { ...content, parts: kept };
  if (typeof content.content === 'string') next.content = textOf;
  // A row left with no text and no file part carries nothing; drop it entirely
  // rather than leaving an empty turn the model must reason around.
  const hasPayload = kept.some((p) => p?.type === 'file' || (p?.type === 'text' && (p.text ?? '').trim()));
  if (!hasPayload) {
    updates.push({ id: row.id, sql: `delete from mastra_messages where id = $1`, note: 'empty after strip' });
  } else {
    updates.push({
      id: row.id,
      sql: `update mastra_messages set content = $2::jsonb where id = $1`,
      value: JSON.stringify(next),
      note: 'placeholder removed',
    });
  }
  touched += 1;
}

console.log(`rows with attachment placeholders: ${rows.length}`);
console.log(`rows that would change:            ${touched}`);

for (const u of updates) {
  const preview = String(u.value ?? '').replace(/\s+/g, ' ').slice(0, 90);
  console.log(`  ${u.id}  ${u.note.padEnd(22)} ${preview}`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.');
} else if (touched === 0) {
  console.log('\nNothing to do.');
} else {
  for (const u of updates) {
    if (u.value === undefined) await client.query(u.sql, [u.id]);
    else await client.query(u.sql, [u.id, u.value]);
  }
  console.log(`\nApplied: ${touched} row(s) rewritten.`);
}

await client.end();
