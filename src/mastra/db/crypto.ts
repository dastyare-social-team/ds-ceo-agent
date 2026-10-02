import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.ts';

/**
 * AES-256-GCM for credentials at rest.
 *
 * Credentials live in Postgres rather than `.env` because they rotate: a Zernio
 * workspace key gets reissued and a Supabase key pair gets rotated, and a
 * redeploy should not need a code change or a git commit to swap them. That only
 * works if the value is data, and data needs encrypting at rest — a leaked table
 * dump should not hand over the keys to every connected social account.
 *
 * GCM rather than CBC because it authenticates as well as encrypts: a wrong key
 * or a tampered row fails loudly instead of returning plausible garbage.
 *
 * The master key comes from the environment, and that is the one secret that
 * cannot live in the database it protects. Losing it means re-entering every
 * credential, which is why rotation is `keyVersion` plus a re-encrypt pass
 * rather than an in-place swap.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function masterKey(): Buffer {
  const raw = env('CREDENTIALS_MASTER_KEY');
  if (!raw) {
    throw new Error(
      'CREDENTIALS_MASTER_KEY is not set. Generate one with: openssl rand -base64 32',
    );
  }
  // Accept base64 (the documented form) and fall back to a hex reading, because
  // a 32-character hex string is what `openssl rand -hex 32` produces and both
  // are 32 bytes once decoded.
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`CREDENTIALS_MASTER_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** Encrypts a secret into `iv:authTag:ciphertext`, each part base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, encrypted].map((b) => b.toString('base64url')).join(':');
}

/**
 * Decrypts a value written by encryptSecret.
 *
 * The auth tag is verified, so a wrong master key or an edited row throws rather
 * than yielding a credential-shaped string that fails confusingly later, at a
 * publish attempt, in front of the user.
 */
export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Stored credential is malformed');
  }
  const [iv, authTag, payload] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
}