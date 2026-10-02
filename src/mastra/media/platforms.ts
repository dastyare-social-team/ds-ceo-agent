/**
 * Which platforms a piece of media can go to.
 *
 * The rules are a starting point, not the answer. A real publish decision also
 * depends on which accounts are actually connected, and that comes from Zernio
 * at runtime — see `connectedPlatforms` below, which intersects these rules with
 * reality rather than trusting either one alone.
 *
 * Ordering matters when the same platform appears in more than one list: it is
 * resolved by aspect ratio and duration first, then by media kind.
 */

export type MediaKind = 'video' | 'image' | 'voice' | 'text';

export type Platform =
  | 'telegram'
  | 'instagram'
  | 'youtube'
  | 'linkedin'
  | 'tiktok'
  | 'facebook'
  | 'threads'
  | 'pinterest'
  | 'bluesky'
  | 'x';

/**
 * Short-form video: vertical, under a minute. These platforms all treat it as
 * the same asset, which is why they travel together.
 */
const SHORT_VIDEO: Platform[] = ['tiktok', 'instagram', 'youtube', 'linkedin', 'telegram'];

/**
 * Mid-length video, up to TikTok's ten-minute ceiling. Instagram drops out
 * here only because a Reel over a minute wants a different treatment than a
 * feed post, not because it is impossible.
 */
const MEDIUM_VIDEO: Platform[] = ['tiktok', 'youtube', 'linkedin', 'telegram'];

/**
 * Longer video. TikTok is absent deliberately: it caps clips at ten minutes and
 * pushes anything longer into a different upload mode, so a long piece belongs on
 * YouTube and LinkedIn instead of being silently reshaped.
 */
const LONG_VIDEO: Platform[] = ['youtube', 'linkedin', 'facebook', 'telegram'];

/** A still image is the most portable asset there is. */
const IMAGE: Platform[] = ['instagram', 'tiktok', 'telegram', 'pinterest', 'linkedin', 'threads', 'x'];

/**
 * Voice has nowhere else to go. Every platform here wants a video file, and
 * re-encoding a voice note into one to post it elsewhere is not a decision this
 * function is entitled to make on its own.
 */
const VOICE: Platform[] = ['telegram'];

/** Plain text, for comparison: the most widely supported asset of all. */
const TEXT: Platform[] = ['linkedin', 'x', 'threads', 'facebook', 'telegram', 'bluesky'];

export interface MediaFacts {
  kind: MediaKind;
  /** Seconds. Only meaningful for video and voice. */
  seconds?: number;
  /** width/height. Absent when Telegram did not report dimensions. */
  aspectRatio?: number;
}

/** Ten minutes is the boundary: TikTok accepts up to it, not past it. */
const TIKTOK_MAX_SECONDS = 600;
/** Below a minute reads as short-form everywhere. */
const SHORT_FORM_SECONDS = 60;

export function suggestedPlatforms(media: MediaFacts): Platform[] {
  if (media.kind === 'voice') return VOICE;
  if (media.kind === 'text') return TEXT;
  if (media.kind === 'image') return IMAGE;

  const seconds = media.seconds ?? 0;
  if (seconds > TIKTOK_MAX_SECONDS) return LONG_VIDEO;
  if (seconds <= SHORT_FORM_SECONDS) return SHORT_VIDEO;
  return MEDIUM_VIDEO;
}

export interface ConnectedAccount {
  platform: string;
  zernioAccountId: string;
  username: string | null;
  isActive: boolean;
  needsReconnection: boolean;
}

export interface PlatformChoice {
  platform: Platform;
  zernioAccountId: string;
  username: string | null;
}

export interface Availability {
  /** Rules intersect live accounts. This is what may actually be posted to. */
  available: PlatformChoice[];
  /** Suggested, but no connected account. */
  missing: Platform[];
  /** Suggested and connected, but Zernio reports the OAuth token is dead. */
  needsReconnect: { platform: string; username: string | null }[];
  /** Connected and healthy, but not a fit for this asset. */
  notApplicable: { platform: string; username: string | null }[];
}

/**
 * Intersects the rules with what Zernio actually has connected.
 *
 * Both halves matter. Suggesting a platform with no connected account wastes the
 * user's time; posting to a connected account the asset does not fit wastes the
 * platform's. An account needing reconnection is reported rather than used,
 * because Zernio will reject it at publish time.
 */
export function resolveTargets(
  media: MediaFacts,
  accounts: ConnectedAccount[],
): Availability {
  const suggested = suggestedPlatforms(media);
  const suggestedSet = new Set(suggested);

  const available: PlatformChoice[] = [];
  const needsReconnect: { platform: string; username: string | null }[] = [];
  const notApplicable: { platform: string; username: string | null }[] = [];

  for (const account of accounts) {
    const entry = { platform: account.platform, username: account.username };
    if (!suggestedSet.has(account.platform as Platform)) {
      // Still connected and healthy, just wrong for this asset.
      if (account.isActive && !account.needsReconnection) notApplicable.push(entry);
      continue;
    }
    if (account.needsReconnection) {
      // A dead token will fail at publish time, so it is offered for repair
      // rather than as a target.
      needsReconnect.push(entry);
    } else if (account.isActive) {
      available.push({
        platform: account.platform as Platform,
        zernioAccountId: account.zernioAccountId,
        username: account.username,
      });
    } else {
      // Inactive on Zernio: connected once, not usable now.
      notApplicable.push(entry);
    }
  }

  const availablePlatforms = new Set(available.map((a) => a.platform));
  const missing = suggested.filter((p) => !availablePlatforms.has(p));

  return { available, missing, needsReconnect, notApplicable };
}

/** Character limits worth checking before a caption is shown for approval. */
const CAPTION_LIMITS: Partial<Record<Platform, number>> = {
  telegram: 4096,
  // Captions, not the 2200-character feed post limit.
  instagram: 2200,
  linkedin: 3000,
  tiktok: 2200,
  threads: 500,
  x: 280,
  bluesky: 300,
};

/**
 * Flags captions that a platform will truncate or reject.
 *
 * Reported rather than enforced: silently cutting someone's caption is worse than
 * telling them it is too long and letting them choose.
 */
export function captionWarnings(
  content: string,
  platforms: Platform[],
): { platform: Platform; limit: number; length: number }[] {
  const length = content.length;
  return platforms
    .map((platform) => ({ platform, limit: CAPTION_LIMITS[platform] ?? 2200, length }))
    .filter((entry) => entry.limit !== undefined && entry.length > entry.limit);
}

/** Renders the availability result as the short list the user approves. */
export function describeTargets(availability: Availability): string {
  const lines: string[] = [];
  if (availability.available.length) {
    lines.push(
      `Can post to: ${availability.available
        .map((a) => (a.username ? `${a.platform} (@${a.username})` : a.platform))
        .join(', ')}`,
    );
  }
  if (availability.missing.length) {
    lines.push(`No connected account for: ${availability.missing.join(', ')}`);
  }
  if (availability.needsReconnect.length) {
    lines.push(
      `Reconnect before posting: ${availability.needsReconnect
        .map((a) => `${a.platform}${a.username ? ` (@${a.username})` : ''}`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}