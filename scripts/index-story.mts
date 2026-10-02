import { readFileSync } from 'node:fs';
import { db, closeDb } from '../src/mastra/db/client.ts';
import { storyChunks } from '../src/mastra/db/schema.ts';
import { count, sql } from 'drizzle-orm';
import { chunkNote, stripFrontmatter, termCounts } from '../src/mastra/story/chunk.ts';

/**
 * Indexes the founder's English notes into app_story_chunks.
 *
 *   node --env-file=.env --import tsx scripts/index-story.mts
 *
 * Run from a machine that can see the Obsidian vault. The index is content, not
 * code: it is rebuilt whenever the notes change, and the agent reads it through
 * retrieval rather than shipping the vault inside the function bundle.
 */

const VAULT = process.env.STORY_VAULT_PATH ?? '/Users/omidshabab/Documents/obsidian/Omid Shabab — Personal Brand';

/**
 * Only these folders. The vault also holds University notes in Persian, campaign
 * trackers and templates, none of which are the founder's own writing and all of
 * which would dilute retrieval with text that must never be quoted as his voice.
 *
 * `Story.md` and `Brand Voice.md` carry the highest weight: the first is the
 * narrative itself and the second is explicit instruction, so a caption that
 * contradicts either is worse than one that merely misses a detail.
 */
const SOURCES: { path: string; weight: number }[] = [
  { path: '01_IDENTITY/Story.md', weight: 5 },
  { path: '01_IDENTITY/Origin Story.md', weight: 4 },
  { path: '01_IDENTITY/Founder Identity.md', weight: 4 },
  { path: '01_IDENTITY/Beliefs.md', weight: 3 },
  { path: '01_IDENTITY/Values.md', weight: 3 },
  { path: '01_IDENTITY/Reputation Goals.md', weight: 3 },
  { path: '02_POSITIONING/Positioning.md', weight: 4 },
  { path: '02_POSITIONING/Audience.md', weight: 3 },
  { path: '02_POSITIONING/Category.md', weight: 3 },
  { path: '02_POSITIONING/Differentiation.md', weight: 3 },
  { path: '02_POSITIONING/ICP.md', weight: 3 },
  { path: '02_POSITIONING/Proof.md', weight: 3 },
  { path: '02_POSITIONING/Problems We Talk About.md', weight: 3 },
  { path: '03_CONTENT/Brand Voice.md', weight: 5 },
  { path: '03_CONTENT/Content Pillars.md', weight: 3 },
  { path: '03_CONTENT/Content Strategy.md', weight: 2 },
  { path: '03_CONTENT/Editorial System.md', weight: 2 },
];

// --- index ------------------------------------------------------------------

let indexed = 0;
const missing: string[] = [];

for (const { path, weight } of SOURCES) {
  let raw: string;
  try {
    raw = readFileSync(`${VAULT}/${path}`, 'utf8');
  } catch {
    missing.push(path);
    continue;
  }

  const chunks = chunkNote(stripFrontmatter(raw));
  const values = chunks.map((chunk, ordinal) => ({
    // Derived from source+ordinal so reindexing is idempotent.
    id: `${path}#${ordinal}`,
    source: path,
    heading: chunk.heading,
    ordinal,
    text: chunk.text,
    terms: termCounts(`${chunk.heading ?? ''} ${chunk.text}`),
    weight,
    updatedAt: new Date(),
  }));

  await db
    .insert(storyChunks)
    .values(values)
    .onConflictDoUpdate({
      target: storyChunks.id,
      set: {
        // `excluded` is the row being inserted. Referencing `values[0]` here
        // instead would apply one chunk's text to every ordinal, silently making
        // the whole note identical in the index — which looks like retrieval
        // returning duplicates, and would have made the story corpus useless.
        source: sql`excluded.source`,
        heading: sql`excluded.heading`,
        text: sql`excluded.text`,
        terms: sql`excluded.terms`,
        weight: sql`excluded.weight`,
        updatedAt: new Date(),
      },
    });
  indexed += values.length;
  console.log(`  ${path.padEnd(42)} ${values.length} chunk(s), weight ${weight}`);
}

const [{ value: total }] = await db.select({ value: count() }).from(storyChunks);
console.log(`\n  wrote ${indexed} chunk(s); ${total} now in app_story_chunks`);
if (missing.length) {
  console.log(`  missing sources (${missing.length}): ${missing.join(', ')}`);
}
await closeDb();