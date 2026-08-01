import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AttributesAlarmEnhancements
 *
 * Hand-written rather than produced by `migration:generate`. Per CLAUDE.md §11
 * the generator currently also wants to create 8 assignment junction tables,
 * narrow `solution_templates_category_enum` (destructive — it drops 6 in-use
 * values), rebuild the firmware indexes and rewrite several jsonb defaults.
 * None of that belongs in this change, so only the intended statements are
 * written out here.
 *
 * Two independent changes:
 *
 * 1. alarms — three nullable columns backing operator-clear attribution and
 *    alarm assignment. The `alarms_status_enum` is deliberately NOT touched:
 *    the ThingsBoard ACTIVE_UNACK / ACTIVE_ACK / CLEARED_UNACK / CLEARED_ACK
 *    matrix is derived at read time from `status` + `acknowledgedAt`
 *    (Alarm.computeTbStatus), which preserves INACTIVE (dormant device-profile
 *    rules) and RESOLVED (the operator resolve workflow) — neither of which
 *    ThingsBoard models and both of which a 4-value enum would have destroyed
 *    across 874 live rows.
 *
 * 2. attributes — widen the uniqueness key to include `scope`. Without this a
 *    key could exist only once per entity, so a device reporting
 *    `firmwareVersion` as a CLIENT attribute made it impossible to also push a
 *    SHARED `firmwareVersion`; the second write failed with a 23505. This is a
 *    relaxation, so no existing row can violate the new constraint.
 *
 * All statements are additive/widening and the down() restores the prior
 * shape exactly. down() will fail if the narrower attribute index cannot be
 * rebuilt because rows now differ only by scope — that is intentional, since
 * silently deleting those rows would be worse.
 */
export class AttributesAlarmEnhancements1785588000000
  implements MigrationInterface
{
  name = 'AttributesAlarmEnhancements1785588000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── alarms: clear attribution + assignment ─────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "alarms"
        ADD COLUMN IF NOT EXISTS "clearedBy"  uuid      NULL,
        ADD COLUMN IF NOT EXISTS "assignedTo" uuid      NULL,
        ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP NULL
    `);

    // Assignment inbox: "alarms assigned to me, worst first".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_alarms_tenant_assigned"
        ON "alarms" ("tenantId", "assignedTo")
        WHERE "assignedTo" IS NOT NULL
    `);

    // ── attributes: scope must be part of the uniqueness key ───────────────
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_7669ab343ee217f668ace1393b"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_attributes_tenant_entity_key_scope"
        ON "attributes" ("tenantId", "entityType", "entityId", "attributeKey", "scope")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting the attribute index requires that no two rows differ only by
    // scope. If any do, this DROP/CREATE fails loudly rather than discarding
    // attribute data.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_attributes_tenant_entity_key_scope"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_7669ab343ee217f668ace1393b"
        ON "attributes" ("tenantId", "entityType", "entityId", "attributeKey")
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_alarms_tenant_assigned"
    `);
    await queryRunner.query(`
      ALTER TABLE "alarms"
        DROP COLUMN IF EXISTS "assignedAt",
        DROP COLUMN IF EXISTS "assignedTo",
        DROP COLUMN IF EXISTS "clearedBy"
    `);
  }
}
