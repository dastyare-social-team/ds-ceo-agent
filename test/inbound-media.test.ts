import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeInboundMedia,
  isMediaMessage,
  mediaKindOf,
  withMediaSummary,
  type InboundMedia,
} from '../src/mastra/media/inbound.ts';
import { removePost } from '../src/mastra/tools/publishing.ts';

// --- detection --------------------------------------------------------------

const withAttachment = (type: string, extra: Record<string, unknown> = {}) => ({
  text: '',
  attachments: [{ type, name: 'IMG_2515.MP4', fetchData: async () => new Uint8Array([1, 2, 3]), ...extra }],
});

test('a video is media and is recognised as such', () => {
  assert.equal(isMediaMessage(withAttachment('video')), true);
  assert.equal(mediaKindOf(withAttachment('video')), 'video');
});

test('an image and a document are media', () => {
  assert.equal(isMediaMessage(withAttachment('image')), true);
  assert.equal(isMediaMessage(withAttachment('document')), true);
  assert.equal(mediaKindOf(withAttachment('image')), 'image');
});

test('audio is not media — voice is transcribed on its own path', () => {
  // Routing audio here would upload it instead of transcribing it.
  assert.equal(isMediaMessage(withAttachment('audio')), false);
  assert.equal(mediaKindOf(withAttachment('audio')), undefined);
});

test('a caption alongside media is left to the normal text path', () => {
  // The caption is the message; uploading the attachment would ignore it.
  assert.equal(isMediaMessage(withAttachment('video', {})), true);
  assert.equal(
    isMediaMessage({ ...withAttachment('video'), text: 'caption for this' }),
    false,
  );
});

test('plain text and attachments without a fetch function are not media', () => {
  assert.equal(isMediaMessage({ text: 'hello', attachments: [] }), false);
  assert.equal(isMediaMessage({ text: '', attachments: [{ type: 'video' }] }), false);
});

// --- the honesty contract ---------------------------------------------------

const media: InboundMedia = {
  kind: 'video',
  bytes: 12_582_912,
  fileName: 'IMG_2515.MP4',
  url: 'https://owxotllfofaloaocalyp.storage.supabase.co/storage/v1/object/public/ds-ceo-agent/media/x.mp4',
  width: 1080,
  height: 1920,
  publiclyFetchable: true,
};

test('the description tells the model it cannot see the file', () => {
  // This is the whole point. The previous behaviour handed a text-only model an
  // "[Attached file: IMG_2515.MP4]" placeholder and it invented platforms and
  // engagement figures about a video it had never watched.
  const text = describeInboundMedia(media);
  assert.match(text, /cannot see or hear/i);
  assert.match(text, /Do NOT write a caption/i);
});

test('the description supplies the public URL Zernio needs', () => {
  assert.ok(describeInboundMedia(media).includes(media.url));
});

test('the description pushes toward connected accounts, not invented ones', () => {
  const text = describeInboundMedia(media);
  assert.match(text, /list-social-accounts/);
  assert.match(text, /never suggest a platform the user has not connected/i);
});

test('a URL that is not publicly fetchable is called out', () => {
  const text = describeInboundMedia({ ...media, publiclyFetchable: false });
  assert.match(text, /NOT publicly fetchable/);
  assert.match(text, /do not publish against it/i);
});

test('the file name, size and dimensions are reported', () => {
  const text = describeInboundMedia(media);
  assert.match(text, /IMG_2515\.MP4/);
  assert.match(text, /12\.0MB/);
  assert.match(text, /1080x1920/);
});

test('a missing file name does not leave a dangling phrase', () => {
  const text = describeInboundMedia({ ...media, fileName: null });
  assert.equal(/ named /.test(text), false);
  assert.match(text, /sent a video of/);
});

// --- what the model finally receives ---------------------------------------

test('the placeholder that caused the hallucination is gone', () => {
  const handed = withMediaSummary(withAttachment('video'), 'summary', 'video') as {
    text: string;
    attachments: unknown[];
  };
  // The single most important assertion: nothing resembling "[Attached file: ...]"
  // reaches the model, because that string is what it started confabulating from.
  assert.equal(/\[Attached/.test(handed.text), false);
  assert.deepEqual(handed.attachments, []);
});

test('the summary text reaches the model', () => {
  const handed = withMediaSummary(withAttachment('video'), 'the truth here', 'video') as { text: string };
  assert.equal(handed.text, 'the truth here');
});

test('a photo sent with a video keeps its photo', () => {
  const message = {
    text: '',
    attachments: [
      { type: 'video', name: 'v.mp4', fetchData: async () => new Uint8Array([1]) },
      { type: 'image', name: 'cover.jpg', fetchData: async () => new Uint8Array([2]) },
    ],
  };
  const handed = withMediaSummary(message, 'summary', 'video') as {
    attachments: { type: string; name: string }[];
  };
  // Only the published kind is dropped. The cover image is still useful context
  // and the agent can read it, so discarding it would lose information.
  assert.deepEqual(handed.attachments.map((a) => a.type), ['image']);
});
// --- removing what is already published -------------------------------------

test('remove-post refuses without an explicit confirmation', async () => {
  const result = (await removePost.execute!(
    { postId: 'abc', action: 'delete', confirmedByUser: false },
    {},
  )) as { removed: boolean; reason: string };

  // Deleting a published post breaks a live link. The gate is the same one
  // publishing uses: no confirmation, no action.
  assert.equal(result.removed, false);
  assert.match(result.reason, /has not approved/i);
});

test('a confirmed unpublish is preferred over delete in the guidance', () => {
  const description = removePost.description;
  assert.match(description, /unpublish/i);
  assert.match(description, /prefer/i);
  // The irreversible option has to be described as irreversible, or the agent
  // will pick it whenever the goal is merely "take this down".
  assert.match(description, /cannot be undone|permanently/i);
});
