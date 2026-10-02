import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  db,
  listCredentialSlots,
  revokeCredential,
  saveCredential,
  type CredentialScope,
} from '../db/client.ts';
import { contentDrafts } from '../db/schema.ts';
import { formatExcerpts, retrieveStory } from '../story/retrieve.ts';
import { publishPost, listConnectedAccounts } from '../zernio/mcp.ts';
import { uploadMedia, verifyPublicUrl, type MediaKind } from '../media/storage.ts';
import {
  captionWarnings,
  describeTargets,
  resolveTargets,
  type MediaFacts,
  type Platform,
} from '../media/platforms.ts';

/**
 * The agent's tools for publishing through Zernio.
 *
 * The confirm gate is enforced here, in code, rather than left to the model. A
 * prompt instruction like "always ask before publishing" is one hallucination or
 * one misunderstood turn away from posting to accounts real people follow, and
 * nothing in the conversation afterwards can undo that. `publishApprovedDraft`
 * refuses unless a row exists with `confirmed_at` set by a human, so the worst a
 * confused model can do is waste a turn.
 */

const SCOPES = ['zernio', 'supabase-s3', 'speechmatics'] as const;

/** Looks up the live Telegram chat, so a draft is owned by the conversation. */
function chatIdOf(context: unknown): string {
  const ctx = context as { resourceId?: string; threadId?: string };
  return ctx?.resourceId ?? ctx?.threadId ?? 'unknown';
}

// --- credentials ------------------------------------------------------------

export const storeCredential = createTool({
  id: 'store-credential',
  description:
    'Store an API key for an integration, encrypted in the database. Use when the user pastes a key ' +
    'or says they have a new one. Zernio keys are per workspace, so pass an account label when they ' +
    'have more than one. Storing a new key for the same scope and account supersedes the old one.',
  inputSchema: z.object({
    scope: z.enum(SCOPES).describe('Which integration the key belongs to'),
    secret: z.string().min(8).describe('The key itself. Never echoed back.'),
    account: z.string().optional().describe('Account label, defaults to "default"'),
    label: z.string().optional().describe('Human label for listings'),
  }),
  execute: async (input) => {
    const saved = await saveCredential({
      scope: input.scope as CredentialScope,
      account: input.account,
      label: input.label,
      secret: input.secret,
    });
    return {
      stored: true,
      scope: saved.scope,
      account: saved.account,
      note: 'Key encrypted at rest. The previous key for this slot was revoked, not deleted.',
    };
  },
});

export const listCredentials = createTool({
  id: 'list-credentials',
  description:
    'List which credential slots exist, without revealing any secret. Use to answer "which Zernio accounts ' +
    'are configured?" or to check whether a key is missing before attempting a publish.',
  inputSchema: z.object({ scope: z.enum(SCOPES).optional() }),
  execute: async (input) => {
    const scopes = input.scope ? [input.scope as CredentialScope] : [...SCOPES];
    const out: Record<string, unknown> = {};
    for (const scope of scopes) {
      const slots = await listCredentialSlots(scope);
      out[scope] = slots.map((s) => ({ account: s.account, label: s.label, since: s.createdAt }));
    }
    return out;
  },
});

export const revokeStoredCredential = createTool({
  id: 'revoke-credential',
  description:
    'Revoke a stored credential. Revoked keys are kept as a record of which key was live, so this is ' +
    'the right way to retire a leaked key without losing the audit trail.',
  inputSchema: z.object({
    scope: z.enum(SCOPES),
    account: z.string().optional(),
  }),
  execute: async (input) => ({
    revoked: await revokeCredential(input.scope as CredentialScope, input.account),
  }),
});

// --- connected accounts -----------------------------------------------------

export const listSocialAccounts = createTool({
  id: 'list-social-accounts',
  description:
    'Ask Zernio which social accounts are currently connected. Call this before proposing where to ' +
    'post: the agent must never suggest a platform the user has not connected. Returns platform, ' +
    'username and id for each one.',
  inputSchema: z.object({ zernioAccount: z.string().optional().describe('Credential slot, default "default"') }),
  execute: async (input) => {
    const summary = await listConnectedAccounts(input.zernioAccount ?? 'default');
    return { summary };
  },
});

// --- story retrieval --------------------------------------------------------

