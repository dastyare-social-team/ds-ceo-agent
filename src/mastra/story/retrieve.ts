import { db, closeDb } from '../db/client.ts';
import { storyChunks, type StoryChunkRow } from '../db/schema.ts';
import { terms } from './chunk.ts';

/**
 * Retrieval over the founder's own writing.
 *
 * Lexical, not vector. Every free embedding endpoint needs a card, and this
 * corpus is ~67 chunks of distinctive prose where the query terms ("ADHD",
 * "freelance", "Flutter", "first-person") actually appear in the text. BM25-style
 * scoring handles that well; a vector index would add a paid dependency and a
 * column to answer the same question.
 *
 * This module is the seam where vectors would go: callers depend on
 * `retrieveStory`, not on how chunks are scored.
 */

const K1 = 1.2;
const B = 0.75;

export interface StoryExcerpt {
  source: string;
  heading: string | null;
  text: string;
  score: number;
}

/** IDF over the indexed corpus, recomputed per call from chunk statistics. */
function idf(totalChunks: number, docsContaining: number): number {
  return Math.log(1 + (totalChunks - docsContaining + 0.5) / (docsContaining + 0.5));
}

/**
 * Scores chunks against a query and returns the best excerpts.
 *
 * Length normalisation matters here: `Story.md` chunks are long and would
 * otherwise outrank a short, precisely-on-point note purely by containing more
 * words.
 */
export function rankChunks(
  chunks: (StoryChunkRow & { docFreq?: number })[],
  query: string,
  limit: number,
): StoryExcerpt[] {
  const queryTerms = [...new Set(terms(query))];
  if (!queryTerms.length) return [];

  const avgLength =
    chunks.reduce((sum, c) => sum + Object.keys(c.terms as Record<string, number>).length, 0) /
      Math.max(chunks.length, 1);

  const scored = chunks.map((chunk) => {
    const counts = chunk.terms as Record<string, number>;
    const length = Object.keys(counts).length || 1;
    let score = 0;
    let matched = 0;

    for (const term of queryTerms) {
      const tf = counts[term];
      if (!tf) continue;
      matched += 1;
      const containing = chunks.filter((c) => (c.terms as Record<string, number>)[term]).length;
      score += idf(chunks.length, containing) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avgLength)));
    }

    // A chunk that matched nothing is noise, however heavy its note.
    if (!matched) return { ...chunk, score: 0 };
    // Reward coverage: matching three distinct query terms beats matching one
    // term fifty times, which is what separates a note about the topic from a
    // long note that happens to repeat one word.
    score *= 1 + (matched / queryTerms.length);
    // The founder's identity and voice notes outrank strategy notes.
    score *= chunk.weight;
    return { ...chunk, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((chunk) => ({
      source: chunk.source,
      heading: chunk.heading,
      text: chunk.text,
      score: Number(chunk.score.toFixed(3)),
    }));
}

/** Reads from the index. Separated so tests can rank without a database. */
export async function retrieveStory(query: string, limit = 4): Promise<StoryExcerpt[]> {
  const chunks = await db.select().from(storyChunks);
  return rankChunks(chunks, query, limit);
}

/**
 * Formats excerpts for a model tool result.
 *
 * Sources are named so the agent can cite the note it drew on. Without that, a
 * caption reads as invented rather than as something drawn from the founder's
 * own material, which is the difference the user can act on.
 */
export function formatExcerpts(excerpts: StoryExcerpt[]): string {
  if (!excerpts.length) {
    return 'No matching notes. Write from the transcript without claiming it reflects the founder’s stated voice.';
  }
  return excerpts
    .map((excerpt, index) => {
      const where = excerpt.heading ? `${excerpt.source} — ${excerpt.heading}` : excerpt.source;
      return `### ${index + 1}. ${where}\n${excerpt.text}`;
    })
    .join('\n\n');
}

// Allow `node --import tsx src/mastra/story/retrieve.ts "<query>"` for a quick check.
if (process.argv[1]?.endsWith('retrieve.ts') && process.argv[2]) {
  const excerpts = await retrieveStory(process.argv[2]);
  console.log(formatExcerpts(excerpts));
  await closeDb();
}