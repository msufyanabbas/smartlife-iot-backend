import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Automation execution engine.
 *
 * - `automations` gains conditions / actions / success+failure counters and
 *   `lastExecutedAt`; the v1 single-`action` column becomes nullable and every
 *   existing row is backfilled into the new multi-action shape.
 * - `tags` moves from TypeORM `simple-array` (comma-joined text) to jsonb.
 * - `automation_logs` is rebuilt to match the AutomationLog entity. The table
 *   existed out-of-band (created by an earlier `schema:sync`, never by a
 *   migration) with a different column set and zero rows, so it is dropped
 *   rather than patched column by column.
 * - `notifications_type_enum` gains 'automation' for SEND_NOTIFICATION.
 */
export class AutomationEngine1787300000000 implements MigrationInterface {
  name = 'AutomationEngine1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── notifications.type: new member ──────────────────────────────────────
    // PG 12+ permits ADD VALUE inside a transaction as long as the new label
    // is not *used* before commit. Nothing below inserts a notification.
    await queryRunner.query(
      `ALTER TYPE "notifications_type_enum" ADD VALUE IF NOT EXISTS 'automation'`,
    );

    // ── automations: new columns ────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "conditions" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "actions" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "successCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "failureCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "lastExecutedAt" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "lastExecutionStatus" character varying`,
    );

    // The v1 engine required exactly one action; the v2 engine stores a list.
    await queryRunner.query(
      `ALTER TABLE "automations" ALTER COLUMN "action" DROP NOT NULL`,
    );

    // ── tags: simple-array (text) -> jsonb ──────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "automations"
      ALTER COLUMN "tags" TYPE jsonb
      USING CASE
        WHEN "tags" IS NULL OR "tags" = '' THEN NULL
        ELSE to_jsonb(string_to_array("tags", ','))
      END
    `);

    // ── carry lastExecuted -> lastExecutedAt before it is dropped ───────────
    await queryRunner.query(
      `UPDATE "automations" SET "lastExecutedAt" = "lastExecuted" WHERE "lastExecuted" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "lastExecuted"`,
    );

    // ── backfill v1 rows into the v2 shape ──────────────────────────────────
    // Done row by row rather than as one jsonb UPDATE: the mapping branches on
    // action type and trigger shape, and the table is small (one row per
    // user-defined automation, not per event).
    const legacyRows: Array<{ id: string; trigger: any; action: any }> =
      await queryRunner.query(
        `SELECT "id", "trigger", "action" FROM "automations"
         WHERE "actions" = '[]'::jsonb AND "action" IS NOT NULL`,
      );

    const operatorMap: Record<string, string> = {
      eq: 'EQ', ne: 'NEQ', gt: 'GT', gte: 'GTE',
      lt: 'LT', lte: 'LTE', between: 'BETWEEN',
    };
    const isUuid = (v: unknown) =>
      typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

    for (const row of legacyRows) {
      const trigger = row.trigger ?? {};
      const action = row.action ?? {};

      // -- trigger --------------------------------------------------------
      // threshold/event watch telemetry; state watches an attribute when it
      // names one. A `state` trigger on attributeKey 'status' is left as
      // ATTRIBUTE rather than guessed into DEVICE_STATUS.
      let newType: string;
      if (trigger.type === 'schedule') {
        newType = 'SCHEDULE';
      } else if (trigger.attributeKey && !trigger.telemetryKey) {
        newType = 'ATTRIBUTE';
      } else {
        newType = 'TELEMETRY';
      }

      const newTrigger: Record<string, any> = { ...trigger, type: newType };
      if (trigger.schedule && !trigger.cronExpression) {
        newTrigger.cronExpression = trigger.schedule;
      }

      // -- conditions ------------------------------------------------------
      const key = trigger.telemetryKey ?? trigger.attributeKey;
      const conditions: any[] = [];
      if (key && trigger.operator) {
        conditions.push({
          key,
          operator: operatorMap[trigger.operator] ?? String(trigger.operator).toUpperCase(),
          value: trigger.value,
          ...(trigger.value2 !== undefined ? { value2: trigger.value2 } : {}),
          type: trigger.attributeKey && !trigger.telemetryKey ? 'ATTRIBUTE' : 'TELEMETRY',
          logic: 'AND',
        });
      }

      // -- action -> actions ------------------------------------------------
      let newAction: Record<string, any> | null = null;
      switch (action.type) {
        case 'control':
        case 'setValue':
          newAction = {
            type: 'SEND_COMMAND',
            order: 1,
            config: {
              targetDeviceId: action.deviceId,
              commandType: action.command,
              command: { method: action.command, params: action.value },
            },
          };
          break;

        case 'notification':
          newAction = {
            type: 'SEND_NOTIFICATION',
            order: 1,
            config: {
              title: 'Automation triggered',
              message: action.message,
              channels: ['in_app'],
              // v1 allowed email addresses here; the engine resolves user ids,
              // so anything that is not a uuid is dropped and the notification
              // falls back to the automation owner.
              ...(Array.isArray(action.recipients) && action.recipients.some(isUuid)
                ? { recipients: action.recipients.filter(isUuid) }
                : {}),
            },
          };
          break;

        case 'webhook':
          newAction = {
            type: 'WEBHOOK',
            order: 1,
            config: {
              url: action.webhookUrl,
              method: action.webhookMethod ?? 'POST',
              headers: action.webhookHeaders,
              body: action.webhookBody,
            },
          };
          break;
      }

      await queryRunner.query(
        `UPDATE "automations"
         SET "trigger" = $2::jsonb, "conditions" = $3::jsonb, "actions" = $4::jsonb
         WHERE "id" = $1`,
        [
          row.id,
          JSON.stringify(newTrigger),
          JSON.stringify(conditions),
          JSON.stringify(newAction ? [newAction] : []),
        ],
      );
    }

    // A row wedged in ERROR by the v1 engine would be excluded from every
    // query forever; the v2 engine no longer sets that status on failure.
    await queryRunner.query(
      `UPDATE "automations" SET "status" = 'active'
       WHERE "status" = 'error' AND "enabled" = true`,
    );

    // ── automation_logs: rebuild to match the entity ────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_logs"`);
    await queryRunner.query(`
      CREATE TABLE "automation_logs" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMP,
        "created_by"       character varying,
        "updated_by"       character varying,
        "deleted_by"       character varying,
        "automationId"     uuid NOT NULL,
        "tenantId"         uuid NOT NULL,
        "status"           character varying NOT NULL,
        "durationMs"       integer NOT NULL DEFAULT 0,
        "triggerData"      jsonb,
        "conditionResults" jsonb,
        "actionResults"    jsonb,
        "error"            text,
        "deviceId"         uuid,
        "triggerType"      character varying,
        "triggeredBy"      uuid,
        "executedAt"       TIMESTAMP NOT NULL,
        CONSTRAINT "PK_automation_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "automation_logs" ADD CONSTRAINT "FK_automation_logs_automation"
       FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "automation_logs" ADD CONSTRAINT "FK_automation_logs_tenant"
       FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    // Primary read path: GET /automations/:id/logs, newest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_logs_tenant_automation_executed"
       ON "automation_logs" ("tenantId", "automationId", "executedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_logs_automationId" ON "automation_logs" ("automationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_automation_logs_tenant_status" ON "automation_logs" ("tenantId", "status")`,
    );

    // ── hot-path index ──────────────────────────────────────────────────────
    // Every telemetry frame loads the tenant's enabled automations and filters
    // by trigger type in memory; this is the index that lookup rides on.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_automations_trigger_type"
       ON "automations" ((("trigger" ->> 'type')))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automations_trigger_type"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_logs"`);

    await queryRunner.query(
      `ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "lastExecuted" TIMESTAMP`,
    );
    await queryRunner.query(
      `UPDATE "automations" SET "lastExecuted" = "lastExecutedAt"`,
    );
    await queryRunner.query(`
      ALTER TABLE "automations"
      ALTER COLUMN "tags" TYPE text
      USING CASE
        WHEN "tags" IS NULL THEN NULL
        ELSE array_to_string(ARRAY(SELECT jsonb_array_elements_text("tags")), ',')
      END
    `);
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "lastExecutionStatus"`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "lastExecutedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "failureCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "successCount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "actions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "automations" DROP COLUMN IF EXISTS "conditions"`,
    );

    // `action` is left nullable and 'automation' is left in
    // notifications_type_enum: PG cannot drop an enum label, and restoring the
    // NOT NULL would fail for any row created by the v2 engine.
  }
}
