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

/**
 * Adapter attachment types that can carry publishable media.
 *
 * `file` matters as much as `video`: the Telegram adapter types a *document* as
 * `file`, not `document`, so an .mp4 sent the way a person naturally sends one —
 * as a File/Document, which is also what you are told to do when an upload fails —
 * arrived typed `file` and was not recognised at all. The message then fell
 * through to the model as an `[Attached file: …]` placeholder, and the model
 * reported it could not see the bytes. That is a self-reinforcing loop: ask the
 * user to resend as a document, fail to recognise the document, ask again.
 *
 * `voice_note` and `animation` are typed `video` by the adapter, so they arrive
 * here too; a round video is handled like any other video.
 */
/**
 * Attachment types the adapter produces that are never publishable media here.
 *
 * `audio` is the important one: voice is transcribed on its own path, and letting
 * a filename override the adapter's label would route a voice note into the
 * upload pipeline. `sticker` is an image by mime type but is not a photo anyone
 * sent to be posted.
 */
const NOT_MEDIA = new Set(['audio', 'voice', 'sticker', 'animation']);

/**
 * Resolves an attachment to a publishable kind.
 *
 * The adapter's label wins whenever it is meaningful. A Telegram *document* is
 * typed `file` and says nothing useful about its contents, so that one is resolved
 * from the mime type and then the extension — Zernio infers the media type from
 * the URL extension and rejects a contradiction with a 400, so a mislabelled kind
 * would upload an .mp4 as a .pdf and fail at the far end of the publish pipeline.
 */
export function kindForAttachment(attachment: InboundAttachment): InboundKind | undefined {
  const type = attachment?.type ?? '';

  if (NOT_MEDIA.has(type)) return undefined;
  if (type === 'video') return 'video';
  if (type === 'image') return 'image';
  if (type === 'document') return 'document';

  // `file`, or anything unrecognised: fall back to content signals.
  const mime = (attachment?.mimeType ?? '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';

  const name = (attachment?.name ?? '').toLowerCase();
  if (/\.(mp4|mov|avi|webm|m4v|mkv)$/.test(name)) return 'video';
  if (/\.(jpe?g|png|webp|gif)$/.test(name)) return 'image';
  if (mime.startsWith('application/pdf') || name.endsWith('.pdf')) return 'document';

  // An unrecognised `file` still uploads: better to show the user a result than
  // to report a failure and send them round the loop again.
  return type === 'file' ? 'document' : undefined;
}

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
    (a) => kindForAttachment(a) !== undefined && typeof a?.fetchData === 'function',
  );
}

export function mediaKindOf(message: unknown): InboundKind | undefined {
  const attachments = ((message as { attachments?: unknown })?.attachments ?? []) as InboundAttachment[];
  return attachments.map((a) => kindForAttachment(a)).find((k) => k !== undefined);
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
  const attachment = attachments.find(
    (a) => kindForAttachment(a) !== undefined && a?.fetchData,
  );
  if (!attachment?.fetchData) throw new Error('No video, image or document on the message');

  const kind = kindForAttachment(attachment)!;
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
      ? attachments.filter((a) => kindForAttachment(a) !== publishedKind)
      : attachments,
  };
}
