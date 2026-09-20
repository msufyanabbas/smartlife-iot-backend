// src/common/utils/password.util.ts
//
// One place to decide the bcrypt cost factor.
//
// The value was hardcoded as `10` in eight places (the User entity hook and
// seven call sites in two-factor-auth.service). Ten is below current guidance,
// and more importantly it could not be raised without editing every call site —
// so in practice it never would be. bcrypt cost has to be re-tuned as hardware
// gets faster, which makes it a configuration value, not a constant.
//
// BCRYPT_SALT_ROUNDS is clamped: below 10 is weaker than the old behaviour, and
// above 15 takes long enough per hash (seconds) that login becomes a denial-of-
// service vector against your own API.

const DEFAULT_ROUNDS = 12;
const MIN_ROUNDS = 10;
const MAX_ROUNDS = 15;

export function getBcryptRounds(): number {
  const raw = process.env.BCRYPT_SALT_ROUNDS;
  const parsed = Number(raw);

  if (!raw || !Number.isFinite(parsed)) return DEFAULT_ROUNDS;

  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.trunc(parsed)));
}
