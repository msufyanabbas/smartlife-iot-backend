// src/modules/queues/queue.enum.ts
//
// Declared here rather than in `src/common/enums/index.enum.ts` on purpose:
// the barrel is shared with every other module and several agents edit it at
// once. Nothing outside QueuesModule and the rule-engine consumer needs these.
//
// Both are stored as `character varying`, NOT as a PostgreSQL enum. A PG enum
// column needs `ALTER TYPE ... ADD VALUE` before a new TypeScript member can
// be stored at all — `@IsEnum` accepts it and the INSERT then fails with
// `invalid input value for enum ...` (CLAUDE.md §4e). Submit and processing
// strategies are exactly the kind of list that grows, so they stay varchar and
// are validated in the DTO instead.

/**
 * How messages are handed to the processor.
 *
 * Only BURST and the two SEQUENTIAL_BY_* members change observable behaviour in
 * this implementation — see `QueueExecutionService`. BATCH and SEQUENTIAL are
 * accepted and stored, and currently behave as BURST; that is listed in the
 * route documentation rather than implied away.
 */
export enum QueueSubmitStrategy {
  BURST = 'BURST',
  BATCH = 'BATCH',
  SEQUENTIAL_BY_ORIGINATOR = 'SEQUENTIAL_BY_ORIGINATOR',
  SEQUENTIAL_BY_TENANT = 'SEQUENTIAL_BY_TENANT',
  SEQUENTIAL = 'SEQUENTIAL',
}

/**
 * What happens to a failed or timed-out message.
 *
 * All six are honoured by `QueueExecutionService.run()`: the strategy decides
 * whether a failure, a timeout, both or neither is retried, up to `retries`
 * attempts with `retryFailedBackoff` / `retryTimedOutBackoff` milliseconds
 * between them.
 */
export enum QueueProcessingStrategy {
  SKIP_ALL_FAILURES = 'SKIP_ALL_FAILURES',
  SKIP_ALL_FAILURES_AND_TIMED_OUT = 'SKIP_ALL_FAILURES_AND_TIMED_OUT',
  RETRY_ALL = 'RETRY_ALL',
  RETRY_FAILED = 'RETRY_FAILED',
  RETRY_TIMED_OUT = 'RETRY_TIMED_OUT',
  RETRY_FAILED_AND_TIMED_OUT = 'RETRY_FAILED_AND_TIMED_OUT',
}

/**
 * Which parts of a queue definition this platform actually acts on.
 *
 * Returned verbatim by `GET /queues/capabilities` so the configuration screen
 * can label a field "stored, not yet honoured" instead of letting an operator
 * tune a number that changes nothing. Keep it in step with
 * `QueueExecutionService`.
 */
export const QUEUE_HONOURED_FIELDS = [
  'submitStrategy',
  'processingStrategy',
  'packProcessingTimeout',
  'retries',
  'retryFailedBackoff',
  'retryTimedOutBackoff',
  'enabled',
] as const;

export const QUEUE_STORED_ONLY_FIELDS = [
  'topic',
  'partitions',
  'consumerPerPartition',
  'pollInterval',
  'maxPollRecords',
  'maxPollInterval',
  'maxRequestSize',
  'maxPendingMessages',
] as const;

/**
 * Why those eight are stored only.
 *
 * They are properties of a Kafka topic and of a consumer group, not of
 * per-message processing. `RuleEngineConsumer` subscribes one consumer group
 * (`rule-engine-processor-group`) to one topic (`rules.input`) at boot, before
 * any tenant's queue rows are known, and `KafkaService.createConsumer()` takes
 * no partition or poll settings. Honouring them means creating a topic and a
 * consumer group per queue row and re-reconciling them whenever a row changes
 * — real work, and work this module does not do.
 */
export const QUEUE_STORED_ONLY_REASON =
  'Topic, partition and poll settings describe a Kafka topic and consumer group. ' +
  'RuleEngineConsumer subscribes a single group to the single "rules.input" topic ' +
  'at boot, and KafkaService.createConsumer() accepts no partition or poll options, ' +
  'so these values are stored for a future per-queue transport and are not read today.';
