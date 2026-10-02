import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config.
 *
 * Only the app's own tables. Mastra's ~40 tables are created by PostgresStore on
 * boot and are deliberately not in the schema, so `drizzle-kit push` cannot touch
 * them — a migration that dropped a Mastra table would break memory silently.
 *
 * `dbCredentials` reuses the app's own DATABASE_URL rather than a second env var,
 * so there is one place the connection string is configured.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required. Run via: node --env-file=.env drizzle-kit ...');
}

export default defineConfig({
  schema: './src/mastra/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});