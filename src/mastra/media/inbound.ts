import { uploadMedia, verifyPublicUrl, type MediaKind } from './storage.ts';

/**
 * Inbound media from Telegram: video, image, document.
 *
 * This is the missing link in the publish flow. Without it, a video message fell
 * through to the model as an `[Attached file: IMG_2515.MP4]` placeholder, and a
 * text-only model handed a filename does the only thing it can: confabulate. It
 * proposed platforms nobody had connected and invented engagement statistics
 * about them. A model cannot decline what it believes it can see.
 *
 * So the bytes are taken here, uploaded, and the model is told the truth: there
 * is a public URL, and there is no way for it to see what is in the file. It has
 * to ask for a description rather than invent one.
 *
 * Telegram's own limits apply: a bot can download at most 20MB, which is the same
 * ceiling the uploader enforces, so the failure is reported here rather than as an
 * opaque 400 from the API.
 */

export type InboundKind = 'video' | 'image' | 'document';

/** Adapter attachment types that carry publishable media. */
const KIND_BY_TYPE: Record<string, InboundKind> = {
  video: 'video',
  image: 'image',
  document: 'document',
};

export interface InboundAttachment {
  type?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  fetchData?: () => Promise<unknown>;
}

export interface InboundMedia {
  kind: InboundKind;
  bytes: number;
  fileName: string | null;
  /** Public HTTPS URL Zernio will fetch at publish time. */
  url: string;
  width: number | null;
  height: number | null;
  publiclyFetchable: boolean;
}

/**
 * True for a message carrying video, an image or a document.
 *
 * Audio is excluded on purpose: voice is transcribed, not uploaded, and that path
 * already exists in voice.ts.
 */
export function isMediaMessage(message: unknown): boolean {
  const m = message as { text?: unknown; attachments?: unknown };
  if (typeof m?.text === 'string' && m.text.trim().length > 0) return false;
  const attachments = (m?.attachments ?? []) as InboundAttachment[];
  return attachments.some(
    (a) => (a?.type ?? '') in KIND_BY_TYPE && typeof a?.fetchData === 'function',
  );
}

export function mediaKindOf(message: unknown): InboundKind | undefined {
  const attachments = ((message as { attachments?: unknown })?.attachments ?? []) as InboundAttachment[];
  return attachments.find((a) => (a?.type ?? '') in KIND_BY_TYPE)?.type as InboundKind | undefined;
}

async function toBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof (data as Blob).arrayBuffer === 'function') {
    return new Uint8Array(await (data as Blob).arrayBuffer());
  }
  throw new Error(`Unexpected media payload: ${typeof data}`);
}

/**
 * Downloads a Telegram attachment and publishes it to storage.
 *
 * The upload happens here rather than inside the model call so the agent is never
 * the thing holding a 20MB buffer, and so a failed upload is reported to the user
 * as an upload failure rather than as a mysterious refusal to caption anything.
 */
export async function publishInboundMedia(message: unknown): Promise<InboundMedia> {
  const attachments = ((message as { attachments?: unknown })?.attachments ?? []) as InboundAttachment[];
  const attachment = attachments.find((a) => (a?.type ?? '') in KIND_BY_TYPE && a?.fetchData);
  if (!attachment?.fetchData) throw new Error('No video, image or document on the message');

  const kind = attachment.type as InboundKind;
  const bytes = await toBytes(await attachment.fetchData());
  if (bytes.byteLength === 0) throw new Error('The uploaded file was empty');

  const stored = await uploadMedia(bytes, kind as MediaKind);
  const check = await verifyPublicUrl(stored.url);

  return {
    kind,
    bytes: bytes.byteLength,
    fileName: attachment.name ?? null,
    url: stored.url,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    publiclyFetchable: check.ok,
  };
}

/**
 * The text the model receives instead of the file.
 *
 * The wording is doing real work. Saying "you cannot see this file" is what stops
 * the model writing a confident caption about a video it has never watched; saying
 * only "here is a URL" invites it to describe the URL. It is told what it does not
 * know, what it does have, and the one thing that would unblock it.
 */
export function describeInboundMedia(media: InboundMedia): string {
  const mb = (media.bytes / 1024 / 1024).toFixed(1);
  const shape = media.width && media.height ? ` (${media.width}x${media.height})` : '';
  const name = media.fileName ? ` named ${media.fileName}` : '';

  return [
    `The user sent a ${media.kind}${name} of ${mb}MB${shape}.`,
    `It is uploaded and reachable at: ${media.url}`,
    media.publiclyFetchable ? '' : 'That URL is NOT publicly fetchable, so do not publish against it.',
    '',
    'You cannot see or hear the contents of this file — you have only its name and size.',
    'Do NOT write a caption, invent a topic for it, or state platform engagement figures.',
    'Ask the user in one line what the file shows, then use that to draft.',
    'Before proposing any platform, call list-social-accounts to see what is actually connected.',
    'Only those connected accounts are options — never suggest a platform the user has not connected.',
  ]
    .filter(Boolean)
    .join('\n');
}
/**
 * The message the model receives for uploaded media.
 *
 * Text is replaced with the honest description, and *the published kind* is
 * dropped from the attachments — not every media attachment. A video sent with a
 * cover photo keeps the photo: an image is something a vision-capable model can
 * genuinely read, so discarding it would throw away real context. The video is
 * different, because nothing can look at a URL, and leaving its placeholder in
 * place is precisely what invites the model to describe a file it has not seen —
 * and gets that description written into memory where it poisons later turns.
 */
export function withMediaSummary(
  message: unknown,
  summary: string,
  publishedKind?: InboundKind,
): unknown {
  const original = (message ?? {}) as { attachments?: unknown };
  const attachments = (original.attachments ?? []) as InboundAttachment[];
  return {
    ...original,
    text: summary,
    attachments: publishedKind
      ? attachments.filter((a) => a?.type !== publishedKind)
      : attachments,
  };
}
