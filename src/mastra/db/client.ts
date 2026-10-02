import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../env.ts';
import * as schema from './schema.ts';
import { decryptSecret, encryptSecret } from './crypto.ts';
import { credentials, zernioAccounts } from './schema.ts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

/**
 * Postgres access for the app's own tables, with credential helpers.
 *
 * Separate from `db.ts`, which hands a `PostgresStore` to Mastra. Two clients,
 * two concerns: Mastra manages its ~40 tables itself and must not be pointed at
 * these, and this pool wants `sslmode=verify-full` plus drizzle's typed queries.
 */

/**
 * The pool is created lazily and cached on globalThis.
 *
 * Module state does not survive a serverless invocation, but a warm instance
 * re-evaluates modules per request under some runtimes. Vercel freezes the
 * function once the webhook returns, so the pool is deliberately not put on
 * globalThis for reuse *between* requests — one pool per invocation is what
 * avoids the exhaustion that a cached pool with idle clients causes here.
 */
let pool: Pool | undefined;

function dbPool(): Pool {
  if (pool) return pool;
  const connectionString = env('DATABASE_URL');
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new Pool({
    connectionString,
    max: 2,
    // The serverless client closes sockets between invocations; a stale keepalive
    // is the classic source of "Connection terminated unexpectedly" on Postgres.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: true },
  });
  return pool;
}

export const db = drizzle(dbPool(), { schema });

/** Closes the pool. Used by scripts and tests; the serverless runtime never calls it. */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export type CredentialScope = 'zernio' | 'supabase-s3' | 'speechmatics';

export interface StoredCredential {
  id: string;
  scope: CredentialScope;
  account: string;
  label: string | null;
  createdAt: Date;
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Stores a credential, replacing any live one for the same scope and account.
 *
 * The previous row is revoked rather than deleted. A key that was in use until a
 * minute ago is exactly what you want to find when auditing why a post went to
 * the wrong place, and the partial unique index keeps only one live row per slot.
 */
export async function saveCredential(input: {
  scope: CredentialScope;
  account?: string;
  label?: string;
  secret: string;
}): Promise<StoredCredential> {
  const account = input.account ?? 'default';
  const existing = await liveCredentialId(input.scope, account);
  if (existing) {
    await db
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(eq(credentials.id, existing));
  }
  const id = newId();
  const label = input.label ?? null;
  await db.insert(credentials).values({
    id,
    scope: input.scope,
    account,
    label,
    ciphertext: encryptSecret(input.secret),
    keyVersion: 1,
  });
  return { id, scope: input.scope, account, label, createdAt: new Date() };
}

async function liveCredentialId(scope: string, account: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.scope, scope),
        eq(credentials.account, account),
        isNull(credentials.revokedAt),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/**
 * The live credential secret for a slot, or undefined.
 *
 * Returns undefined rather than throwing when the slot is empty: callers decide
 * whether a missing Zernio key should fail the publish or fall back to asking the
 * user to add one, and that is a product decision, not a storage one.
 */
export async function getCredentialSecret(
  scope: CredentialScope,
  account = 'default',
): Promise<string | undefined> {
  const rows = await db
    .select({ ciphertext: credentials.ciphertext })
    .from(credentials)
    .where(
      and(
        eq(credentials.scope, scope),
        eq(credentials.account, account),
        isNull(credentials.revokedAt),
      ),
    )
    .orderBy(desc(credentials.createdAt))
    .limit(1);
  return rows[0] ? decryptSecret(rows[0].ciphertext) : undefined;
}

export async function getCredentialId(
  scope: CredentialScope,
  account = 'default',
): Promise<string | undefined> {
  return liveCredentialId(scope, account);
}

/** Credential slots for an integration, for the agent's "which accounts?" reply. */
export async function listCredentialSlots(scope: CredentialScope): Promise<
  { account: string; label: string | null; credentialId: string; createdAt: Date }[]
> {
  return db
    .select({
      account: credentials.account,
      label: credentials.label,
      credentialId: credentials.id,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .where(and(eq(credentials.scope, scope), isNull(credentials.revokedAt)))
    .orderBy(credentials.account);
}

export async function revokeCredential(scope: CredentialScope, account = 'default'): Promise<boolean> {
  const id = await liveCredentialId(scope, account);
  if (!id) return false;
  await db.update(credentials).set({ revokedAt: new Date() }).where(eq(credentials.id, id));
  return true;
}

/**
 * Replaces the cached account mirror with a fresh snapshot.
 *
 * Delete-then-insert in one transaction: a partial upsert would leave accounts
 * that were disconnected at Zernio still listed here as available, and the agent
 * would offer a platform the user can no longer post to.
 */
export async function replaceZernioAccounts(
  credentialId: string,
  accounts: {
    id: string;
    platform: string;
    username?: string;
    displayName?: string;
    profileUrl?: string;
    isActive?: boolean;
    needsReconnection?: boolean;
  }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(zernioAccounts)
      .where(sql`${zernioAccounts.credentialId} = ${credentialId}`);
    if (accounts.length === 0) return;
    await tx.insert(zernioAccounts).values(
      accounts.map((a) => ({
        zernioAccountId: a.id,
        platform: a.platform,
        username: a.username ?? null,
        displayName: a.displayName ?? null,
        profileUrl: a.profileUrl ?? null,
        isActive: a.isActive ?? true,
        needsReconnection: a.needsReconnection ?? false,
        credentialId,
        syncedAt: new Date(),
      })),
    );
  });
}

/** Cached connected accounts, optionally narrowed to one platform. */
export async function listZernioAccounts(platform?: string): Promise<
  {
    zernioAccountId: string;
    platform: string;
    username: string | null;
    displayName: string | null;
    isActive: boolean;
    needsReconnection: boolean;
  }[]
> {
  const base = db.select().from(zernioAccounts);
  const rows = await (platform
    ? base.where(eq(zernioAccounts.platform, platform))
    : base);
  return rows.map((r) => ({
    zernioAccountId: r.zernioAccountId,
    platform: r.platform,
    username: r.username,
    displayName: r.displayName,
    isActive: r.isActive,
    needsReconnection: r.needsReconnection,
  }));
}