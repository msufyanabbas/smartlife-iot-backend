import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SCADA mimic diagrams and the flattened binding index.
 *
 * `tenantId` is `uuid` with a real FK on both tables, because both entities
 * declare `@ManyToOne('Tenant')` against it — a join column takes the
 * referenced key's type and gets a constraint whether a hand-written migration
 * says so or not (the trap `AiModels1788000000000` documents; compare
 * `integration_events.tenantId`, which is correctly `varchar` precisely
 * BECAUSE it has no relation).
 *
 * `scada_element_bindings.deviceId` likewise carries an FK with ON DELETE
 * CASCADE, matching the `@ManyToOne('Device', { onDelete: 'CASCADE' })` on the
 * entity. Deleting a device removes its index rows, so "which diagrams use
 * this device" stops reporting a device that is gone — while the diagram's own
 * jsonb copy of the binding is left alone, because silently editing a saved
 * diagram would lose the operator's work where a binding stuck in its stale
 * state is visible and fixable.
 *
 * The geometry columns are jsonb, not element and connection tables. An editor
 * saves the WHOLE canvas atomically; splitting it into rows turns one UPDATE
 * into a transaction across three tables where a partial failure leaves
 * connections pointing at elements that were never inserted. `dashboards`
 * stores its widgets the same way for the same reason.
 *
 * `symbolKey`, `property` and `source` are varchar, NOT PG enums. The
 * integrations table learned this the hard way: a new TypeScript enum member
 * passes `@IsEnum` and then the INSERT fails with `invalid input value for
 * enum`, which reads like a frontend bug for a day. The symbol library grows
 * faster than migrations ship, and `@IsIn(SCADA_SYMBOL_KEYS)` on the DTO is
 * already the gate.
 *
 * Apply it with the standalone runner — `migration:run` is blocked by two
 * never-applied drift migrations that sort ahead of everything later and abort
 * the transaction (CLAUDE.md §11):
 *
 *   npm run migration:scada <database> [up|down]
 */
export class ScadaMimicDiagrams1788100000000 implements MigrationInterface {
  name = 'ScadaMimicDiagrams1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "scada_diagrams" (
        "id"                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"         TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"         TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"         TIMESTAMP,
        "created_by"         character varying,
        "updated_by"         character varying,
        "deleted_by"         character varying,
        "tenantId"           uuid NOT NULL,
        "customerId"         uuid,
        "name"               character varying(160) NOT NULL,
        "description"        text,
        "width"              integer NOT NULL DEFAULT 1600,
        "height"             integer NOT NULL DEFAULT 900,
        "background"         jsonb,
        "elements"           jsonb NOT NULL DEFAULT '[]'::jsonb,
        "connections"        jsonb NOT NULL DEFAULT '[]'::jsonb,
        "published"          boolean NOT NULL DEFAULT false,
        "publishedAt"        TIMESTAMP,
        "revision"           integer NOT NULL DEFAULT 1,
        "tags"               jsonb,
        "refreshIntervalMs"  integer,
        CONSTRAINT "FK_scada_diagrams_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);

    // Partial unique index rather than a plain UNIQUE: a soft-deleted row must
    // not hold its name hostage, or deleting "Boiler House" means you can
    // never create another diagram called "Boiler House".
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_scada_diagrams_tenant_name"
        ON "scada_diagrams" ("tenantId", "name") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_diagrams_tenant_published"
        ON "scada_diagrams" ("tenantId", "published")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_diagrams_tenant_customer"
        ON "scada_diagrams" ("tenantId", "customerId")
    `);
    // GIN on tags so `tags @> '["boiler"]'` in the list query is an index
    // lookup rather than a scan of every diagram in the tenant.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_diagrams_tags"
        ON "scada_diagrams" USING GIN ("tags")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "scada_element_bindings" (
        "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMP,
        "created_by"    character varying,
        "updated_by"    character varying,
        "deleted_by"    character varying,
        "tenantId"      uuid NOT NULL,
        "diagramId"     uuid NOT NULL,
        "elementId"     character varying(64) NOT NULL,
        "holder"        character varying(16) NOT NULL DEFAULT 'element',
        "symbolKey"     character varying(64) NOT NULL,
        "property"      character varying(32) NOT NULL,
        "source"        character varying(32) NOT NULL,
        "deviceId"      uuid,
        "telemetryKey"  character varying(160),
        "isAction"      boolean NOT NULL DEFAULT false,
        "method"        character varying(120),
        CONSTRAINT "FK_scada_bindings_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_scada_bindings_diagram"
          FOREIGN KEY ("diagramId") REFERENCES "scada_diagrams"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_scada_bindings_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_bindings_tenant_device"
        ON "scada_element_bindings" ("tenantId", "deviceId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_bindings_diagram"
        ON "scada_element_bindings" ("diagramId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_scada_bindings_tenant_device_key"
        ON "scada_element_bindings" ("tenantId", "deviceId", "telemetryKey")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scada_bindings_tenant_device_key"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scada_bindings_diagram"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scada_bindings_tenant_device"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "scada_element_bindings"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scada_diagrams_tags"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scada_diagrams_tenant_customer"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_scada_diagrams_tenant_published"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_scada_diagrams_tenant_name"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "scada_diagrams"`);
  }
}
