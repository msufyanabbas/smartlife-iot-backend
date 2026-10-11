import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * rule_chain_templates: reusable rule chain definitions.
 *
 * The frontend has shipped a "Rule Chain Templates" page and a "Create Rule
 * Chain Template" form since early on, both rendering hardcoded arrays against
 * no backend at all — the "Use" button had no handler and the create form's
 * submit was a `console.log`. This is the table behind them.
 *
 * ── Why one table for built-ins and tenant templates ────────────────────────
 * `tenantId` is NULLABLE. A built-in template (`isBuiltIn`, `tenantId IS NULL`)
 * belongs to the platform and is visible to every tenant; a saved one belongs
 * to the tenant that saved it. Every read is
 * `tenantId = :tenantId OR isBuiltIn = true`.
 *
 * The alternative — serving built-ins straight from the code catalogue and
 * never storing them — cannot count usage, which is the one number the card
 * grid shows, and makes "list templates" a merge of two sources with different
 * pagination. `RuleChainTemplatesService.syncBuiltIns()` upserts them from
 * `rule-chain-template-catalogue.ts` at boot instead, so the definitions stay
 * in version control and a deploy can correct one.
 *
 * ── Column types ────────────────────────────────────────────────────────────
 * `tenantId` is `uuid` with a foreign key to `tenants(id)`, because the entity
 * declares `@ManyToOne('Tenant')` against it: that makes it a join column, so
 * the type comes from the referenced key and the FK exists whether or not this
 * migration creates it. Writing `character varying` here instead — as
 * `integration_events.tenantId` correctly does, since THAT column has no
 * relation — leaves the migration permanently at odds with the schema
 * `synchronize` builds, which is how a "works locally, drifts in production"
 * bug starts. The NULL a built-in carries satisfies the FK fine.
 *
 * `userId` is deliberately the other way round: `character varying`, no FK. A
 * template is a tenant asset that outlives whoever saved it.
 *
 * `slug` gets a plain UNIQUE constraint rather than a partial index, matching
 * the entity's `unique: true`. PostgreSQL treats NULLs as distinct, so the
 * tenant templates — which all carry NULL — do not collide.
 *
 * down() drops the table, which also discards saved tenant templates — the
 * chains created from them are separate rows in `rule_chains` and are not
 * touched.
 */
export class RuleChainTemplates1787500000000 implements MigrationInterface {
  name = 'RuleChainTemplates1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rule_chain_templates" (
        "id"          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMP,
        "created_by"  character varying,
        "updated_by"  character varying,
        "deleted_by"  character varying,
        "tenantId"    uuid,
        "userId"      character varying,
        "name"        character varying NOT NULL,
        "description" text,
        "category"    character varying NOT NULL DEFAULT 'General',
        "icon"        character varying,
        "slug"        character varying,
        "isBuiltIn"   boolean NOT NULL DEFAULT false,
        "definition"  jsonb NOT NULL,
        "usageCount"  integer NOT NULL DEFAULT 0,
        "lastUsedAt"  TIMESTAMP,
        CONSTRAINT "UQ_rule_chain_templates_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_rule_chain_templates_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
      )
    `);

    // The grid filters by category within a tenant; the built-in flag backs the
    // "platform templates" scope and the boot-time upsert.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rule_chain_templates_tenant_category"
        ON "rule_chain_templates" ("tenantId", "category")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_rule_chain_templates_builtin"
        ON "rule_chain_templates" ("isBuiltIn")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "rule_chain_templates"`);
  }
}
