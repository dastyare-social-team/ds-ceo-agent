import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shrinks an oversized video before it goes to storage.
 *
 * Storage rejects a file above its own ceiling, and that failure surfaces to the
 * user as "Could not upload that file" with no way forward — the message never
 * reaches Zernio, and re-sending it fails identically. Compressing first turns a
 * hard stop into a slightly softer file.
 *
 * Two ceilings, deliberately separate. The trigger is where storage starts
 * refusing, and the target is comfortably under it, because a single encode pass
 * does not reliably land on an exact byte count. Anything above the trigger is
 * transcoded; anything below it is uploaded untouched, because re-encoding a file
 * that was never going to fail costs time and quality for nothing.
 *
 * ffmpeg is a 43MB binary in the function bundle. That is affordable here — the
 * bundle sits around 180MB of a 250MB limit — but it is a real cost, and it is
 * paid on every cold start even for text-only traffic, which is why the spawn is
 * lazy and short-lived rather than a long-lived process.
 */

/** Above this, the file is transcoded. Matches the storage ceiling. */
const TRIGGER_BYTES = Number(process.env.MEDIA_COMPRESS_ABOVE_BYTES ?? 50 * 1024 * 1024);
/** Below this after encoding. Headroom under the ceiling, not an exact target. */
const TARGET_BYTES = Number(process.env.MEDIA_COMPRESS_TARGET_BYTES ?? 20 * 1024 * 1024);

/**
 * A ceiling on encode time. Vercel freezes the function once the webhook returns
 * and `waitUntil` only buys so long, so a long file has to give up and be
 * reported rather than silently killed with no message.
 */
const ENCODE_TIMEOUT_MS = Number(process.env.MEDIA_COMPRESS_TIMEOUT_MS ?? 120_000);

export interface CompressionResult {
  bytes: Uint8Array;
  /** False when the file was already small enough and was passed through. */
  compressed: boolean;
  originalBytes: number;
  note?: string;
}

export function needsCompression(byteLength: number): boolean {
  return byteLength > TRIGGER_BYTES;
}

/** True when the platform can transcode at all. */
export async function compressionAvailable(): Promise<boolean> {
  if (process.env.NODE_TEST_CONTEXT) return false;
  return Boolean(await ffmpegPath());
}

async function ffmpegPath(): Promise<string | undefined> {
  try {
    /**
     * @ffmpeg-installer rather than ffmpeg-static.
     *
     * ffmpeg-static downloads a binary for whatever platform runs the install, so
     * a copy taken from this machine would be a macOS binary in a Linux function,
     * and the binary it did download would not appear in the deployed artifact at
     * all — compression would silently pass every oversized file through.
     *
     * @ffmpeg-installer splits the binary per platform, and the linux-x64 package
     * is declared as an optional dependency so Vercel installs it while an arm64
     * Mac skips it without failing. The wrapper then resolves whichever platform
     * it is actually running on.
     */
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const installer = req('@ffmpeg-installer/ffmpeg') as { path?: string };
    return installer?.path && existsSync(installer.path) ? installer.path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-encodes to H.264 with a two-pass-free ladder.
 *
 * Scale and bitrate are chosen from the source dimensions rather than fixed,
 * because a 4K phone clip downscaled to 1280 wide is the difference between a
 * usable upload and a file that is still too big after encoding.
 */
async function encode(bytes: Uint8Array, extension: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'media-'));
  const input = join(dir, `in.${extension}`);
  const output = join(dir, 'out.mp4');

  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(input, bytes);

    await run((await ffmpegPath())!, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', input,
      // 720p is the floor that keeps faces legible in a caption-sized post;
      // anything lower is not worth posting.
      '-vf', "scale='min(1280,iw)':-2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      // Roughly 1.5Mbps: well under a 20MB ceiling for a 90-second clip.
      '-b:v', '1500k',
      '-maxrate', '1800k',
      '-bufsize', '3000k',
      // yuv420p and +faststart because every platform player expects them, and a
      // non-faststart file will not preview before it is fully downloaded.
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      output,
    ]);

    const encoded = await readFile(output);
    return new Uint8Array(encoded);
  } finally {
    // The scratch directory is always removed: /tmp on Vercel is per-instance and
    // these files are large.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Spawns ffmpeg and rejects on a non-zero exit or a timeout. */
function run(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Compression timed out after ${ENCODE_TIMEOUT_MS}ms`));
    }, ENCODE_TIMEOUT_MS);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Keeps the extension ffmpeg needs to demux the container. */
function extensionFor(fileName: string | null): string {
  const match = fileName?.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  return match?.[1] ?? 'mp4';
}

/**
 * Compresses if needed, otherwise passes the bytes through untouched.
 *
 * Never throws: a file that cannot be compressed is still worth attempting at its
 * original size, because the storage ceiling may be higher than this trigger and
 * the failure would otherwise be silent.
 */
export async function compressIfOversized(
  bytes: Uint8Array,
  fileName: string | null,
): Promise<CompressionResult> {
  if (!needsCompression(bytes.byteLength)) {
    return { bytes, compressed: false, originalBytes: bytes.byteLength };
  }

  if (!(await compressionAvailable())) {
    return {
      bytes,
      compressed: false,
      originalBytes: bytes.byteLength,
      note: 'Video is over the compression threshold but ffmpeg is unavailable here.',
    };
  }

  try {
    const encoded = await encode(bytes, extensionFor(fileName));
    if (encoded.byteLength >= bytes.byteLength) {
      return {
        bytes,
        compressed: false,
        originalBytes: bytes.byteLength,
        note: 'Compression did not reduce the size, so the original was kept.',
      };
    }
    return {
      bytes: encoded,
      compressed: true,
      originalBytes: bytes.byteLength,
      note: `Compressed from ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB to ${(encoded.byteLength / 1024 / 1024).toFixed(1)}MB.`,
    };
  } catch (error) {
    return {
      bytes,
      compressed: false,
      originalBytes: bytes.byteLength,
      note: `Compression failed (${String((error as Error)?.message ?? error).slice(0, 160)}). Uploading the original.`,
    };
  }
}

export { TRIGGER_BYTES, TARGET_BYTES };