export const recallStory = createTool({
  id: 'recall-story',
  description:
    "Retrieve the founder's own notes from his Obsidian vault: origin story, positioning, audience and " +
    'explicit brand-voice rules. Call this before writing any caption. Captions drawn from these notes ' +
    'sound like him; captions written from the model alone sound like a template. Cite which note you used.',
  inputSchema: z.object({
    query: z.string().describe('What the post is about, in a few words'),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  execute: async (input) => {
    const excerpts = await retrieveStory(input.query, input.limit ?? 4);
    return { context: formatExcerpts(excerpts), sources: excerpts.map((e) => e.source) };
  },
});

// --- media ------------------------------------------------------------------

export const prepareMedia = createTool({
  id: 'prepare-media',
  description:
    'Work out where a piece of media can be posted, given what is actually connected. Returns the ' +
    'targets that are both a fit and usable, plus anything missing or needing a reconnect. Call this ' +
    'before proposing a caption, and always show the user these targets.',
  inputSchema: z.object({
    kind: z.enum(['video', 'image', 'voice', 'text']),
    seconds: z.number().optional().describe('Duration, for video or voice'),
    accounts: z
      .array(
        z.object({
          platform: z.string(),
          zernioAccountId: z.string(),
          username: z.string().nullable().optional(),
          isActive: z.boolean().optional(),
          needsReconnection: z.boolean().optional(),
        }),
      )
      .describe('Accounts from list-social-accounts'),
  }),
  execute: async (input) => {
    const media: MediaFacts = { kind: input.kind, seconds: input.seconds };
    const availability = resolveTargets(
      media,
      input.accounts.map((a) => ({
        platform: a.platform,
        zernioAccountId: a.zernioAccountId,
        username: a.username ?? null,
        isActive: a.isActive ?? true,
        needsReconnection: a.needsReconnection ?? false,
      })),
    );
    return {
      summary: describeTargets(availability),
      targets: availability.available,
      missing: availability.missing,
      needsReconnect: availability.needsReconnect,
      notApplicable: availability.notApplicable,
    };
  },
});

export const publishMedia = createTool({
  id: 'publish-media',
  description:
    'Upload media to storage so Zernio can fetch it, and return a public URL. Zernio requires a publicly ' +
    'reachable HTTPS URL and fetches it server-side at publish time, which is what allows a post to be ' +
    'scheduled rather than uploaded through a browser.',
  inputSchema: z.object({
    kind: z.enum(['video', 'image', 'gif', 'document']),
    /** Base64 or data URL of the bytes, as read from the Telegram attachment. */
    data: z.string().describe('Base64 file bytes'),
  }),
  execute: async (input) => {
    const bytes = Uint8Array.from(Buffer.from(input.data, 'base64'));
    const stored = await uploadMedia(bytes, input.kind as MediaKind);
    const check = await verifyPublicUrl(stored.url);
    return {
      url: stored.url,
      key: stored.key,
      bytes: stored.bytes,
      publiclyFetchable: check.ok,
      warning: check.ok
        ? undefined
        : `Zernio will not be able to fetch this URL (HTTP ${check.status}). Do not publish against it.`,
    };
  },
});

// --- the confirm gate -------------------------------------------------------

/**
 * Records what the agent intends to do, and returns it for approval.
 *
 * The reply text is stored verbatim so that confirming replays exactly what the
 * user saw. Regenerating a caption at publish time would mean the thing approved
 * and the thing published could differ, which defeats the point of asking.
 */
export const proposeContent = createTool({
  id: 'propose-content',
  description:
    'Record a post proposal for the user to approve. Nothing is published by this call. Always show the ' +
    'user the caption, the targets and the timing, then wait for an explicit yes before calling ' +
    'publish-approved. Do not publish on your own initiative.',
  inputSchema: z.object({
    chatId: z.string().optional(),
    mediaKind: z.enum(['video', 'image', 'voice', 'text']),
    mediaUrl: z.string().optional(),
    sourceText: z.string().optional(),
    proposals: z
      .array(
        z.object({
          platform: z.string(),
          zernioAccountId: z.string().optional(),
          caption: z.string(),
          title: z.string().optional(),
          publishNow: z.boolean().optional(),
          scheduleMinutes: z.number().int().optional(),
        }),
      )
      .describe('One entry per target platform'),
  }),
  execute: async (input, context) => {
    const warnings = captionWarnings(
      input.proposals[0]?.caption ?? '',
      input.proposals.map((p) => p.platform as Platform),
    );

    const id = crypto.randomUUID();
    await db.insert(contentDrafts).values({
      id,
      chatId: input.chatId ?? chatIdOf(context),
      mediaKind: input.mediaKind,
      mediaUrl: input.mediaUrl ?? null,
      sourceText: input.sourceText ?? null,
      proposals: input.proposals,
      status: 'awaiting_confirm',
    });

    return {
      draftId: id,
      awaitingConfirmation: true,
      targets: input.proposals.map((p) => p.platform),
      tooLong: warnings.map((w) => `${w.platform} (${w.length} chars, limit ${w.limit})`),
      nextStep:
        'Show the user the caption and targets verbatim and ask for an explicit yes. ' +
        'Only after they say yes, call publish-approved with this draftId.',
    };
  },
});

/**
 * The only path that publishes.
 *
 * Refuses unless the draft exists and the user has confirmed it. The
 * `confirmed_at` check is the whole safety property: a model that decides to
 * publish without asking cannot manufacture that timestamp.
 */
export const publishApproved = createTool({
  id: 'publish-approved',
  description:
    'Publish a draft the user has explicitly approved. This is the only tool that creates anything at ' +
    'Zernio, and it refuses unless the draft was approved first. Never call this before the user has ' +
    'said yes to the exact caption and targets shown in propose-content.',
  inputSchema: z.object({
    draftId: z.string().describe('The id returned by propose-content'),
    confirmedByUser: z.boolean().describe('Must be true. Set only when the user has said yes.'),
    zernioAccount: z.string().optional(),
  }),
  execute: async (input) => {
    if (input.confirmedByUser !== true) {
      return {
        published: false,
        reason:
          'The user has not approved this draft. Show it to them and ask first — ' +
          'confirm-approved is refused until they say yes.',
      };
    }

    const rows = await db
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.id, input.draftId))
      .limit(1);
    const draft = rows[0];
    if (!draft) return { published: false, reason: 'No such draft. Propose it first.' };

    if (draft.status === 'published') {
      return { published: true, alreadyPublished: true, postIds: draft.zernioPostIds };
    }
    if (!draft.confirmedAt) {
      return {
        published: false,
        reason: 'This draft has not been confirmed. Nothing has been posted.',
      };
    }

    const proposals = draft.proposals as {
      platform: string;
      zernioAccountId?: string;
      caption: string;
      title?: string;
      publishNow?: boolean;
      scheduleMinutes?: number;
    }[];

    const results: { platform: string; text: string; isError: boolean }[] = [];
    for (const proposal of proposals) {
      results.push({
        platform: proposal.platform,
        ...(await publishPost(
          {
            content: proposal.caption,
            platform: proposal.platform,
            accountId: proposal.zernioAccountId,
            mediaUrls: draft.mediaUrl ?? undefined,
            title: proposal.title,
            publishNow: proposal.publishNow !== false,
            scheduleMinutes: proposal.scheduleMinutes,
          },
          input.zernioAccount ?? 'default',
        )),
      });
    }

    const failed = results.filter((r) => r.isError);
    if (!failed.length) {
      await db
        .update(contentDrafts)
        .set({ status: 'published', publishedAt: new Date() })
        .where(eq(contentDrafts.id, draft.id));
    }

    return {
      published: failed.length === 0,
      partial: failed.length > 0 && results.length > failed.length,
      results,
      note: failed.length
        ? 'Some platforms failed. Check the Zernio dashboard; nothing was retried automatically.'
        : undefined,
    };
  },
});

