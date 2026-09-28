/**
 * Reads an environment variable, treating blank/whitespace values as unset.
 *
 * This matters more than it looks: an `.env` line like `DATABASE_URL=` produces
 * an empty string, not `undefined`, so `process.env.X ?? fallback` silently
 * yields `''` and passes it straight into clients like libSQL.
 */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
