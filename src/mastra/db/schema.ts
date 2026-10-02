import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Application-owned tables, separate from Mastra's.
 *
 * Mastra provisions its own schema (mastra_threads, mastra_messages, and ~40
 * others) idempotently on boot, with no migrations. These tables are different:
 * they hold secrets that must be versioned and rotated, so they are managed by
 * drizzle-kit with real migrations and reviewed SQL. Letting a tool
 * auto-create-and-alter schema next to credentials is not a trade worth making.
 *
 * Naming: `app_` prefix, so nothing can collide with a Mastra-managed table.
 */

/**
 * One credential, encrypted at rest.
 *
 * API keys change — a Zernio workspace key gets revoked and reissued, a Supabase
 * key pair gets rotated — so these are versioned rows rather than a single
 * mutable config row. A revoked key is kept as `revoked_at` so the audit trail
 * survives, and the current version is the newest non-revoked row per scope.
 *
 * The ciphertext is `iv:authTag:ciphertext`, base64url each part, from
 * AES-256-GCM. `keyVersion` is here so the master key itself can be rotated
 * later without a data migration: old rows keep decrypting under the old
 * version until a background re-encrypt runs.
 */
export const credentials = pgTable(
  'app_credentials',
  {
    id: text('id').primaryKey(),
    /** Which integration this belongs to: 'zernio' | 'supabase-s3' | 'speechmatics'. */
    scope: text('scope').notNull(),
    /**
     * Which logical account inside that scope. Zernio keys are per workspace and
     * the agent switches between them by chat, so "the zernio key" is not a
     * singleton. Defaults to 'default' for single-account integrations.
     */
    account: text('account').notNull().default('default'),
    /** Human label shown when the agent lists available accounts. */
    label: text('label'),
    /** base64url(iv):base64url(authTag):base64url(ciphertext), AES-256-GCM. */
    ciphertext: text('ciphertext').notNull(),
    /** Which master key encrypted this row, so the key can be rotated. */
    keyVersion: integer('key_version').notNull().default(1),
    /** Set when the key is superseded or revoked. Null means live. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One live credential per (scope, account). Revoked rows are excluded so the
    // history is kept without blocking a fresh key from being stored.
    uniqueIndex('app_credentials_scope_account_live').on(
      table.scope,
      table.account,
      sql`(${table.revokedAt} IS NULL)`,
    ),
    index('app_credentials_scope_idx').on(table.scope),
  ],
);

/**
 * A draft produced by the agent, awaiting the user's confirmation.
 *
 * Nothing is ever published without a row here that the user has approved. The
 * draft holds the caption per platform and the Zernio draft post id, so "confirm"
 * is a lookup rather than a re-generation that might differ from what was shown.
 */
export const contentDrafts = pgTable(
  'app_content_drafts',
  {
    id: text('id').primaryKey(),
    /** Owning Telegram chat, so drafts are listed per conversation. */
    chatId: text('chat_id').notNull(),
    /** 'video' | 'image' | 'voice' | 'text' — drives the platform rules. */
    mediaKind: text('media_kind').notNull(),
    /** Public HTTPS URL in S3, for the media the post attaches. */
    mediaUrl: text('media_url'),
    /** Transcript or source text the caption was drafted from. */
    sourceText: text('source_text'),
    /** Per-platform caption and options, as the agent proposed them. */
    proposals: jsonb('proposals').notNull(),
    /** Zernio draft post ids, once created. */
    zernioDraftIds: jsonb('zernio_draft_ids'),
    status: text('status').notNull().default('awaiting_confirm'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the user approved. Null until they do. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (table) => [index('app_content_drafts_chat_idx').on(table.chatId, table.createdAt)],
);

/**
 * Mirror of Zernio's connected accounts.
 *
 * Cached because `accounts_list` is needed on nearly every publish decision and
 * the platform set changes only when a human reconnects something. The cache is
 * what lets the agent answer "where can I post?" without a network round trip,
 * and it is refreshed on demand rather than trusted blindly — Zernio is the
 * authority at publish time and a stale mirror must never be the reason a post
 * fails.
 */
export const zernioAccounts = pgTable(
  'app_zernio_accounts',
  {
    /** Zernio's account id, from accounts_list. */
    zernioAccountId: text('zernio_account_id').primaryKey(),
    /** 'zernio' | 'telegram' | 'instagram' | ... */
    platform: text('platform').notNull(),
    username: text('username'),
    displayName: text('display_name'),
    profileUrl: text('profile_url'),
    isActive: boolean('is_active').notNull().default(true),
    /** Zernio flags this when the stored OAuth token is dead. */
    needsReconnection: boolean('needs_reconnection').notNull().default(false),
    /** Which credential row produced this mirror, for multi-workspace setups. */
    credentialId: text('credential_id').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('app_zernio_accounts_platform_idx').on(table.platform),
    index('app_zernio_accounts_credential_idx').on(table.credentialId),
  ],
);

export type CredentialRow = typeof credentials.$inferSelect;
export type ContentDraftRow = typeof contentDrafts.$inferSelect;
export type ZernioAccountRow = typeof zernioAccounts.$inferSelect;