import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Safe half of the pre-existing entity/DB drift: creates the 10 resource
 * assignment junction tables that exist as entities
 * (src/modules/assignments/entities/resource-assignment.entities.ts) but have
 * never existed in the database. AssignmentService injects these repositories,
 * so every assignment endpoint fails against a missing relation until this runs.
 *
 * Deliberately additive only — every statement is CREATE ... IF NOT EXISTS and
 * foreign keys are declared inline in the CREATE TABLE rather than as separate
 * ADD CONSTRAINT statements (Postgres has no ADD CONSTRAINT IF NOT EXISTS, so
 * inlining is what makes a re-run a no-op).
 *
 * NOT included, on purpose — `migration:generate` also wants these, and each
 * is destructive or a behaviour change that needs its own reviewed migration:
 *
 *   1. Narrowing solution_templates_category_enum from 17 labels to 13.
 *      DESTRUCTIVE and it would abort: 'agriculture' is still used by
 *      "Precision Agriculture" (97cb23ba-…). No ALTER TYPE ... ADD VALUE is
 *      emitted here because there is nothing to add — every value the entity
 *      declares already exists in the database enum; the drift is purely in
 *      the removal direction.
 *   2. DROP INDEX of IDX_alarms_escalation_pending and IDX_alarms_tenant_assigned.
 *      The generator drops both and never recreates them (they are hand-written
 *      partial indexes it cannot model). IDX_alarms_escalation_pending is what
 *      AlarmConsumer's escalation sweep relies on.
 *   3. Replacing the attributes unique index with one that omits `scope`,
 *      which would forbid the same attribute key in two scopes.
 *   4. Cosmetic index renames on firmware / schedules / schedule_executions and
 *      jsonb default rewrites.
 */
