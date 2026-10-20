import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The generic entity-relation graph — `entity_relations`.
 *
 * Column type notes, each of which is a lesson this repository already paid
 * for:
 *
 *  · **`tenantId` is `uuid` with a real FK**, because `EntityRelation`
 *    declares `@ManyToOne('Tenant')` against it. A join column takes the
 *    referenced key's type and gets a constraint whether a hand-written
 *    migration says so or not (§4f). `integration_events.tenantId` is
 *    correctly `varchar` precisely BECAUSE it has no relation. Getting this
 *    backwards leaves the migration permanently at odds with the schema
 *    `synchronize` builds.
 *
 *  · **`fromEntityType` / `toEntityType` / `relationGroup` are varchar, not PG
 *    enums.** The integrations table learned this the hard way: a new
 *    TypeScript enum member passes `@IsEnum` and the INSERT then fails with
 *    `invalid input value for enum`, which reads as a frontend bug for a day
 *    (§4e). Adding EDGE_EVENT or RULE_CHAIN to the vocabulary should be a code
 *    change, not a schema change.
 *
 *  · **The endpoints carry no foreign keys.** That is the point of the table —
 *    one row has to be able to point at any of eight tables — and it is why
 *    `RelationsService.create()` resolves both endpoints, tenant-pinned,
 *    before inserting.
 *
 * `migration:run` is blocked by the two never-applied drift migrations that
 * sort ahead of everything later (§11), so this one ships with its own runner:
 *
 *   npm run migration:relations <database> [up|down]
 */
export class EntityRelations1788100000000 implements MigrationInterface {
  name = 'EntityRelations1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "entity_relations" (
        "id"              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"      TIMESTAMP,
        "created_by"      character varying,
        "updated_by"      character varying,
        "deleted_by"      character varying,
        "tenantId"        uuid NOT NULL,
        "fromEntityType"  character varying(32) NOT NULL,
        "fromEntityId"    uuid NOT NULL,
        "toEntityType"    character varying(32) NOT NULL,
        "toEntityId"      uuid NOT NULL,
        "relationType"    character varying(255) NOT NULL,
        "relationGroup"   character varying(32) NOT NULL DEFAULT 'COMMON',
        "additionalInfo"  jsonb,
        CONSTRAINT "FK_entity_relations_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);

    // A plain UNIQUE constraint, matching the entity's @Unique. Soft-deleted
    // rows therefore DO still hold their slot — unlike `ai_models`, where a
    // partial index was used so that deleting "Primary" does not make the name
    // permanently unavailable. The trade is deliberate and opposite here: a
    // relation has no user-chosen name to hold hostage, and re-creating the
    // exact same edge after deleting it should restore the original row rather
    // than accumulate a second one. `RelationsService.create()` checks for a
    // live row first and the service soft-deletes, so the collision surfaces
    // as a 409 rather than a 500.
    await queryRunner.query(`
      ALTER TABLE "entity_relations"
        ADD CONSTRAINT "UQ_entity_relations_edge"
        UNIQUE ("tenantId", "fromEntityType", "fromEntityId",
                "relationType", "toEntityType", "toEntityId")
    `);

    // Both directions are hot and they are different queries: a detail page
    // asks "what does this feed?" and "what feeds this?" on one render, and
    // the recursive walk re-asks one of them once per level. One index would
    // leave every inbound lookup on a sequential scan of the tenant's graph.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_entity_relations_from"
        ON "entity_relations" ("tenantId", "fromEntityType", "fromEntityId", "relationType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_entity_relations_to"
        ON "entity_relations" ("tenantId", "toEntityType", "toEntityId", "relationType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_entity_relations_type"
        ON "entity_relations" ("tenantId", "relationType", "relationGroup")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_entity_relations_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_entity_relations_to"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_entity_relations_from"`);
    await queryRunner.query(
      `ALTER TABLE "entity_relations" DROP CONSTRAINT IF EXISTS "UQ_entity_relations_edge"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_relations"`);
  }
}
