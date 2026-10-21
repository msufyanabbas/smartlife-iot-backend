/**
 * ─────────────────────────────────────────────────────────────────────────────
 * An in-memory stand-in for RedisService, for the verification scripts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Several services gained a Redis-backed cache as a constructor dependency —
 * `PermissionCacheService`, `SubscriptionCacheService`,
 * `TelemetryLatestCacheService`, `DeviceAuthService`. The scripts that
 * construct those services by hand need something to pass.
 *
 * ── Why this is a real implementation and not `{} as any` ──────────────────
 * The tempting shortcut is a Proxy that answers `undefined` to everything.
 * Do not: a cache that always misses is a cache that is never exercised, so
 * every assertion passes and the caching path — including its invalidation —
 * goes untested. That is how this codebase arrived at device authentication
 * that was never called and audit handlers that wrote no rows.
 *
 * So TTLs expire, `increment` is a real monotonic counter, and `mget`
 * preserves key order. The epoch scheme that `PermissionCacheService` uses for
 * invalidation depends on all three.
 *
 * It is NOT a Redis emulator: it implements exactly the operations those
 * caches call. A service that starts calling something else will fail on
 * `undefined is not a function` rather than silently misbehaving, which is the
 * right direction for a test double to fail in.
 */
import type { RedisService } from '../../src/lib/redis/redis.service';

export interface InMemoryRedis extends RedisService {
  /** Test-only: how many keys are currently live. */
  __size(): number;
  /** Test-only: drop everything, e.g. between sections of a script. */
  __flush(): void;
}

export function inMemoryRedis(): InMemoryRedis {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const live = (key: string): string | null => {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt < Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.value;
  };

  const api = {
    async get(key: string): Promise<string | null> {
      return live(key);
    },

    async mget(...keys: string[]): Promise<(string | null)[]> {
      // Order matters: PermissionCacheService destructures [global, tenant].
      return keys.map(live);
    },

    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
    },

    async del(key: string): Promise<void> {
      store.delete(key);
    },

    async increment(key: string): Promise<number> {
      const next = Number(live(key) ?? '0') + 1;
      const existing = store.get(key);
      store.set(key, {
        value: String(next),
        expiresAt: existing?.expiresAt ?? null,
      });
      return next;
    },

    async expire(key: string, ttlSeconds: number): Promise<void> {
      const hit = store.get(key);
      if (hit) hit.expiresAt = Date.now() + ttlSeconds * 1000;
    },

    async exists(key: string): Promise<boolean> {
      return live(key) !== null;
    },

    async keys(pattern: string): Promise<string[]> {
      // Glob-to-regexp for the `prefix:*` shapes the caches use.
      const rx = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      return [...store.keys()].filter((k) => rx.test(k) && live(k) !== null);
    },

    __size(): number {
      return [...store.keys()].filter((k) => live(k) !== null).length;
    },

    __flush(): void {
      store.clear();
    },
  };

  return api as unknown as InMemoryRedis;
}
