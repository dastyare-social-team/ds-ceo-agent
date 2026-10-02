import assert from 'node:assert/strict';
import test from 'node:test';

// The master key is read from the environment on every call, so it is set before
// importing the module under test. This is a real 32-byte key; it only ever
// encrypts fixtures inside this file.
process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const { decryptSecret, encryptSecret } = await import('../src/mastra/db/crypto.ts');

test('a secret round-trips', () => {
  const secret = 'gsk_live_key_abc123';
  assert.equal(decryptSecret(encryptSecret(secret)), secret);
});

test('the ciphertext does not contain the plaintext', () => {
  const secret = 'super-secret-zernio-key';
  const stored = encryptSecret(secret);
  assert.equal(stored.includes(secret), false);
  // Three base64url parts, colon separated.
  assert.equal(stored.split(':').length, 3);
});

test('the same secret encrypts differently every time', () => {
  // A fixed IV would leak that two rows hold the same credential, and would make
  // the ciphertexts comparable across rows.
  const a = encryptSecret('same-value');
  const b = encryptSecret('same-value');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), decryptSecret(b));
});

test('a tampered ciphertext fails instead of returning wrong bytes', () => {
  // GCM authenticates, so this must throw rather than hand back plausible
  // garbage that would only be noticed at a publish attempt.
  const stored = encryptSecret('original-value');
  const [iv, tag, payload] = stored.split(':');
  const flipped = Buffer.from(payload!, 'base64url');
  flipped[0] ^= 0xff;
  assert.throws(
    () => decryptSecret(`${iv}:${tag}:${flipped.toString('base64url')}`),
    /unable to authenticate|bad decrypt|unsupported/i,
  );
});

test('a malformed stored value is rejected, not guessed at', () => {
  assert.throws(() => decryptSecret('not-a-valid-ciphertext'), /malformed/i);
});

test('a wrong master key cannot decrypt', () => {
  const stored = encryptSecret('original-value');
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    assert.throws(() => decryptSecret(stored));
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});

test('a hex master key works as well as base64', () => {
  // `openssl rand -hex 32` is a natural thing to run, so both spellings must.
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    process.env.CREDENTIALS_MASTER_KEY = 'ab'.repeat(32);
    const stored = encryptSecret('hex-key-value');
    assert.equal(decryptSecret(stored), 'hex-key-value');
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});

test('a master key of the wrong length is refused with a clear message', () => {
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    process.env.CREDENTIALS_MASTER_KEY = Buffer.alloc(16, 1).toString('base64');
    assert.throws(() => encryptSecret('x'), /32 bytes/i);
  } finally {
    process.env.CREDENTIALS_MASTER_KEY = original;
  }
});

test('a missing master key is refused rather than defaulted', () => {
  const original = process.env.CREDENTIALS_MASTER_KEY;
  try {
    delete process.env.CREDENTIALS_MASTER_KEY;
    assert.throws(() => encryptSecret('x'), /CREDENTIALS_MASTER_KEY is not set/i);
  } finally {
    if (original !== undefined) process.env.CREDENTIALS_MASTER_KEY = original;
  }
});

test('unicode secrets survive the round trip', () => {
  const secret = 'کلید-رمز-فارسی 🔐';
  assert.equal(decryptSecret(encryptSecret(secret)), secret);
});