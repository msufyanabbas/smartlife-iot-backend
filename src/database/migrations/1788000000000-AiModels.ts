import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The AI model registry.
 *
 * `tenantId` is `uuid` with a real FK, because `AiModel` declares
 * `@ManyToOne('Tenant')` against it — a join column takes the referenced
 * key's type and gets a constraint whether a hand-written migration says so
 * or not (see §4f; `integration_events.tenantId` is correctly `varchar`
 * precisely BECAUSE it has no relation). Getting this backwards leaves the
 * migration permanently at odds with the schema `synchronize` builds.
 *
 * `provider` is varchar, not a PG enum. The integrations table learned this
 * the hard way: a new TypeScript enum member passes `@IsEnum` and then the
 * INSERT fails with `invalid input value for enum`, which looked like a
 * frontend bug for a day. Providers appear faster than migrations ship.
 */
export class AiModels1788000000000 implements MigrationInterface {
  name = 'AiModels1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_models" (
        "id"                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"        TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"        TIMESTAMP,
        "created_by"        character varying,
        "updated_by"        character varying,
        "deleted_by"        character varying,
        "tenantId"          uuid NOT NULL,
        "name"              character varying(120) NOT NULL,
        "provider"          character varying(64) NOT NULL,
        "modelId"           character varying(200) NOT NULL,
        "description"       text,
        "apiKeyEncrypted"   text,
        "baseUrl"           character varying(500),
        "providerOptions"   jsonb,
        "temperature"       double precision,
        "topP"              double precision,
        "maxOutputTokens"   integer,
        "enabled"           boolean NOT NULL DEFAULT true,
        "lastCheckStatus"   character varying(32),
        "lastCheckMessage"  text,
        "lastCheckAt"       TIMESTAMP,
        "requestCount"      bigint NOT NULL DEFAULT 0,
        "lastUsedAt"        TIMESTAMP,
        CONSTRAINT "FK_ai_models_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);

    // Partial unique index rather than a plain UNIQUE: a soft-deleted row
    // must not hold its name hostage, or deleting "Primary" means you can
    // never create another model called "Primary".
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ai_models_tenant_name"
        ON "ai_models" ("tenantId", "name") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ai_models_tenant_enabled"
        ON "ai_models" ("tenantId", "enabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ai_models_tenant_provider"
        ON "ai_models" ("tenantId", "provider")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_models_tenant_provider"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ai_models_tenant_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_ai_models_tenant_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_models"`);
  }
}
