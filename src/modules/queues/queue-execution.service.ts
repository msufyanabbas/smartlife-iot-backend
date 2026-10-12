import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue } from './entities/queue.entity';
import { QueueProcessingStrategy, QueueSubmitStrategy } from './queue.enum';

/** How a single attempt ended. */
export type QueueOutcome = 'ok' | 'failed' | 'timedOut';

export interface QueueRunResult<T> {
  /** False when no queue was named, the name did not resolve, or it is disabled. */
  applied: boolean;
  queueName?: string;
  outcome: QueueOutcome;
  attempts: number;
  /** Present when the final attempt succeeded. */
  value?: T;
  error?: string;
  /** Milliseconds the caller actually waited. */
  waitedMs: number;
}

const CACHE_TTL_MS = 30_000;
const COUNTER_FLUSH_MS = 10_000;

/**
 * Applies a queue's processing semantics to one unit of work.
 *
 * This is the thing that makes `/queues` more than a settings screen: the
 * rule-engine consumer routes a message to a chain, asks this service to run
 * the execution, and the chain's queue decides how long it may take, whether a
 * failure is retried, and whether executions for the same originator may
 * overlap.
 *
 * ── What "timeout" can and cannot mean here ────────────────────────────────
 * JavaScript cannot cancel a promise. `packProcessingTimeout` therefore stops
 * the consumer WAITING for an execution; the execution's own node processors
 * keep running to completion in the background. That is still the property
 * worth having — it is the wait that holds a Kafka partition and blocks every
 * later message on it — but it is not a kill switch, and the route
 * documentation says so rather than implying one.
 *
 * ── Caching ───────────────────────────────────────────────────────────────
 * Queue rows are read on the telemetry hot path, so they are cached per
 * (tenant, name) for 30s and invalidated outright by `QueuesService` on every
 * write. The TTL is what covers a second application instance, whose
 * in-process map a write here cannot reach: a change is visible everywhere
 * within 30 seconds, and immediately on the instance that served the write.
 */
