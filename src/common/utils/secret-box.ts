import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { Logger } from '@nestjs/common';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Symmetric encryption for credentials at rest
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * AES-256-GCM. The format is `v1:<iv>:<authTag>:<ciphertext>`, all base64url,
 * version-prefixed so the scheme can be rotated without guessing at old rows.
 *
 * GCM rather than CBC because it is authenticated: a tampered ciphertext fails
 * to decrypt instead of yielding plausible-looking garbage that then gets sent
 * to a provider as an API key.
 *
 * The key comes from `CREDENTIALS_ENCRYPTION_KEY`. Supply 32 bytes as hex or
 * base64; anything else is hashed to 32 bytes with SHA-256 so a passphrase
 * also works.
 *
 * WHEN THE KEY IS ABSENT the box degrades to a reversible marker rather than
 * throwing, and logs a warning once. That is a deliberate trade: a missing env
 * var must not stop a development instance from booting, and it must not
 * silently look like encryption either — `isEncrypted()` returns false for
 * those values so an operator-facing screen can say "stored unencrypted".
 * Set the variable in production.
 */

const PREFIX = 'v1';
const PLAIN_PREFIX = 'plain';
const logger = new Logger('SecretBox');
let warned = false;

function resolveKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    if (!warned) {
      warned = true;
      logger.warn(
        'CREDENTIALS_ENCRYPTION_KEY is not set — provider credentials will be ' +
          'stored UNENCRYPTED. Set a 32-byte key before going to production.',
      );
    }
    return null;
  }
  const trimmed = raw.trim();
  // Exactly 32 bytes as hex or base64 is used as-is; anything else is hashed,
  // so a human-chosen passphrase is still a valid key.
  for (const enc of ['hex', 'base64'] as const) {
    try {
      const buf = Buffer.from(trimmed, enc);
      if (buf.length === 32) return buf;
    } catch {
      /* try the next encoding */
    }
  }
  return createHash('sha256').update(trimmed).digest();
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = resolveKey();
  if (!key) return `${PLAIN_PREFIX}:${Buffer.from(plaintext, 'utf8').toString('base64url')}`;

  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    enc.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored?: string | null): string | null {
  if (!stored) return null;

  if (stored.startsWith(`${PLAIN_PREFIX}:`)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length + 1), 'base64url').toString('utf8');
  }
  if (!stored.startsWith(`${PREFIX}:`)) {
    // A value written before this helper existed. Return it as-is rather than
    // throwing — the caller gets a working credential and the row upgrades to
    // ciphertext on its next save.
    return stored;
  }

  const key = resolveKey();
  if (!key) {
    throw new Error(
      'This credential is encrypted but CREDENTIALS_ENCRYPTION_KEY is not set.',
    );
  }

  const [, ivB64, tagB64, dataB64] = stored.split(':');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or the row was tampered with. Say which, without leaking.
    throw new Error(
      'Could not decrypt credential — the encryption key may have changed.',
    );
  }
}

/** True only for real ciphertext, so a UI can be honest about what is stored. */
export function isEncrypted(stored?: string | null): boolean {
  return !!stored && stored.startsWith(`${PREFIX}:`);
}

/** `sk-abc…wxyz` — enough to recognise a key, not enough to use it. */
export function maskSecret(plaintext?: string | null): string | null {
  if (!plaintext) return null;
  if (plaintext.length <= 8) return '••••';
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}
