// src/lib/cluster/distributed-cron.decorator.ts
//
// `@DistributedCron(expr, {name, lockTtl})` — a drop-in replacement for
// `@Cron(expr, {name})` that claims a Redis lock before running the body, so
// exactly one replica executes each tick.
//
// Usage is deliberately a one-line change at the call site:
//
//     -  @Cron(CronExpression.EVERY_MINUTE, { name: 'report-schedule-tick' })
//     +  @DistributedCron(CronExpression.EVERY_MINUTE, {
//     +    name: 'report-schedule-tick',
//     +    lockTtl: 300,
//     +  })
//
// `name` is REQUIRED here, where `@Cron` treats it as optional: it is the lock
// key, so two different jobs with no name would share one lock and starve each
// other. The guard script (`npm run check:cluster-safety`) refuses an unnamed
// one, and refuses a plain `@Cron` that is not on its idempotent allow-list.
//
// ── Why a wrapper method and not a guard ───────────────────────────────────
// @nestjs/schedule reads the `@Cron` metadata off the method it decorates and
// registers that function directly with the CronJob — it is not a Nest
// execution context, so there is no pipeline for an interceptor or guard to
// join. Wrapping the descriptor is the only place the lock can go.

import { Cron } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';
import { DistributedLockService } from './distributed-lock.service';

export interface DistributedCronOptions {
  /** The cron's name AND its lock key. Required — see the note above. */
  name: string;
  /**
   * Seconds. A floor, not a cap: the holder renews the TTL while the body
   * runs (see DistributedLockService). Size it above a *typical* run.
   */
  lockTtl?: number;
  /** Disable TTL renewal for a body with a hard, short bound. */
  renew?: boolean;
  /** Mirrors `@Cron`'s option. */
  timeZone?: string;
}

const logger = new Logger('DistributedCron');

export function DistributedCron(
  cronExpression: string,
  options: DistributedCronOptions,
): MethodDecorator {
  if (!options?.name) {
    throw new Error(
      '@DistributedCron requires a name — it is the distributed lock key',
    );
  }

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const original = descriptor.value as (
      ...args: unknown[]
    ) => unknown | Promise<unknown>;

    descriptor.value = async function wrapped(
      this: unknown,
      ...args: unknown[]
    ) {
      const lock = DistributedLockService.instance;

      if (!lock) {
        // Can only happen if ClusterModule is not registered. Fail closed and
        // say exactly what is wrong rather than quietly duplicating work.
        logger.error(
          `Cron "${options.name}" fired with no DistributedLockService — ` +
            'ClusterModule is not registered, so the tick is being skipped. ' +
            'Add ClusterModule to featureModules.',
        );
        return undefined;
      }

      const outcome = await lock.withLock(
        options.name,
        async () => original.apply(this, args),
        { ttlSeconds: options.lockTtl, renew: options.renew },
      );

      return outcome.ran ? outcome.result : undefined;
    };

    // Preserve the name the scheduler and any dynamic lookup use.
    Object.defineProperty(descriptor.value, 'name', {
      value: String(propertyKey),
      configurable: true,
    });

    Cron(cronExpression, {
      name: options.name,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    })(target, propertyKey, descriptor);

    return descriptor;
  };
}