@Injectable()
export class QueueExecutionService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueExecutionService.name);

  /** `${tenantId}|${name}` → row (or null for "no such queue"), with a stamp. */
  private readonly cache = new Map<
    string,
    { queue: Queue | null; at: number }
  >();

  /**
   * Tail of the serial chain for a SEQUENTIAL_BY_* key. Holding the promise
   * rather than a lock object keeps this to one map and no timers; entries are
   * deleted when they are the tail and settle, so the map tracks in-flight
   * keys only.
   */
  private readonly serial = new Map<string, Promise<void>>();

  /**
   * Buffered usage counters, flushed on a timer.
   *
   * One UPDATE per message would double the write amplification the rule
   * engine already has (it saves the chain and every node it touches), and
   * these are observability numbers, not accounting. A crash loses at most one
   * flush interval, which the statistics route does not pretend otherwise.
   */
  private readonly counters = new Map<
    string,
    { processed: number; failed: number; timedOut: number; lastUsedAt: Date }
  >();

  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Queue)
    private readonly queueRepo: Repository<Queue>,
  ) {
    this.flushTimer = setInterval(() => {
      void this.flushCounters();
    }, COUNTER_FLUSH_MS);
    // Never hold the event loop open on this timer alone.
    this.flushTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flushCounters();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CACHE
  // ══════════════════════════════════════════════════════════════════════════

  /** Drop cached rows. Called by QueuesService after every write. */
  invalidate(tenantId?: string): void {
    if (!tenantId) {
      this.cache.clear();
      return;
    }
    const prefix = `${tenantId}|`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async getByName(tenantId: string, name: string): Promise<Queue | null> {
    const key = `${tenantId}|${name}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.queue;

    const queue = await this.queueRepo.findOne({ where: { tenantId, name } });
    this.cache.set(key, { queue: queue ?? null, at: Date.now() });
    return queue ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Run `work` under the semantics of the named queue.
   *
   * `queueName` undefined, unknown or disabled ⇒ `work` runs exactly as it
   * would without this module, and `applied` is false. That is what keeps the
   * consumer's behaviour unchanged for every tenant that has configured no
   * queues.
   *
   * `sequenceKey` is the originator id; SEQUENTIAL_BY_TENANT ignores it and
   * serialises on the tenant instead.
   */
  async run<T>(
    tenantId: string,
    queueName: string | undefined,
    sequenceKey: string,
    work: () => Promise<T>,
  ): Promise<QueueRunResult<T>> {
    const started = Date.now();

    if (!queueName) {
      const value = await work();
      return {
        applied: false,
        outcome: 'ok',
        attempts: 1,
        value,
        waitedMs: Date.now() - started,
      };
    }

    const queue = await this.getByName(tenantId, queueName);
    if (!queue) {
      this.logger.warn(
        `Rule chain names queue "${queueName}" which does not exist in tenant ${tenantId} — running without queue semantics`,
      );
      const value = await work();
      return {
        applied: false,
        queueName,
        outcome: 'ok',
        attempts: 1,
        value,
        waitedMs: Date.now() - started,
      };
    }
    if (!queue.enabled) {
      const value = await work();
      return {
        applied: false,
        queueName: queue.name,
        outcome: 'ok',
        attempts: 1,
        value,
        waitedMs: Date.now() - started,
      };
    }

    const serialKey = this.serialKeyFor(queue, tenantId, sequenceKey);
    const result = serialKey
      ? await this.inSeries(serialKey, () => this.attempt(queue, work))
      : await this.attempt(queue, work);

    this.record(queue.id, result.outcome);

    return { ...result, waitedMs: Date.now() - started };
  }

  /** The attempt/retry loop. Shape is decided entirely by the row. */
  private async attempt<T>(
    queue: Queue,
    work: () => Promise<T>,
  ): Promise<Omit<QueueRunResult<T>, 'waitedMs'>> {
    const maxAttempts = 1 + Math.max(0, queue.retries ?? 0);
    let attempts = 0;
    let lastError: string | undefined;
    let lastOutcome: QueueOutcome = 'failed';

    while (attempts < maxAttempts) {
      attempts += 1;

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ kind: 'timedOut' }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: 'timedOut' }),
          queue.packProcessingTimeout,
        );
        timer.unref?.();
      });

      // The work promise is converted to a NEVER-REJECTING one before the
      // race. If it rejected after the timeout had already won, nothing would
      // be attached to handle that rejection and Node would report an
      // unhandled rejection — which, with the default settings this app runs
      // under, is how a timed-out slow node would take the process down.
      const settled: Promise<
        { kind: 'ok'; value: T } | { kind: 'failed'; error: string }
      > = work().then(
        (value) => ({ kind: 'ok' as const, value }),
        (err: unknown) => ({
          kind: 'failed' as const,
          error: (err as Error)?.message ?? String(err),
        }),
      );

      const raced = await Promise.race([settled, timeout]);
      if (timer) clearTimeout(timer);

      if (raced.kind === 'ok') {
        return {
          applied: true,
          queueName: queue.name,
          outcome: 'ok',
          attempts,
          value: raced.value,
        };
      }

      if (raced.kind === 'timedOut') {
        lastOutcome = 'timedOut';
        lastError = `execution exceeded packProcessingTimeout of ${queue.packProcessingTimeout}ms`;
      } else {
        lastOutcome = 'failed';
        lastError = raced.error;
      }

      if (attempts >= maxAttempts || !this.shouldRetry(queue, lastOutcome)) break;

      const backoff =
        lastOutcome === 'timedOut'
          ? (queue.retryTimedOutBackoff ?? 0)
          : (queue.retryFailedBackoff ?? 0);
      if (backoff > 0) await this.sleep(backoff);
    }

    this.logger.warn(
      `Queue "${queue.name}": ${lastOutcome} after ${attempts} attempt(s) ` +
        `[${queue.processingStrategy}] — ${lastError ?? 'no detail'}`,
    );

    return {
      applied: true,
      queueName: queue.name,
      outcome: lastOutcome,
      attempts,
      error: lastError,
    };
  }

  private shouldRetry(queue: Queue, outcome: QueueOutcome): boolean {
    switch (queue.processingStrategy) {
      case QueueProcessingStrategy.RETRY_ALL:
      case QueueProcessingStrategy.RETRY_FAILED_AND_TIMED_OUT:
        return true;
      case QueueProcessingStrategy.RETRY_FAILED:
        return outcome === 'failed';
      case QueueProcessingStrategy.RETRY_TIMED_OUT:
        return outcome === 'timedOut';
      case QueueProcessingStrategy.SKIP_ALL_FAILURES:
      case QueueProcessingStrategy.SKIP_ALL_FAILURES_AND_TIMED_OUT:
      default:
        return false;
    }
  }

  private serialKeyFor(
    queue: Queue,
    tenantId: string,
    sequenceKey: string,
  ): string | null {
    switch (queue.submitStrategy) {
      case QueueSubmitStrategy.SEQUENTIAL_BY_ORIGINATOR:
        return `${queue.id}|${sequenceKey}`;
      case QueueSubmitStrategy.SEQUENTIAL_BY_TENANT:
        return `${queue.id}|tenant:${tenantId}`;
      // BURST is concurrent by definition. BATCH and SEQUENTIAL are stored and
      // currently behave as BURST — declared in QUEUE_HONOURED_FIELDS and in
      // GET /queues/capabilities, not quietly aliased.
      default:
        return null;
    }
  }

  /** Append to the serial chain for `key` and resolve with this unit's result. */
  private inSeries<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.serial.set(key, gate);

    return previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        settle();
        // Only the tail may clear the entry, or a later waiter loses its place.
        if (this.serial.get(key) === gate) this.serial.delete(key);
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // USAGE COUNTERS
  // ══════════════════════════════════════════════════════════════════════════

  private record(queueId: string, outcome: QueueOutcome): void {
    const current =
      this.counters.get(queueId) ??
      { processed: 0, failed: 0, timedOut: 0, lastUsedAt: new Date() };
    current.processed += 1;
    if (outcome === 'failed') current.failed += 1;
    if (outcome === 'timedOut') current.timedOut += 1;
    current.lastUsedAt = new Date();
    this.counters.set(queueId, current);
  }

  /** Public so a verification script can force a flush without waiting 10s. */
  async flushCounters(): Promise<void> {
    if (this.counters.size === 0) return;
    const pending = [...this.counters.entries()];
    this.counters.clear();

    for (const [queueId, c] of pending) {
      try {
        await this.queueRepo
          .createQueryBuilder()
          .update(Queue)
          .set({
            processedCount: () => `"processedCount" + ${c.processed}`,
            failedCount: () => `"failedCount" + ${c.failed}`,
            timedOutCount: () => `"timedOutCount" + ${c.timedOut}`,
            lastUsedAt: c.lastUsedAt,
          })
          .where('id = :queueId', { queueId })
          .execute();
      } catch (err) {
        // Losing a counter flush must never fail the pipeline that produced it.
        this.logger.error(
          `Failed to flush usage counters for queue ${queueId}: ${(err as Error).message}`,
        );
      }
    }
  }
}
