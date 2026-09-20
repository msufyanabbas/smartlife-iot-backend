// src/config/env.utils.ts
//
// Everything in `process.env` is a string, including "false" — which is truthy.
// These helpers exist so that coercion happens one way across every config file
// and service, instead of each one re-deriving `=== 'true'` vs `!== 'false'`
// (the repo had both, which meant an unset variable defaulted to on in some
// places and off in others).

const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'off'];

/** Undefined, empty or whitespace-only values are treated as "not set". */
export function envString(
  value: string | undefined,
  defaultValue?: string,
): string | undefined {
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  return trimmed === '' ? defaultValue : trimmed;
}

export function envNumber(
  value: string | undefined,
  defaultValue: number,
): number {
  const raw = envString(value);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function envBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  const raw = envString(value)?.toLowerCase();
  if (raw === undefined) return defaultValue;
  if (TRUE_VALUES.includes(raw)) return true;
  if (FALSE_VALUES.includes(raw)) return false;
  return defaultValue;
}

/** Splits on commas, trims, and drops empty entries. */
export function envList(
  value: string | undefined,
  defaultValue: string[] = [],
): string[] {
  const raw = envString(value);
  if (raw === undefined) return defaultValue;
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : defaultValue;
}

/**
 * For values that must come from the environment — secrets, hosts, anything
 * where a baked-in fallback would let a misconfigured deploy start and then
 * quietly talk to the wrong thing.
 */
export function envRequired(key: string, value: string | undefined): string {
  const raw = envString(value);
  if (raw === undefined) {
    throw new Error(
      `${key} is required but was not set. Add it to your .env — see .env.production.example.`,
    );
  }
  return raw;
}

/** Strips a single trailing slash so `${base}/path` never produces `//path`. */
export function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}
