import { PostgresStore } from '@mastra/pg';
import { env } from './env.ts';

/**
 * Normalises a Postgres connection string for node-postgres.
 *
 * Two things worth being explicit about, both learned from inspecting
 * `pg-connection-string` and Neon:
 *
 * 1. `sslmode=require` — in pg-connection-string v2 this is already treated as
 *    an alias for `verify-full`, so the certificate and hostname *are* checked
 *    today. In v3 (pg v9) it adopts standard libpq semantics, where `require`
 *    means "encrypt but do not verify" — a silent downgrade. We pin
 *    `verify-full` so the connection stays verified across the upgrade.
 *
 * 2. `channel_binding=require` — Neon appends this, but node-postgres has no
 *    implementation for it and silently drops it. We strip it rather than leave
 *    a parameter in the URL that implies protection we are not actually getting.
 */
export function normalizeConnectionString(raw: string): string {
  const url = new URL(raw);

  if (url.searchParams.get('sslmode') === 'require') {
    url.searchParams.set('sslmode', 'verify-full');
    console.warn(
      '[db] Upgraded sslmode=require to sslmode=verify-full so the Neon ' +
        'certificate is verified now and after pg v9.',
    );
  }

  if (url.searchParams.has('channel_binding')) {
    url.searchParams.delete('channel_binding');
    console.warn(
      '[db] Removed channel_binding=require: node-postgres does not implement ' +
        'channel binding, so it was not being enforced.',
    );
  }

  return url.toString();
}

const connectionString = env('DATABASE_URL');

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is required. Set it to your Postgres connection string, ' +
      'e.g. postgresql://user:pass@host/db?sslmode=verify-full',
  );
}

export const storage = new PostgresStore({
  id: 'dastyare-social-ceo-agent',
  connectionString: normalizeConnectionString(connectionString),
  // Serverless functions are short-lived; 20 pooled connections per instance
  // is far more than a chat bot needs and just exhausts Neon free-tier limits.
  max: 5,
});
