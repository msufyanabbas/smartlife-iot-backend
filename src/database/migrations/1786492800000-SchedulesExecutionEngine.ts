import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SchedulesExecutionEngine
 *
 * Hand-written rather than produced by `migration:generate`. Per CLAUDE.md §11
 * the generator currently also wants to create 8 assignment junction tables,
 * narrow `solution_templates_category_enum` (destructive — it drops 6 in-use
 * values), rebuild the firmware indexes and rewrite several jsonb defaults.
 * None of that belongs in this change, so only the intended statements are
 * written out here.
 *
 * Turns `schedules` from a timer that emitted unheard events into one that
 * performs real actions. Three groups of changes:
 *
 * 1. Split timing from behaviour. `type` used to hold REPORT | BACKUP |
 *    CLEANUP | EXPORT | DEVICE_COMMAND — *what* a schedule did, with the
 *    timing implicitly always cron. It now holds CRON | INTERVAL | ONE_TIME
 *    and the behaviour moves to the new `actionType` column. `type` becomes
 *    varchar so a future timing mode needs no migration (same idiom as
 *    `device_profiles.transportType`).
 *
 * 2. Rename the tracking columns to the names the runner uses, rather than
 *    adding parallel ones: schedule→cronExpression, lastRun→lastRunAt,
 *    nextRun→nextRunAt, executionCount→runCount, failureCount→failCount,
 *    lastError→lastRunError. RENAME preserves the data; ADD + backfill +
 *    DROP would not preserve it any better and would leave two counters free
 *    to drift apart.
 *
 * 3. Replace `schedule_execution_logs` with `schedule_executions`. The old
 *    table was written by the executor and read only by the history endpoint,
 *    and holds zero rows in every environment checked (local: 0). It carries
 *    no BaseEntity audit columns, and its two PG enums would need widening
 *    anyway. Dropped rather than migrated.
 *
 * ── Every pre-existing schedule is DISABLED by this migration ──────────────
 *
 * Deliberate, and the single most important line in the file. Before this
 * change all five action handlers ended in `eventEmitter.emitAsync(...)` with
 * no subscriber anywhere in the codebase — an enabled schedule provably did
 * nothing. After it, the same row would queue device commands or soft-delete
 * telemetry on its next tick. Silently arming previously inert schedules to
 * take real, partly destructive action is not an acceptable side effect of
 * running a migration, so operators re-enable what they want after reviewing
 * the mapped `actionConfig`. `down()` cannot restore the flag because the
 * pre-migration value is not recoverable; it is left as-is and noted below.
 *
 * ── Legacy action mapping ──────────────────────────────────────────────────
 *
 *   REPORT         → GENERATE_REPORT  (DEVICE_SUMMARY, 24h, IN_APP)
 *   EXPORT         → GENERATE_REPORT  (DEVICE_SUMMARY, 30d, IN_APP)
 *   CLEANUP        → DATA_MAINTENANCE (ARCHIVE_TELEMETRY, retention days
 *                                      carried over from `configuration`)
 *   BACKUP         → DATA_MAINTENANCE (RECALCULATE_STATS — a read-mostly
 *                                      no-op placeholder; the engine has no
 *                                      backup action and mapping a backup to
 *                                      ARCHIVE_TELEMETRY would turn "keep a
 *                                      copy" into "soft-delete the originals")
 *   DEVICE_COMMAND → DEVICE_COMMAND   (targetType DEVICE, the old flat
 *                                      {deviceId, command, params} nested into
 *                                      {command:{method, params}})
 *
 * The original `configuration` jsonb is preserved verbatim under
 * `actionConfig._legacyConfiguration` on every migrated row, so nothing an
 * operator configured is lost even where the mapping is approximate.
 */
export class SchedulesExecutionEngine1786492800000
  implements MigrationInterface
{
  name = 'SchedulesExecutionEngine1786492800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. schedules: rename tracking columns ───────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "schedule" TO "cronExpression"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "lastRun" TO "lastRunAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "nextRun" TO "nextRunAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "executionCount" TO "runCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "failureCount" TO "failCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "lastError" TO "lastRunError"`,
    );

    // cronExpression is only required for type=CRON; nextRunAt is null for a
    // spent ONE_TIME, a disabled schedule, or one past its endTime.
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "cronExpression" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "nextRunAt" DROP NOT NULL`,
    );

    // ── 2. schedules: new timing columns ────────────────────────────────────
    await queryRunner.query(`ALTER TABLE "schedules" ADD "intervalMs" bigint`);
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD "startTime" TIMESTAMP`,
    );
    await queryRunner.query(`ALTER TABLE "schedules" ADD "endTime" TIMESTAMP`);
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD "timezone" character varying NOT NULL DEFAULT 'Asia/Riyadh'`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD "lastRunStatus" character varying`,
    );

    // ── 3. schedules: action columns ────────────────────────────────────────
    // Added nullable, backfilled, then constrained — an existing row cannot
    // satisfy a NOT NULL column that has no default.
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD "actionType" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "schedules" ADD "actionConfig" jsonb`);

    await queryRunner.query(`
      UPDATE "schedules" SET
        "actionType" = CASE "type"::text
          WHEN 'REPORT'         THEN 'GENERATE_REPORT'
          WHEN 'EXPORT'         THEN 'GENERATE_REPORT'
          WHEN 'CLEANUP'        THEN 'DATA_MAINTENANCE'
          WHEN 'BACKUP'         THEN 'DATA_MAINTENANCE'
          WHEN 'DEVICE_COMMAND' THEN 'DEVICE_COMMAND'
          ELSE 'GENERATE_REPORT'
        END,
        "actionConfig" = CASE "type"::text
          WHEN 'REPORT' THEN jsonb_build_object(
            'report', jsonb_build_object(
              'reportType', 'DEVICE_SUMMARY',
              'timeRange', '24h',
              'deliveryChannels', jsonb_build_array('IN_APP')),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
          WHEN 'EXPORT' THEN jsonb_build_object(
            'report', jsonb_build_object(
              'reportType', 'DEVICE_SUMMARY',
              'timeRange', '30d',
              'deliveryChannels', jsonb_build_array('IN_APP')),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
          WHEN 'CLEANUP' THEN jsonb_build_object(
            'maintenance', jsonb_build_object(
              'taskType', 'ARCHIVE_TELEMETRY',
              -- retention was the operator's stated keep-window; honour it
              -- rather than silently defaulting to 90.
              'olderThanDays', COALESCE(
                NULLIF(("configuration" ->> 'retention'), '')::int, 90)),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
          WHEN 'BACKUP' THEN jsonb_build_object(
            'maintenance', jsonb_build_object('taskType', 'RECALCULATE_STATS'),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
          WHEN 'DEVICE_COMMAND' THEN jsonb_build_object(
            'deviceCommand', jsonb_build_object(
              'targetType', 'DEVICE',
              'deviceId', "configuration" ->> 'deviceId',
              'command', jsonb_build_object(
                'method', COALESCE("configuration" ->> 'command', 'noop'),
                'params', COALESCE("configuration" -> 'params', '{}'::jsonb))),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
          ELSE jsonb_build_object(
            'report', jsonb_build_object(
              'reportType', 'DEVICE_SUMMARY',
              'timeRange', '24h',
              'deliveryChannels', jsonb_build_array('IN_APP')),
            '_legacyConfiguration', COALESCE("configuration", '{}'::jsonb))
        END
    `);

    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "actionType" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "actionConfig" SET NOT NULL`,
    );

    // ── 4. schedules: convert `type` from action-enum to timing-varchar ─────
    // Index on the enum column must go before the type change.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_a0d447b152d0cee29daa17ccc6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "type" TYPE character varying USING "type"::text`,
    );
    // Everything that existed was cron-timed — the old model had no other mode.
    await queryRunner.query(`UPDATE "schedules" SET "type" = 'CRON'`);

    await queryRunner.query(
      `ALTER TABLE "schedules" DROP COLUMN "configuration"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."schedules_type_enum"`,
    );

    // ── 5. Disable every pre-existing schedule (see header) ─────────────────
    await queryRunner.query(
      `UPDATE "schedules" SET "enabled" = false, "nextRunAt" = NULL WHERE "enabled" = true`,
    );

    // ── 6. schedules: indexes ───────────────────────────────────────────────
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_136fa3ec4876e5aadee29fb856"`,
    ); // old nextRun
    await queryRunner.query(
      `CREATE INDEX "IDX_schedules_next_run_at" ON "schedules" ("nextRunAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedules_tenant_type" ON "schedules" ("tenantId", "type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedules_tenant_action_type" ON "schedules" ("tenantId", "actionType")`,
    );

    // ── 7. schedule_executions ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "schedule_executions" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMP,
        "created_by"  character varying,
        "updated_by"  character varying,
        "deleted_by"  character varying,
        "scheduleId"  uuid NOT NULL,
        "tenantId"    uuid NOT NULL,
        "status"      character varying NOT NULL,
        "triggeredBy" character varying NOT NULL DEFAULT 'CRON',
        "executedAt"  TIMESTAMP NOT NULL,
        "durationMs"  integer,
        "result"      text,
        "error"       text,
        "metadata"    jsonb,
        CONSTRAINT "PK_schedule_executions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "schedule_executions" ADD CONSTRAINT "FK_schedule_executions_schedule"
       FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedule_executions_schedule" ON "schedule_executions" ("scheduleId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedule_executions_schedule_executed" ON "schedule_executions" ("scheduleId", "executedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedule_executions_tenant_executed" ON "schedule_executions" ("tenantId", "executedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedule_executions_schedule_status" ON "schedule_executions" ("scheduleId", "status")`,
    );

    // ── 8. Drop the superseded log table ────────────────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_execution_logs"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."schedule_execution_logs_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."schedule_execution_logs_triggeredby_enum"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the schema. Two things cannot be restored and are not faked:
    //   · `enabled` — the pre-migration value is gone (see header). Rows come
    //     back disabled, which is the safe direction.
    //   · rows in `schedule_executions` — the old table had no equivalent
    //     shape and was empty when replaced.
    await queryRunner.query(`DROP TABLE IF EXISTS "schedule_executions"`);

    await queryRunner.query(`
      CREATE TYPE "public"."schedule_execution_logs_status_enum" AS ENUM('success', 'failed', 'skipped')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."schedule_execution_logs_triggeredby_enum" AS ENUM('cron', 'manual')
    `);
    await queryRunner.query(`
      CREATE TABLE "schedule_execution_logs" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scheduleId"  uuid NOT NULL,
        "tenantId"    character varying NOT NULL,
        "status"      "public"."schedule_execution_logs_status_enum" NOT NULL,
        "triggeredBy" "public"."schedule_execution_logs_triggeredby_enum" NOT NULL,
        "startedAt"   TIMESTAMP NOT NULL DEFAULT now(),
        "finishedAt"  TIMESTAMP,
        "durationMs"  integer,
        "output"      jsonb,
        CONSTRAINT "PK_schedule_execution_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "schedule_execution_logs" ADD CONSTRAINT "FK_schedule_execution_logs_schedule"
       FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_schedule_execution_logs_schedule" ON "schedule_execution_logs" ("scheduleId")`,
    );

    // schedules indexes
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_schedules_tenant_action_type"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_schedules_tenant_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_schedules_next_run_at"`);

    // schedules: rebuild `configuration` from the preserved legacy blob
    await queryRunner.query(
      `ALTER TABLE "schedules" ADD "configuration" jsonb`,
    );
    await queryRunner.query(
      `UPDATE "schedules" SET "configuration" =
         COALESCE("actionConfig" -> '_legacyConfiguration', '{}'::jsonb)`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "configuration" SET NOT NULL`,
    );

    // schedules: `type` back to the action enum, derived from actionType
    await queryRunner.query(`
      CREATE TYPE "public"."schedules_type_enum" AS ENUM(
        'REPORT', 'BACKUP', 'CLEANUP', 'EXPORT', 'DEVICE_COMMAND')
    `);
    await queryRunner.query(`
      UPDATE "schedules" SET "type" = CASE "actionType"
        WHEN 'DEVICE_COMMAND'  THEN 'DEVICE_COMMAND'
        WHEN 'DATA_MAINTENANCE' THEN 'CLEANUP'
        ELSE 'REPORT'
      END
    `);
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "type" TYPE "public"."schedules_type_enum"
       USING "type"::"public"."schedules_type_enum"`,
    );

    await queryRunner.query(
      `ALTER TABLE "schedules" DROP COLUMN "actionConfig"`,
    );
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "actionType"`);
    await queryRunner.query(
      `ALTER TABLE "schedules" DROP COLUMN "lastRunStatus"`,
    );
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "timezone"`);
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "endTime"`);
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "startTime"`);
    await queryRunner.query(`ALTER TABLE "schedules" DROP COLUMN "intervalMs"`);

    // The old columns were NOT NULL; supply values before reinstating that.
    await queryRunner.query(
      `UPDATE "schedules" SET "cronExpression" = COALESCE("cronExpression", '0 0 * * *')`,
    );
    await queryRunner.query(
      `UPDATE "schedules" SET "nextRunAt" = COALESCE("nextRunAt", now())`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "cronExpression" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" ALTER COLUMN "nextRunAt" SET NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "lastRunError" TO "lastError"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "failCount" TO "failureCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "runCount" TO "executionCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "nextRunAt" TO "nextRun"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "lastRunAt" TO "lastRun"`,
    );
    await queryRunner.query(
      `ALTER TABLE "schedules" RENAME COLUMN "cronExpression" TO "schedule"`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_136fa3ec4876e5aadee29fb856" ON "schedules" ("nextRun")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a0d447b152d0cee29daa17ccc6" ON "schedules" ("tenantId", "type")`,
    );
  }
}