export class SchemaDriftFix1786348092217 implements MigrationInterface {
  name = 'SchemaDriftFix1786348092217';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "customer_devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "customerId" uuid NOT NULL, "tenantId" character varying NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "deviceId" uuid NOT NULL, CONSTRAINT "UQ_c135a09b5317577c34d05477ca7" UNIQUE ("customerId", "deviceId"), CONSTRAINT "PK_3aaf111c9a1a0b07c9666bda1a1" PRIMARY KEY ("id"), CONSTRAINT "FK_fe5630d9fca9d3049a5effc7309" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_0df93ad9320ec774e634248dcf5" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_c92e741b13319766d684a895c2a" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_a73e9a00054afbc7c2669b0e2c" ON "customer_devices" ("tenantId", "deviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_54387b6e0a8f57e363b57453d6" ON "customer_devices" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "userId" uuid NOT NULL, "customerId" uuid NOT NULL, "tenantId" uuid NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "deviceId" uuid NOT NULL, CONSTRAINT "UQ_a3699a8ee632fc3527fec16a7d2" UNIQUE ("userId", "deviceId"), CONSTRAINT "PK_c9e7e648903a9e537347aba4371" PRIMARY KEY ("id"), CONSTRAINT "FK_e12ac4f8016243ac71fd2e415af" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_326a0ffb8f40a4b3e2506087e7c" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_acf8efbb50745982e4ed38fef97" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_97f675ffb3a8ae663039b96073c" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_e81c41e04269a2d2152f0d60b5c" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_7baae7e677343544285c616803" ON "user_devices" ("customerId", "deviceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e5c6e1da55b6161c3b707555a6" ON "user_devices" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_506464185cb71c76bc36f3e157" ON "user_devices" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "customer_dashboards" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "customerId" uuid NOT NULL, "tenantId" character varying NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "dashboardId" uuid NOT NULL, CONSTRAINT "UQ_1a14967b150accbc8d2cd9ac15a" UNIQUE ("customerId", "dashboardId"), CONSTRAINT "PK_95b003e16b8cd300e3ec56417eb" PRIMARY KEY ("id"), CONSTRAINT "FK_6fa2dee80f4f900512aaab6e22f" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_ff49d9fbf2ec10a288b030173ae" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_05993e4e45d59f0bd7c067ea5ff" FOREIGN KEY ("dashboardId") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_c3ab4ad483ae971d140425c121" ON "customer_dashboards" ("tenantId", "dashboardId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_12adf885586008368f71627c28" ON "customer_dashboards" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_dashboards" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "userId" uuid NOT NULL, "customerId" uuid NOT NULL, "tenantId" uuid NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "dashboardId" uuid NOT NULL, CONSTRAINT "UQ_ecea6b2e0002db0225fd2ac5b8c" UNIQUE ("userId", "dashboardId"), CONSTRAINT "PK_aa857e5856d64673132a128db2f" PRIMARY KEY ("id"), CONSTRAINT "FK_a0d2c57cfa5bb6f10171225bb72" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_c910fc5f52f34038729b9805904" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_19f3bbe710311e156215d56a1b0" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_f24331a37e64eeb17e943aae16b" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_c7024f33946b0792091eec76847" FOREIGN KEY ("dashboardId") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_a3468664e9a74c5cde3994c0fe" ON "user_dashboards" ("customerId", "dashboardId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_68c8a4b490177cf826a3aa9255" ON "user_dashboards" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_253de83875b2096b284dbf5f05" ON "user_dashboards" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "customer_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "customerId" uuid NOT NULL, "tenantId" character varying NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "assetId" uuid NOT NULL, CONSTRAINT "UQ_b292347dc316fff578531c41cfd" UNIQUE ("customerId", "assetId"), CONSTRAINT "PK_0d7f1a5692976420d8af7ef942c" PRIMARY KEY ("id"), CONSTRAINT "FK_b77c7f8c64827d5dd051fe5808f" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_0627c2a4bc9922030d2522724d5" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_aa1a03f1b26ef456abd802e052c" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_56967f648060e2c181bc6c12ec" ON "customer_assets" ("tenantId", "assetId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_23bd3302e3f985ce6aefa00184" ON "customer_assets" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_assets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "userId" uuid NOT NULL, "customerId" uuid NOT NULL, "tenantId" uuid NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "assetId" uuid NOT NULL, CONSTRAINT "UQ_be8e5fb4a252d78dc964e7ec56e" UNIQUE ("userId", "assetId"), CONSTRAINT "PK_fd45510df6becbf15bac0ab0e9e" PRIMARY KEY ("id"), CONSTRAINT "FK_94b20ffef8c0aa2b9ae13eadeda" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_855e9a4f9bdddf0e8dea152f495" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_ade1e59b1f216b4ca7846c117a0" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_2cdd9ffada55c7249838ebee4c7" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_ec28523029f6a000463bd474b47" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f4b8d4a41ae26e131d1c02aebf" ON "user_assets" ("customerId", "assetId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_f5db9e72e86eff5a026369fc10" ON "user_assets" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_b0999db6e04cd65f6ec5906bd7" ON "user_assets" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "customer_floor_plans" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "customerId" uuid NOT NULL, "tenantId" character varying NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "floorPlanId" uuid NOT NULL, CONSTRAINT "UQ_539de703332417c22f1c5da5c36" UNIQUE ("customerId", "floorPlanId"), CONSTRAINT "PK_3e5612953e8a4d64476dfd1357b" PRIMARY KEY ("id"), CONSTRAINT "FK_2f842402e78531860924e6c11d0" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_e50bb4037776c8ae4211cabff02" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_133a277e27bf8950b4fc48fbccc" FOREIGN KEY ("floorPlanId") REFERENCES "floor_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_12618010076828d15d71057961" ON "customer_floor_plans" ("tenantId", "floorPlanId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_bf93bcfe5548a27a120ad87f22" ON "customer_floor_plans" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_floor_plans" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "userId" uuid NOT NULL, "customerId" uuid NOT NULL, "tenantId" uuid NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "floorPlanId" uuid NOT NULL, CONSTRAINT "UQ_6d37c26e177e3f33c4af5cea9f1" UNIQUE ("userId", "floorPlanId"), CONSTRAINT "PK_fbeaec7a64eb627c4c584fefe40" PRIMARY KEY ("id"), CONSTRAINT "FK_4ba04b0f7c61d5f6c5bb3f3a54c" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_74656609882301da3e3a66ccfb9" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_6014eefbe3e85e7591e8f22acff" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_08829d9b42acafe8268b2a1179f" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_30909defbfe829cafb265a4373e" FOREIGN KEY ("floorPlanId") REFERENCES "floor_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ee78d4465b2b940ca57b84acc9" ON "user_floor_plans" ("customerId", "floorPlanId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_d0c9d30f7ff677232dd431669a" ON "user_floor_plans" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_1e4f5df577058e301f60afb706" ON "user_floor_plans" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "customer_automations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "customerId" uuid NOT NULL, "tenantId" character varying NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "automationId" uuid NOT NULL, CONSTRAINT "UQ_68046553465abe35e5048b7f476" UNIQUE ("customerId", "automationId"), CONSTRAINT "PK_722420f9fba35d9b1d3030d895d" PRIMARY KEY ("id"), CONSTRAINT "FK_9f02beca402bfc623a3ced61f72" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_d3589cc9548bb94018f681d2a71" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_b76aa7e1caf303bd029fa278f03" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_e9866f852757ac3d34d35d25cd" ON "customer_automations" ("tenantId", "automationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_3ee967b4e25b58b338401f23bf" ON "customer_automations" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_automations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "created_by" character varying, "updated_by" character varying, "deleted_by" character varying, "userId" uuid NOT NULL, "customerId" uuid NOT NULL, "tenantId" uuid NOT NULL, "assignedAt" TIMESTAMP NOT NULL DEFAULT now(), "assignedBy" uuid, "automationId" uuid NOT NULL, CONSTRAINT "UQ_f3a4f54c03aea9c06fe6acfdb22" UNIQUE ("userId", "automationId"), CONSTRAINT "PK_8418111acaefdbfddc3848f118a" PRIMARY KEY ("id"), CONSTRAINT "FK_dd2f7b943234114317240667b2a" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_999bc26201c25fde5cfd851f217" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "FK_98ac7b5b59a65dd863d91a4c9b1" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_31213eee698a1a9776c56609498" FOREIGN KEY ("assignedBy") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_86a7717eb95edaa499846e4b642" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_898b56b3dec80037c773645b44" ON "user_automations" ("customerId", "automationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baadba7ff577211804228fba18" ON "user_automations" ("tenantId", "userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_40c7095993b65ef3e177bb59c7" ON "user_automations" ("tenantId", "customerId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only drops what up() created; these tables did not exist beforehand.
    await queryRunner.query(`DROP TABLE IF EXISTS "user_automations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_automations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_floor_plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_floor_plans"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_assets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_assets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_dashboards"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_dashboards"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_devices"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_devices"`);
  }
}
