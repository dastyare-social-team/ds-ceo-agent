/**
 * Text utilities shared by the indexer and the retriever.
 *
 * These live here rather than in the indexer script because the retriever needs
 * `terms` to tokenize a query, and importing it from the script would re-run the
 * whole indexing pass on every call.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'for', 'with',
  'at', 'by', 'from', 'as', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'so', 'up', 'out', 'about',
  'into', 'over', 'after', 'before', 'when', 'while', 'what', 'which', 'who', 'how', 'why',
]);

/** Lowercase, split on non-letters, drop stop words and one-character noise. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

export function termCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const term of terms(text)) counts[term] = (counts[term] ?? 0) + 1;
  return counts;
}

/** Drops the YAML frontmatter block, which is metadata and reads as noise. */
export function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? raw.slice(match[0].length) : raw;
}

/**
 * Splits a note into heading-scoped chunks.
 *
 * Heading-scoped rather than fixed-length because a section is a meaningful unit:
 * "## — Not This" is useless advice on its own, while the section it belongs to is
 * a complete instruction.
 */
export function chunkNote(body: string, maxChars = 1800): { heading: string | null; text: string }[] {
  const chunks: { heading: string | null; text: string }[] = [];
  const lines = body.split('\n');
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length > 40) chunks.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line.trim())) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, '').replace(/[—–-]/g, '').trim() || null;
      continue;
    }
    buffer.push(line);
    // Split a long run of prose that has no headings, so one blob cannot dominate.
    if (buffer.join('\n').length > maxChars) flush();
  }
  flush();

  if (!chunks.length) {
    const text = body.trim();
    if (text.length > 40) chunks.push({ heading: null, text });
  }
  return chunks;
}