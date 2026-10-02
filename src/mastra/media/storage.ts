import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getCredentialSecret } from '../db/client.ts';

/**
 * Publishes media to S3-compatible storage and hands back a public HTTPS URL.
 *
 * Zernio's MCP can only receive media through a browser upload link, which an
 * agent cannot use: it would mean asking you to open a page and drop a file for
 * every post. Zernio's REST layer documents that `mediaItems[].url` must be a
 * "publicly reachable HTTPS url" which it fetches server-side, so the bot
 * uploads once and Zernio pulls from the URL. That removes the browser step
 * entirely and lets a Telegram video become a scheduled post unattended.
 *
 * Three constraints from Zernio's own schema drive the shape of this:
 *
 *   - `type` is inferred from the URL extension, and a type that contradicts the
 *     extension is rejected with 400. So keys must end in a real extension and
 *     `contentType` must agree with it.
 *   - The URL must be genuinely public. Its SSRF guard rejects private and
 *     localhost targets, so a presigned URL pointing at a private bucket would
 *     be refused as well as expiring before a scheduled post fires.
 *   - Media is fetched later, at publish time. A short-lived signed URL would
 *     break every scheduled post, so this returns unsigned public URLs.
 */

const BUCKET = 'ds-ceo-agent';
/** Supabase's public object path. The S3 endpoint itself is auth-only (403 unsigned). */
const PUBLIC_BASE = `https://owxotllfofaloaocalyp.storage.supabase.co/storage/v1/object/public/${BUCKET}`;
const REGION = 'ap-northeast-2';
const S3_ENDPOINT = 'https://owxotllfofaloaocalyp.storage.supabase.co/storage/v1/s3';

/** Telegram's own bot-API download ceiling for files. */
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Extension and content type must agree, because Zernio reads the extension and
 * rejects a contradiction with 400. Telegram's file_name is unreliable for this
 * (it is often blank), so the media kind drives the pair.
 */
const MEDIA_TYPES: Record<string, { extension: string; contentType: string }> = {
  video: { extension: 'mp4', contentType: 'video/mp4' },
  image: { extension: 'jpg', contentType: 'image/jpeg' },
  gif: { extension: 'gif', contentType: 'image/gif' },
  document: { extension: 'pdf', contentType: 'application/pdf' },
};

export type MediaKind = keyof typeof MEDIA_TYPES;

export interface StoredMedia {
  url: string;
  key: string;
  bytes: number;
  contentType: string;
}

export function isMediaKind(value: string): value is MediaKind {
  return value in MEDIA_TYPES;
}

/**
 * Uploads bytes and returns the public URL Zernio will fetch.
 *
 * The key carries the kind in its path as well as its extension, so a bucket is
 * browsable by kind and a mis-typed content type is obvious in the console.
 */
export async function uploadMedia(
  bytes: Uint8Array,
  kind: MediaKind,
  options: { prefix?: string } = {},
): Promise<StoredMedia> {
  if (bytes.byteLength === 0) throw new Error('Media was empty');
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `Media is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is 20MB`,
    );
  }

  const accessKeyId = await getCredentialSecret('supabase-s3', 'default-access-key');
  const secretAccessKey = await getCredentialSecret('supabase-s3', 'default-secret');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Supabase S3 credentials are not stored. Add them first, then retry.',
    );
  }

  const { extension, contentType } = MEDIA_TYPES[kind];
  // A date prefix keeps the bucket navigable and stops keys colliding between
  // uploads in the same second.
  const prefix = options.prefix ?? `media/${new Date().toISOString().slice(0, 10)}`;
  const key = `${prefix}/${crypto.randomUUID()}.${extension}`;

  const client = new S3Client({
    region: REGION,
    endpoint: S3_ENDPOINT,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      // Public read is required for Zernio to fetch it. The bucket is a media
      // store for posts that are public by definition, so this is not a secret.
      ACL: 'public-read',
    }),
  );

  return { url: `${PUBLIC_BASE}/${key}`, key, bytes: bytes.byteLength, contentType };
}

/** Confirms the public URL really is fetchable, before a draft depends on it. */
export async function verifyPublicUrl(url: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
  return { ok: response.ok, status: response.status };
}