/** Marks a draft confirmed. Separate from publishing so approval is a fact, not a side effect. */
export const confirmDraft = createTool({
  id: 'confirm-draft',
  description:
    'Record that the user approved a draft. Call this only after they explicitly say yes to the caption ' +
    'and targets you showed them.',
  inputSchema: z.object({ draftId: z.string() }),
  execute: async (input) => {
    const rows = await db
      .select({ id: contentDrafts.id })
      .from(contentDrafts)
      .where(and(eq(contentDrafts.id, input.draftId), isNull(contentDrafts.publishedAt)))
      .limit(1);
    if (!rows[0]) return { confirmed: false, reason: 'No such unpublished draft.' };
    await db
      .update(contentDrafts)
      .set({ confirmedAt: new Date(), status: 'confirmed' })
      .where(eq(contentDrafts.id, input.draftId));
    return { confirmed: true };
  },
});

/** The newest drafts for a chat, so the user can find one to approve. */
export const listPendingDrafts = createTool({
  id: 'list-pending-drafts',
  description: 'List proposals still awaiting the user’s approval, most recent first.',
  inputSchema: z.object({
    chatId: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  execute: async (input, context) => {
    const rows = await db
      .select({
        id: contentDrafts.id,
        mediaKind: contentDrafts.mediaKind,
        mediaUrl: contentDrafts.mediaUrl,
        proposals: contentDrafts.proposals,
        status: contentDrafts.status,
        createdAt: contentDrafts.createdAt,
      })
      .from(contentDrafts)
      .where(eq(contentDrafts.chatId, input.chatId ?? chatIdOf(context)))
      .orderBy(desc(contentDrafts.createdAt))
      .limit(input.limit ?? 5);
    return { drafts: rows };
  },
});

export const publishingTools = {
  storeCredential,
  listCredentials,
  revokeStoredCredential,
  listSocialAccounts,
  recallStory,
  prepareMedia,
  publishMedia,
  proposeContent,
  confirmDraft,
  publishApproved,
  listPendingDrafts,
};

export { closeDb };