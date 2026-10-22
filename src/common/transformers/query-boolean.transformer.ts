import type { TransformFnParams } from 'class-transformer';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Turn a query-string boolean into a real boolean
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A query string is text. `?active=false` arrives as the STRING `"false"`,
 * which is truthy, so a bare `@IsBoolean()` on a `boolean` property accepts it
 * and the handler receives `true`. Passing `false` then does exactly what
 * passing `true` does — measured on `/assets`, where `?active=false` returned
 * the ACTIVE assets.
 *
 * ── Why this reads `obj[key]` and not `value` ──────────────────────────────
 *
 * This is the part that is easy to get wrong, and it was gotten wrong twice in
 * this repository before this file existed.
 *
 * The global pipe runs with `enableImplicitConversion: true` (`main.ts`), and
 * class-transformer applies that conversion **before** `@Transform` runs. For
 * a property whose `design:type` is `Boolean`, the implicit conversion is
 * literally `Boolean(value)` — so by the time a transform reading `value` is
 * called, `"false"` has already become `true` and the original string is gone.
 * A transform written as
 *
 *     @Transform(({ value }) => value === 'true')      // ← USELESS
 *
 * therefore receives `true` for every non-empty input and yields `true` for
 * every input. It looks exactly like a fix and changes nothing.
 *
 * `obj` is the UNTRANSFORMED source object, so `obj[key]` is the raw string
 * the client actually sent. That is the only reliable source.
 *
 * `undefined` for an absent or empty value, so "not specified" stays distinct
 * from `false` — `?active=` must not mean `?active=false`.
 *
 * ── One implementation ─────────────────────────────────────────────────────
 *
 * There were two copies: `images/dto/create-image.dto.ts` (correct, reading
 * `obj[key]`) and `api-monitoring/dto/api-log-filter.dto.ts` (reading `value`,
 * so `?isError=false` resolved to `true`). The correct one was cited as "the
 * house pattern" by a later DTO that then copied the broken shape. Hence one
 * exported function rather than a pattern to imitate.
 */
export const toQueryBoolean = ({ obj, key }: TransformFnParams): boolean | undefined => {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];

  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;

  // Accepted truthy spellings. Anything else — including "no", "off" and any
  // typo — is false rather than an error, because a filter that 400s on a
  // misspelling is worse than one that declines to filter. `@IsBoolean()`
  // still runs after this and catches a value that cannot be coerced at all.
  return raw === 'true' || raw === 'TRUE' || raw === '1' || raw === 1;
};
