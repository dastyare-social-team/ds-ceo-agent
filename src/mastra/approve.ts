import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { closeDb, db } from './db/client.ts';
import { contentDrafts } from './db/schema.ts';

/**
 * Approval cards: tap a button instead of typing "yes".
 *
 * Typing confirmation works but it is the weakest link in a safety mechanism. It
 * depends on the model correctly recognising a confirmation in free text, on the
 * user phrasing it in a way that parses, and on nothing else in the conversation
 * looking like approval. A button is one unambiguous event carrying the exact id
 * of the thing being approved, so there is nothing to misread.
 *
 * The gate itself does not change: it still lives in publish-approved, which still
 * requires a confirmed_at written by confirm-draft. This only gives that write a
 * reliable trigger.
 */

export const APPROVE_ACTION = 'approve-draft';
export const REJECT_ACTION = 'reject-draft';

/** Card with Approve and Cancel, carrying the draft id as the button value. */
export function approvalCard(draftId: string, summary: string) {
  return {
    type: 'card' as const,
    title: 'Ready to publish?',
    children: [
      { type: 'section' as const, children: [{ type: 'text' as const, content: summary }] },
      {
        type: 'actions' as const,
        children: [
          {
            type: 'button' as const,
            id: APPROVE_ACTION,
            label: 'Publish now',
            value: draftId,
            style: 'primary' as const,
          },
          {
            type: 'button' as const,
            id: REJECT_ACTION,
            label: 'Cancel',
            value: draftId,
            style: 'default' as const,
          },
        ],
      },
    ],
  };
}

/**
 * The newest draft in a chat still waiting on the user, if any.
 *
 * Rejected drafts are excluded explicitly. A cancelled draft has no confirmed_at
 * and no published_at, so the absence checks alone would keep offering it — and
 * the user would be shown an Approve button for something they already cancelled.
 */
export async function pendingDraftFor(
  chatId: string,
): Promise<{ id: string; mediaKind: string; proposals: unknown } | undefined> {
  const rows = await db
    .select({
      id: contentDrafts.id,
      mediaKind: contentDrafts.mediaKind,
      proposals: contentDrafts.proposals,
    })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.chatId, chatId),
        isNull(contentDrafts.confirmedAt),
        isNull(contentDrafts.publishedAt),
        ne(contentDrafts.status, 'rejected'),
      ),
    )
    .orderBy(desc(contentDrafts.createdAt))
    .limit(1);
  return rows[0];
}

/** One line describing what the buttons would publish. */
export function summariseDraft(proposals: unknown): string {
  if (!Array.isArray(proposals) || !proposals.length) return 'A post';
  const platforms = proposals
    .map((p) => (p as { platform?: string }).platform)
    .filter((p): p is string => typeof p === 'string');
  const targets = platforms.length ? platforms.join(', ') : 'the selected platforms';
  return `${proposals.length} post${proposals.length === 1 ? '' : 's'} to ${targets}. Nothing has been published yet.`;
}

/** Marks a draft cancelled so the buttons stop offering it. */
export async function rejectDraft(draftId: string): Promise<boolean> {
  const rows = await db
    .select({ id: contentDrafts.id })
    .from(contentDrafts)
    .where(
      and(eq(contentDrafts.id, draftId), isNull(contentDrafts.publishedAt)),
    )
    .limit(1);
  if (!rows[0]) return false;
  await db
    .update(contentDrafts)
    .set({ status: 'rejected' })
    .where(eq(contentDrafts.id, draftId));
  return true;
}

export { closeDb };