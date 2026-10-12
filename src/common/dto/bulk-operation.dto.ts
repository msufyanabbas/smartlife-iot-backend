// src/common/dto/bulk-operation.dto.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BULK OPERATION CONTRACT
//
// One shape, used by every bulk endpoint on the platform. The three rules it
// encodes, and why:
//
// 1. PARTIAL SUCCESS IS THE NORMAL CASE.
//    A bulk delete of 50 ids where 3 belong to another tenant is not a failed
//    request — it is a request with 47 successes and 3 rejections, and the
//    caller needs to know which 3 and why. Every bulk route therefore answers
//    HTTP 200 with one `BulkItemResultDto` per requested id. It never throws
//    away the successes, and it never collapses the answer to a boolean or a
//    count.
//
// 2. THE BATCH IS CAPPED IN THE DTO.
//    `BULK_MAX_IDS` is enforced by `@ArrayMaxSize` on `BulkIdsDto`, so a
//    request for 100,000 deletes is rejected by the global ValidationPipe with
//    a 400 before a single row is read. The cap is part of the route docs.
//
// 3. EVERY ID IS RE-CHECKED AGAINST THE CALLER'S tenantId SERVER-SIDE.
//    That is not expressible in a DTO, so it lives in each service — but the
//    shape below is what makes it reportable: an id that exists in another
//    tenant comes back as NOT_FOUND, indistinguishable from an id that does
//    not exist at all, which is the correct answer to give a caller who should
//    not learn that the row exists.
//
// Ids must be UUIDs. A malformed id fails DTO validation and 400s the whole
// request rather than coming back as a per-item failure: it cannot even be
// used in a query, and letting it through would push a cast error into the SQL
// layer.
// ─────────────────────────────────────────────────────────────────────────────

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/**
 * Maximum number of ids one bulk request may carry.
 *
 * 100 is chosen to match `PaginationDto`'s own `@Max(100)` page size: a UI
 * that can show at most one page of rows can select at most one page of rows,
 * so a "select all on this page → delete" action always fits in one request.
 * Each item runs in its own transaction (see below), so the cap is also the
 * bound on how many transactions one request can open.
 */
export const BULK_MAX_IDS = 100;

/**
 * Why an individual id did or did not succeed.
 *
 * `NOT_FOUND` deliberately covers both "no such row" and "that row belongs to
 * another tenant" — see rule 3 above.
 */
export enum BulkOutcome {
  /** The operation was applied to this row. */
  SUCCESS = 'success',
  /** No such row inside the caller's scope. Also what a foreign tenant's id returns. */
  NOT_FOUND = 'not_found',
  /** The row exists and is in scope, but a referential or state rule forbids the operation. */
  BLOCKED = 'blocked',
  /** The row exists and was allowed, but the write itself failed. */
  FAILED = 'failed',
  /** Nothing to do — the row is already in the requested state. Counted as a success. */
  SKIPPED = 'skipped',
}

export class BulkItemResultDto {
  @ApiProperty({ example: '7b1f9c22-1f0e-4a4e-8f4e-0b2f9a1c3d4e' })
  id: string;

  @ApiProperty({ enum: BulkOutcome, enumName: 'BulkOutcome' })
  outcome: BulkOutcome;

  @ApiPropertyOptional({
    description:
      'Human-readable explanation. Always present unless the outcome is SUCCESS.',
    example: 'Device has 2 active alarm(s); acknowledge or clear them first',
  })
  reason?: string;
}

export class BulkResultDto {
  @ApiProperty({
    description:
      'Number of distinct ids processed. Duplicate ids in the request collapse to one.',
    example: 50,
  })
  requested: number;

  @ApiProperty({ description: 'Ids with outcome SUCCESS or SKIPPED.', example: 47 })
  succeeded: number;

  @ApiProperty({
    description: 'Ids with outcome NOT_FOUND, BLOCKED or FAILED.',
    example: 3,
  })
  failed: number;

  @ApiProperty({
    type: [BulkItemResultDto],
    description: 'One entry per distinct requested id, in request order.',
  })
  outcomes: BulkItemResultDto[];
}

/**
 * Base DTO for every bulk request body.
 *
 * `ids` rather than `deviceIds` / `userIds` on purpose: four slightly
 * different field names for the same thing is exactly the inconsistency these
 * endpoints exist to avoid. The older per-module bulk DTOs
 * (`BulkDeleteUsersDto`, `BulkUpdateCustomerStatusDto`, …) keep their own
 * names because changing them would break their existing routes.
 */
export class BulkIdsDto {
  @ApiProperty({
    type: [String],
    maxItems: BULK_MAX_IDS,
    description: `Row ids to operate on. At most ${BULK_MAX_IDS} per request; duplicates are collapsed.`,
    example: [
      '7b1f9c22-1f0e-4a4e-8f4e-0b2f9a1c3d4e',
      '2c4d6e80-9a1b-4c3d-8e5f-1a2b3c4d5e6f',
    ],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(BULK_MAX_IDS)
  @IsUUID(undefined, { each: true })
  ids: string[];
}

/**
 * Accumulates per-id outcomes and renders the response.
 *
 * Construct it with the requested ids, record an outcome for each, then
 * `build()`. Any id never recorded comes back as FAILED rather than silently
 * vanishing — a missing entry would let a service drop rows on the floor and
 * still look like it succeeded.
 */
export class BulkResultBuilder {
  private readonly order: string[];
  private readonly outcomes = new Map<string, BulkItemResultDto>();

  constructor(ids: string[]) {
    // Distinct, first-seen order. A duplicated id must not be deleted twice
    // (and must not be counted twice in a usage counter).
    this.order = [...new Set(ids)];
  }

  /** The distinct ids to process, in request order. */
  get ids(): string[] {
    return this.order;
  }

  private record(id: string, outcome: BulkOutcome, reason?: string): void {
    this.outcomes.set(id, reason ? { id, outcome, reason } : { id, outcome });
  }

  success(id: string): void {
    this.record(id, BulkOutcome.SUCCESS);
  }

  skipped(id: string, reason: string): void {
    this.record(id, BulkOutcome.SKIPPED, reason);
  }

  notFound(id: string, reason = 'Not found'): void {
    this.record(id, BulkOutcome.NOT_FOUND, reason);
  }

  blocked(id: string, reason: string): void {
    this.record(id, BulkOutcome.BLOCKED, reason);
  }

  failed(id: string, reason: string): void {
    this.record(id, BulkOutcome.FAILED, reason);
  }

  /** Ids that came back SUCCESS — what a counter adjustment should be sized on. */
  successfulIds(): string[] {
    return this.order.filter(
      (id) => this.outcomes.get(id)?.outcome === BulkOutcome.SUCCESS,
    );
  }

  build(): BulkResultDto {
    const outcomes = this.order.map(
      (id) =>
        this.outcomes.get(id) ?? {
          id,
          outcome: BulkOutcome.FAILED,
          reason: 'Not processed',
        },
    );

    const succeeded = outcomes.filter(
      (o) => o.outcome === BulkOutcome.SUCCESS || o.outcome === BulkOutcome.SKIPPED,
    ).length;

    return {
      requested: outcomes.length,
      succeeded,
      failed: outcomes.length - succeeded,
      outcomes,
    };
  }
}
