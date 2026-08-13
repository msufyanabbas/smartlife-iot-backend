import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Edge Management Phase 1.
 *
 * Replaces the `edge_instances` registry with `edge_devices`, adds the
 * `edge_events` audit trail, and rebuilds `edge_commands` around the new verb
 * set and uppercase status values.
 *
 * This is a DROP-and-CREATE rather than a series of ALTERs, which is safe here
 * for one specific reason: all three edge tables were empty (verified: 0 rows in
 * edge_instances, edge_commands and edge_metrics_snapshots, and 0 devices with a
 * non-null edgeId). Nothing is lost. If that ever stops being true this
 * migration must be rewritten as a rename + column-add.
 *
 * Two foreign keys point at the old table and are repointed:
 *   • devices.edgeId               (ON DELETE SET NULL — unassign, never cascade
 *                                   a device delete from an edge delete)
 *   • edge_metrics_snapshots.edgeId (ON DELETE CASCADE — history dies with it)
 *
 * `edge_metrics_snapshots` itself is kept as-is: it stores the per-heartbeat
 * time series behind GET /edge/:id/metrics/history, which has no equivalent in
 * the new `systemMetrics` column (that holds only the latest sample).
 */
export class EdgeManagement1786800000000 implements MigrationInterface {
  name = 'EdgeManagement1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Detach everything pointing at the old registry ───────────────────
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "FK_cc6b30da450d7b6ae1b00cfc44d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_metrics_snapshots" DROP CONSTRAINT IF EXISTS "FK_02ecbbc8f7bc655bcf355157e51"`,
    );

    // ── 2. Drop the old tables and their enum types ─────────────────────────
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_commands"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_instances"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."edge_commands_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."edge_instances_status_enum"`);

    // ── 3. edge_devices ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "edge_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "tenantId" uuid NOT NULL,
        "customerId" uuid,
        "userId" uuid,
        "name" character varying NOT NULL,
        "description" text,
        "type" character varying NOT NULL DEFAULT 'GATEWAY',
        "edgeKey" character varying,
        "edgeSecret" character varying,
        "status" character varying NOT NULL DEFAULT 'inactive',
        "lastSeenAt" TIMESTAMP,
        "lastSyncAt" TIMESTAMP,
        "lastSyncStatus" character varying,
        "ipAddress" character varying,
        "macAddress" character varying,
        "firmwareVersion" character varying,
        "agentVersion" character varying,
        "osInfo" character varying,
        "location" character varying,
        "latitude" double precision,
        "longitude" double precision,
        "syncConfig" jsonb,
        "assignedRuleChainIds" jsonb,
        "assignedDashboardIds" jsonb,
        "connectedDeviceCount" integer NOT NULL DEFAULT 0,
        "messagesPerMinute" integer NOT NULL DEFAULT 0,
        "uptimePercentage" double precision NOT NULL DEFAULT 0,
        "totalMessagesProcessed" integer NOT NULL DEFAULT 0,
        "systemMetrics" jsonb,
        "tags" jsonb,
        "additionalInfo" jsonb,
        CONSTRAINT "PK_edge_devices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_edge_devices_edgeKey" UNIQUE ("edgeKey")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_devices_tenant_status" ON "edge_devices" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_devices_tenant_customer" ON "edge_devices" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_devices_status" ON "edge_devices" ("status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "FK_edge_devices_tenant"
       FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "FK_edge_devices_customer"
       FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_devices" ADD CONSTRAINT "FK_edge_devices_user"
       FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ── 4. edge_events ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "edge_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "edgeId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "message" character varying,
        "data" jsonb,
        "severity" character varying NOT NULL DEFAULT 'info',
        CONSTRAINT "PK_edge_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_events_edge" ON "edge_events" ("edgeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_events_edge_created" ON "edge_events" ("edgeId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_events_tenant_created" ON "edge_events" ("tenantId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_events_edge_severity" ON "edge_events" ("edgeId", "severity")`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_events" ADD CONSTRAINT "FK_edge_events_edge"
       FOREIGN KEY ("edgeId") REFERENCES "edge_devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ── 5. edge_commands (rebuilt) ──────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "edge_commands" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "edgeId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "payload" jsonb,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "sentAt" TIMESTAMP,
        "deliveredAt" TIMESTAMP,
        "executedAt" TIMESTAMP,
        "error" text,
        "createdByUserId" uuid,
        CONSTRAINT "PK_edge_commands" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_commands_edge" ON "edge_commands" ("edgeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_commands_edge_status" ON "edge_commands" ("edgeId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edge_commands_tenant_created" ON "edge_commands" ("tenantId", "created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_commands" ADD CONSTRAINT "FK_edge_commands_edge"
       FOREIGN KEY ("edgeId") REFERENCES "edge_devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ── 6. Repoint the two surviving foreign keys ───────────────────────────
    await queryRunner.query(
      `ALTER TABLE "edge_metrics_snapshots" ADD CONSTRAINT "FK_edge_metrics_snapshots_edge"
       FOREIGN KEY ("edgeId") REFERENCES "edge_devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "FK_devices_edge"
       FOREIGN KEY ("edgeId") REFERENCES "edge_devices"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "FK_devices_edge"`,
    );
    await queryRunner.query(
      `ALTER TABLE "edge_metrics_snapshots" DROP CONSTRAINT IF EXISTS "FK_edge_metrics_snapshots_edge"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_commands"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "edge_devices"`);

    // Recreate the previous registry so the schema is restorable. Data is not:
    // the tables it replaced were empty when this migration ran.
    await queryRunner.query(
      `CREATE TYPE "public"."edge_instances_status_enum" AS ENUM('ONLINE','OFFLINE','SYNCING','ERROR')`,
    );
    await queryRunner.query(`
      CREATE TABLE "edge_instances" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "created_by" character varying,
        "updated_by" character varying,
        "deleted_by" character varying,
        "tenantId" uuid NOT NULL,
        "customerId" uuid,
        "userId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "description" text,
        "location" character varying,
        "status" "public"."edge_instances_status_enum" NOT NULL DEFAULT 'OFFLINE',
        "version" character varying NOT NULL,
        "ipAddress" character varying,
        "macAddress" character varying,
        "hostname" character varying,
        "lastSeen" TIMESTAMP,
        "edgeToken" character varying NOT NULL,
        "deviceCount" integer NOT NULL DEFAULT 0,
        "metrics" jsonb,
        "dataSync" jsonb,
        "config" jsonb,
        "tags" text,
        "additionalInfo" jsonb,
        CONSTRAINT "PK_edge_instances" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_edge_instances_edgeToken" UNIQUE ("edgeToken")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "edge_metrics_snapshots" ADD CONSTRAINT "FK_02ecbbc8f7bc655bcf355157e51"
       FOREIGN KEY ("edgeId") REFERENCES "edge_instances"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "FK_cc6b30da450d7b6ae1b00cfc44d"
       FOREIGN KEY ("edgeId") REFERENCES "edge_instances"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }
}
