/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: the distributed cron lock behaves, against a real Redis
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nine crons now depend on this one mechanism — report delivery, scheduled
 * notifications, automation schedules, Tuya polling, subscription expiry,
 * usage sync, the monthly usage reset, scheduled downgrades and the
 * device-offline sweep. If `withLock` is wrong, the symptom is not an error:
 * it is either the same billing sweep running twice, or scheduled work
 * quietly never running at all.
 *
 * `check-cluster-safety.ts` reads the source and asserts that each cron is
 * decorated. It cannot tell whether the lock actually excludes a second
 * holder, whether the watchdog really renews, or whether a crashed holder's
 * key expires. Those are timing properties of Redis, and the only way to know
 * is to run two instances against a real server and watch.
 *
 * Needs Redis on REDIS_HOST/REDIS_PORT (default 127.0.0.1:6379). It uses its
 * own key prefix and deletes what it creates.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-cluster-locks.ts
 */
import { randomUUID } from 'crypto';

import { DistributedLockService } from '../src/lib/cluster/distributed-lock.service';
import type { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/lib/redis/redis.service';
import redisConfigFactory from '../src/config/redis.config';

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A unique cron name per run, so a crashed earlier run cannot interfere. */
const cronName = () => `verify-lock-${randomUUID().slice(0, 8)}`;

(async () => {
  // Two independent service instances, as two replicas would be. The static
  // `instance` holder is overwritten by each construction — irrelevant here,
  // since both are called directly.
  process.env.CLUSTER_LOCKS_ENABLED = 'true';

  // redis.config.ts treats REDIS_HOST as required and throws if it is absent —
  // a deliberate fail-fast so a deploy cannot silently point at localhost.
  // Defaulted here rather than weakened there.
  process.env.REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
  process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';

  // RedisService reads its whole settings namespace through ConfigService, so
  // a hand-built instance needs one. The real config factory is invoked, not
  // a hardcoded host/port object — otherwise this script would verify the lock
  // against a connection the application would never make.
  const redisConfig = redisConfigFactory();
  const configStub = {
    get: (key: string) => (key === 'redis' ? redisConfig : undefined),
  } as unknown as ConfigService;

  const redisA = new RedisService(configStub);
  const redisB = new RedisService(configStub);
  for (const r of [redisA, redisB]) {
    if (typeof (r as any).onModuleInit === 'function') {
      await (r as any).onModuleInit();
    }
  }

  // Fail fast and clearly if Redis is not actually reachable, rather than
  // reporting every lock assertion as a product failure.
  try {
    await redisA.set('verify-lock:ping', '1', 5);
    const pong = await redisA.get('verify-lock:ping');
    if (pong !== '1') throw new Error(`unexpected read-back: ${pong}`);
  } catch (error) {
    console.error(
      '\n\u001b[31mSKIP\u001b[0m — Redis is not reachable, so lock behaviour ' +
        'cannot be verified:',
      (error as Error).message,
    );
    console.error(
      '        Start one with: redis-server --port 6379 --daemonize yes --save "" --appendonly no\n',
    );
    process.exit(2);
  }

  const nodeA = new DistributedLockService(redisA);
  const nodeB = new DistributedLockService(redisB);

  // ── Mutual exclusion ────────────────────────────────────────────────────
  section('1. Exactly one replica runs a given tick');

  {
    const name = cronName();
    let ranCount = 0;
    const slowWork = async () => {
      ranCount++;
      await sleep(300);
      return 'done';
    };

    const [a, b] = await Promise.all([
      nodeA.withLock(name, slowWork, { ttlSeconds: 10 }),
      // Started a beat later so both are genuinely in flight together.
      (async () => {
        await sleep(20);
        return nodeB.withLock(name, slowWork, { ttlSeconds: 10 });
      })(),
    ]);

    ok('the body ran exactly once across two replicas', ranCount === 1, { ranCount });
    ok(
      'exactly one replica reports ran: true',
      [a.ran, b.ran].filter(Boolean).length === 1,
      { a: a.ran, b: b.ran },
    );
    const winner = a.ran ? a : b;
    ok(
      'the winner returns the body’s value, not undefined',
      winner.ran && winner.result === 'done',
      winner,
    );
    const loser: any = a.ran ? b : a;
    ok(
      'the loser reports WHY it skipped',
      loser.ran === false && loser.reason === 'not-acquired',
      loser,
    );
  }

  // ── Release ─────────────────────────────────────────────────────────────
  section('2. The lock is released, so the next tick is not starved');

  {
    const name = cronName();
    await nodeA.withLock(name, async () => 'first', { ttlSeconds: 30 });
    ok('the key is gone after the body finishes', !(await nodeA.isHeld(name)));

    const second = await nodeB.withLock(name, async () => 'second', {
      ttlSeconds: 30,
    });
    ok(
      'the next tick on another replica runs',
      second.ran && second.result === 'second',
      second,
    );
  }

  {
    // A throwing body must still release. Otherwise one failed sweep blocks
    // every later sweep for the whole TTL.
    const name = cronName();
    let threw = false;
    try {
      await nodeA.withLock(
        name,
        async () => {
          throw new Error('body failed');
        },
        { ttlSeconds: 30 },
      );
    } catch {
      threw = true;
    }
    ok('a throwing body propagates its error', threw);
    ok('and the lock is still released', !(await nodeA.isHeld(name)));
  }

  // ── Crash recovery ──────────────────────────────────────────────────────
  section('3. A crashed holder’s lock expires');

  {
    // Simulates a replica that died mid-body: the key is taken and never
    // released. Without a TTL this cron would be dead until someone noticed.
    const name = cronName();
    const held = await redisA.acquireLock(
      `cluster:lock:${name}`,
      1,
      1,
      'dead-replica-token',
    );
    ok('a lock can be taken directly (simulating a holder)', held === true);

    const blocked = await nodeB.withLock(name, async () => 'ran', {
      ttlSeconds: 10,
    });
    ok('another replica is blocked while it is held', blocked.ran === false);

    await sleep(1400);
    const afterExpiry = await nodeB.withLock(name, async () => 'ran', {
      ttlSeconds: 10,
    });
    ok(
      'once the TTL lapses the cron resumes by itself',
      afterExpiry.ran && afterExpiry.result === 'ran',
      afterExpiry,
    );
  }

  // ── Compare-and-delete ──────────────────────────────────────────────────
  section('4. An overran holder cannot unlock the next owner');

  {
    // The dangerous shape: A's body outlives its TTL, B acquires, then A
    // finishes and deletes the key — releasing B's lock and letting a third
    // replica in while B is still working. Release must check the token.
    const name = cronName();
    const key = `cluster:lock:${name}`;

    await redisA.acquireLock(key, 1, 1, 'token-A');
    await sleep(1300); // A's TTL lapses
    const bGot = await redisB.acquireLock(key, 30, 1, 'token-B');
    ok('B acquires after A’s TTL lapsed', bGot === true);

    const aReleased = await redisA.releaseLockIfOwner(key, 'token-A');
    ok('A’s late release is refused — it is no longer the owner', aReleased === false);
    ok('B still holds the lock', await nodeB.isHeld(name));

    const bReleased = await redisB.releaseLockIfOwner(key, 'token-B');
    ok('B can release its own lock', bReleased === true);
  }

  // ── Watchdog ────────────────────────────────────────────────────────────
  section('5. The watchdog keeps a long body’s lock alive');

  // ── A note on the numbers below, because they decide whether this
  //    section tests anything at all ──────────────────────────────────────
  //
  // `withLock` clamps the TTL up to MIN_TTL_SECONDS (5). The first version of
  // this section asked for `ttlSeconds: 2` and slept 2.5s, which looked like
  // a body outliving its lock — but 2 was clamped to 5, so the key would have
  // survived with no renewal whatsoever. The assertion passed and proved
  // nothing.
  //
  // It was caught only by the negative control immediately after it: with
  // `renew: false` the lock was still held, which is impossible if renewal
  // were what kept it alive. Hence a TTL at the floor and a body that
  // genuinely outlives it. This costs ~16s of wall clock, which is the price
  // of the assertion meaning something.
  const WATCHDOG_TTL = 5;
  const WATCHDOG_BODY_MS = 8_000;

  {
    const name = cronName();
    const result = await nodeA.withLock(
      name,
      async () => {
        await sleep(WATCHDOG_BODY_MS);
        // 8s into a 5s TTL: only the watchdog can still be holding this.
        return nodeA.isHeld(name);
      },
      { ttlSeconds: WATCHDOG_TTL },
    );
    ok(
      'a body outliving its TTL still holds the lock at the end',
      result.ran && result.result === true,
      result,
    );
    ok('and it is released afterwards', !(await nodeA.isHeld(name)));
  }

  {
    const name = cronName();
    // The negative control. Same TTL, same body, renewal off: the lock MUST
    // be gone, which is what proves the check above is measuring renewal and
    // not a generously clamped TTL.
    const result = await nodeA.withLock(
      name,
      async () => {
        await sleep(WATCHDOG_BODY_MS);
        return nodeA.isHeld(name);
      },
      { ttlSeconds: WATCHDOG_TTL, renew: false },
    );
    ok(
      'with renew: false the same body loses it — so renewal is doing real work',
      result.ran && result.result === false,
      result,
    );
  }

  // ── The silent-failure direction ────────────────────────────────────────
  section('6. Redis unreachable: skipped, counted, and visible');

  {
    // The property that matters operationally. When Redis cannot be reached
    // the tick is skipped — correct, since the lock might be held elsewhere —
    // but NINE crons stop platform-wide with nothing thrown and no other
    // probe turning red. It has to at least be countable.
    const name = cronName();
    const brokenRedis = {
      async acquireLock() {
        throw new Error('connection refused');
      },
      async releaseLockIfOwner() {
        return false;
      },
      async extendLockIfOwner() {
        return false;
      },
      async exists() {
        return 0;
      },
    } as unknown as RedisService;

    const brokenNode = new DistributedLockService(brokenRedis);
    let ran = false;
    const outcome = await brokenNode.withLock(
      name,
      async () => {
        ran = true;
        return 'should not happen';
      },
      { ttlSeconds: 10 },
    );

    ok('the body does NOT run', ran === false);
    ok(
      'the outcome names Redis as the reason, not a lost race',
      outcome.ran === false && outcome.reason === 'disabled-no-redis',
      outcome,
    );

    const stats = brokenNode.stats();
    ok(
      'the skip is counted against that cron',
      stats.crons.find((c) => c.name === name)?.skippedNoRedis === 1,
      stats,
    );
    ok(
      'the replica reports itself DEGRADED, so /health/cluster can show it',
      stats.degraded === true,
      stats,
    );
    ok(
      'a lost race alone does not mark a replica degraded',
      nodeB.stats().crons.some((c) => c.skippedNotAcquired > 0) &&
        nodeB.stats().degraded === false,
      nodeB.stats(),
    );
  }

  // ── The documented single-process escape hatch ──────────────────────────
  section('7. CLUSTER_LOCKS_ENABLED=false runs inline');

  {
    // What a deliberately single-process deployment sets, and what the verify
    // scripts rely on: the work runs and its real return value comes back.
    process.env.CLUSTER_LOCKS_ENABLED = 'false';
    const unlocked = new DistributedLockService(redisA);
    const name = cronName();
    const outcome = await unlocked.withLock(name, async () => 'inline', {
      ttlSeconds: 10,
    });
    ok(
      'the body runs and returns its value with locking bypassed',
      outcome.ran && outcome.result === 'inline',
      outcome,
    );
    ok('no lock key is created at all', !(await nodeA.isHeld(name)));
    ok('and it does not report itself degraded', unlocked.stats().degraded === false);
    process.env.CLUSTER_LOCKS_ENABLED = 'true';
  }

  // Clean up anything this run left behind.
  for (const key of await redisA.keys('cluster:lock:verify-lock-*')) {
    await redisA.del(key);
  }
  await redisA.del('verify-lock:ping');

  for (const r of [redisA, redisB]) {
    if (typeof (r as any).onModuleDestroy === 'function') {
      await (r as any).onModuleDestroy();
    }
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: the cron lock excludes, renews, expires and fails visibly\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
