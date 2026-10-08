import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integration Centre: new provider types, and a real event log.
 *
 * ── integrations_type_enum ──────────────────────────────────────────────────
 * `integrations.type` is a Postgres ENUM, so a new TypeScript member alone is
 * not enough: the DTO's @IsEnum would accept the value and the INSERT would
 * then fail with `invalid input value for enum integrations_type_enum: "kafka"`.
 * That is exactly what happened before — the frontend offered an "Apache Kafka"
 * tile whose `type: 'kafka'` could never be stored.
 *
 * New labels:
 *   kafka             outbound, kafkajs producer
 *   azure_event_hub   outbound, Event Hubs REST + SAS
 *   ibm_watson        outbound, Watson IoT over MQTT
 *   coap              outbound, CoAP over UDP
 *   loriot            inbound, generic HTTP uplink
 *   sigfox            inbound, generic HTTP uplink
 *
 * `ADD VALUE IF NOT EXISTS` is safe inside a transaction on PostgreSQL 12+ as
 * long as the new label is not *used* before commit — nothing below inserts an
 * integration.
 *
 * ── integration_events ──────────────────────────────────────────────────────
 * A genuine append-only log. Until now the only record of what an integration
 * had done was `errorHistory`, a jsonb array on the row itself capped at the
 * last 10 failures, and `GET /integrations/recent-activity`, which synthesises
 * one entry per integration from its current column values — so two failures on
 * the same integration were indistinguishable from one, and successes left no
 * trace at all.
 *
 * Retention is the caller's job: `IntegrationEventsService.prune()` runs daily
 * and keeps INTEGRATION_EVENT_RETENTION_DAYS (default 14).
 *
 * down() drops the table but leaves the enum labels. PostgreSQL has no
 * `ALTER TYPE ... DROP VALUE`; removing one means recreating the type and
 * rewriting every dependent column, which is far more destructive than an
 * unused label.
 */
export class IntegrationCentre1787400000000 implements MigrationInterface {
  name = 'IntegrationCentre1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'kafka',
      'azure_event_hub',
      'ibm_watson',
      'coap',
      'loriot',
      'sigfox',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "integrations_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "integration_events" (
        "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMP,
        "created_by"    character varying,
        "updated_by"    character varying,
        "deleted_by"    character varying,
        "integrationId" uuid NOT NULL,
        "tenantId"      character varying NOT NULL,
        "direction"     character varying NOT NULL,
        "eventType"     character varying NOT NULL,
        "success"       boolean NOT NULL DEFAULT true,
        "message"       text,
        "deviceId"      uuid,
        "deviceKey"     character varying,
        "statusCode"    integer,
        "durationMs"    integer,
        "payload"       jsonb,
        CONSTRAINT "FK_integration_events_integration"
          FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE
      )
    `);

    // The feed is always "this integration, newest first", so one composite
    // index serves every read. The tenant index backs the cross-integration
    // view and the retention sweep.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_integration_events_integration_created"
        ON "integration_events" ("integrationId", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_integration_events_tenant_created"
        ON "integration_events" ("tenantId", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "integration_events"`);
    // Enum labels are intentionally left in place — see the class doc block.
  }
}
