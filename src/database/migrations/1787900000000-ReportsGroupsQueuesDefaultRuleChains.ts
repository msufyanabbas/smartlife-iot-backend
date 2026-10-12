import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Six tables behind four frontend surfaces that had no backend at all:
 *
 *   report_templates / report_executions   `/reports`                (ReportTemplatesPage)
 *   entity_groups / entity_group_members   `/groups`                 (CreateGroupPage)
 *   queues                                 `/queues`                 (queues.api.ts, 404)
 *   default_rule_chains                    `/default-rule-chains`    (default-rule-chains.api.ts, 404)
 *
 * One migration rather than four because they ship together and
 * `migration:run` is blocked (CLAUDE.md §11), so each one would otherwise need
 * its own standalone runner and its own npm script. Apply it with
 * `npm run migration:reports-groups-queues <database> [up|down]`.
 *
 * ── Column types follow the join-column rule ──────────────────────────────
 * A column that is also a `@ManyToOne` join column takes the referenced key's
 * type and gets a real foreign key whatever a hand-written migration says
 * (CLAUDE.md §4f). So every `tenantId` that has a relation on its entity is
 * `uuid` with an FK to `tenants(id)` here; `entity_group_members.tenantId`,
 * which is denormalised and deliberately has NO relation, is `uuid` with no
 * FK — matching the entity, which is what keeps this migration from drifting
 * from the schema `synchronize` builds.
 *
 * `userId` / `addedBy` / `runAsUserId` are `character varying` with no FK
 * throughout, on purpose: a report template, a group, a queue and a routing
 * rule are all tenant assets that must outlive whoever created them, and an FK
 * would make removing that user either fail or take their colleagues' rows
 * with it. Same call `rule_chain_templates.userId` makes.
 *
 * ── One index here is NOT expressible on the entity ───────────────────────
 * `UQ_default_rule_chains_key` is a unique index over COALESCE expressions,
 * because the logical key (tenantId, originatorType, messageType,
 * deviceProfileId) has two nullable members and PostgreSQL treats NULLs as
 * distinct — a plain UNIQUE would allow two "any message type" rules for the
 * same originator. TypeORM's `@Index` cannot express an expression index, so
 * this one exists only when the migration has been applied;
 * `DefaultRuleChainsService.assertNoClash()` enforces the same rule in the
 * application so the behaviour does not depend on it, and gives a readable 409
 * rather than a driver error.
 *
 * ── Soft deletes and the unique indexes ──────────────────────────────────
 * `UQ_queues_tenant_name` and `UQ_entity_groups_tenant_type_name` do not
 * include `deleted_at`, so a soft-deleted row keeps its name reserved — the
 * same trade-off `floor_plans` makes for `(assetId, floorNumber)`
 * (CLAUDE.md §4a). Re-creating a deleted group or queue under the same name
 * needs the old row hard-deleted first. `UQ_default_rule_chains_key` DOES
 * exclude soft-deleted rows, because a routing rule is far more likely to be
 * deleted and immediately recreated while an operator is getting it right.
 *
 * down() drops all six tables. `report_executions` rows reference files on the
 * uploads volume under `reports/<tenantId>/`; dropping the table does not
 * remove those files.
 */
export class ReportsGroupsQueuesDefaultRuleChains1787900000000
  implements MigrationInterface
{
  name = 'ReportsGroupsQueuesDefaultRuleChains1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ══════════════════════════════════════════════════════════════════════
    // queues
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "queues" (
        "id"                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"             TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"             TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"             TIMESTAMP,
        "created_by"             character varying,
        "updated_by"             character varying,
        "deleted_by"             character varying,
        "tenantId"               uuid NOT NULL,
        "userId"                 character varying,
        "name"                   character varying NOT NULL,
        "description"            text,
        "topic"                  character varying,
        "partitions"             integer NOT NULL DEFAULT 10,
        "consumerPerPartition"   boolean NOT NULL DEFAULT false,
        "pollInterval"           integer NOT NULL DEFAULT 25,
        "maxPollRecords"         integer NOT NULL DEFAULT 1000,
        "maxPollInterval"        integer NOT NULL DEFAULT 300000,
        "maxRequestSize"         integer NOT NULL DEFAULT 1048576,
        "maxPendingMessages"     integer NOT NULL DEFAULT 10000,
        "submitStrategy"         character varying NOT NULL DEFAULT 'BURST',
        "processingStrategy"     character varying NOT NULL DEFAULT 'SKIP_ALL_FAILURES',
        "packProcessingTimeout"  integer NOT NULL DEFAULT 2000,
        "retries"                integer NOT NULL DEFAULT 0,
        "retryFailedBackoff"     integer NOT NULL DEFAULT 100,
        "retryTimedOutBackoff"   integer NOT NULL DEFAULT 100,
        "enabled"                boolean NOT NULL DEFAULT true,
        "isDefault"              boolean NOT NULL DEFAULT false,
        "additionalInfo"         jsonb,
        "processedCount"         bigint NOT NULL DEFAULT '0'::bigint,
        "failedCount"            bigint NOT NULL DEFAULT '0'::bigint,
        "timedOutCount"          bigint NOT NULL DEFAULT '0'::bigint,
        "lastUsedAt"             TIMESTAMP,
        CONSTRAINT "FK_queues_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_queues_tenant_name"
        ON "queues" ("tenantId", "name")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_queues_tenant_enabled"
        ON "queues" ("tenantId", "enabled")
    `);

    // ══════════════════════════════════════════════════════════════════════
    // entity_groups
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "entity_groups" (
        "id"             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"     TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"     TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"     TIMESTAMP,
        "created_by"     character varying,
        "updated_by"     character varying,
        "deleted_by"     character varying,
        "tenantId"       uuid NOT NULL,
        "customerId"     uuid,
        "userId"         character varying,
        "name"           character varying NOT NULL,
        "description"    text,
        "entityType"     character varying NOT NULL,
        "icon"           character varying,
        "color"          character varying,
        "memberCount"    integer NOT NULL DEFAULT 0,
        "additionalInfo" jsonb,
        CONSTRAINT "FK_entity_groups_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
        CONSTRAINT "FK_entity_groups_customer"
          FOREIGN KEY ("customerId") REFERENCES "customers"("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_entity_groups_tenant_type"
        ON "entity_groups" ("tenantId", "entityType")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_entity_groups_tenant_type_name"
        ON "entity_groups" ("tenantId", "entityType", "name")
    `);

    // ══════════════════════════════════════════════════════════════════════
    // entity_group_members
    //
    // `tenantId` and `entityType` are denormalised from the group so that
    // "which groups is this entity in?" is one index seek on
    // (tenantId, entityType, entityId) instead of a join back to
    // entity_groups for the tenant predicate. `entityId` carries no FK: an FK
    // cannot be polymorphic, and the check that matters —
    // "does this id belong to the caller's tenant?" — is one an FK would not
    // have made. GroupsService.verifyMembers() makes it before any insert.
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "entity_group_members" (
        "id"          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"  TIMESTAMP,
        "created_by"  character varying,
        "updated_by"  character varying,
        "deleted_by"  character varying,
        "tenantId"    uuid NOT NULL,
        "groupId"     uuid NOT NULL,
        "entityId"    uuid NOT NULL,
        "entityType"  character varying NOT NULL,
        "addedBy"     character varying,
        CONSTRAINT "FK_entity_group_members_group"
          FOREIGN KEY ("groupId") REFERENCES "entity_groups"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_entity_group_members_group_entity"
        ON "entity_group_members" ("groupId", "entityId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_entity_group_members_reverse"
        ON "entity_group_members" ("tenantId", "entityType", "entityId")
    `);

    // ══════════════════════════════════════════════════════════════════════
    // report_templates
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "report_templates" (
        "id"               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMP,
        "created_by"       character varying,
        "updated_by"       character varying,
        "deleted_by"       character varying,
        "tenantId"         uuid NOT NULL,
        "userId"           character varying,
        "name"             character varying NOT NULL,
        "description"      text,
        "type"             character varying NOT NULL DEFAULT 'General',
        "definition"       jsonb NOT NULL,
        "format"           character varying NOT NULL DEFAULT 'CSV',
        "schedule"         jsonb,
        "nextRunAt"        TIMESTAMP,
        "enabled"          boolean NOT NULL DEFAULT true,
        "lastGeneratedAt"  TIMESTAMP,
        "generationCount"  integer NOT NULL DEFAULT 0,
        "lastError"        text,
        "additionalInfo"   jsonb,
        CONSTRAINT "FK_report_templates_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_templates_tenant_type"
        ON "report_templates" ("tenantId", "type")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_templates_tenant_enabled"
        ON "report_templates" ("tenantId", "enabled")
    `);
    // The scheduler's only query: "which templates are due?".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_templates_due"
        ON "report_templates" ("enabled", "nextRunAt")
    `);

    // ══════════════════════════════════════════════════════════════════════
    // report_executions
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "report_executions" (
        "id"                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"        TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"        TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"        TIMESTAMP,
        "created_by"        character varying,
        "updated_by"        character varying,
        "deleted_by"        character varying,
        "tenantId"          uuid NOT NULL,
        "reportTemplateId"  uuid NOT NULL,
        "reportName"        character varying NOT NULL,
        "trigger"           character varying NOT NULL,
        "format"            character varying NOT NULL,
        "status"            character varying NOT NULL,
        "runAsUserId"       character varying,
        "rowCount"          integer NOT NULL DEFAULT 0,
        "byteSize"          integer NOT NULL DEFAULT 0,
        "durationMs"        integer NOT NULL DEFAULT 0,
        "fileName"          character varying,
        "filePath"          character varying,
        "error"             text,
        "delivery"          jsonb,
        "period"            jsonb,
        CONSTRAINT "FK_report_executions_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
        CONSTRAINT "FK_report_executions_template"
          FOREIGN KEY ("reportTemplateId") REFERENCES "report_templates"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_executions_tenant_created"
        ON "report_executions" ("tenantId", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_executions_template_created"
        ON "report_executions" ("reportTemplateId", "created_at")
    `);

    // ══════════════════════════════════════════════════════════════════════
    // default_rule_chains
    // ══════════════════════════════════════════════════════════════════════
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "default_rule_chains" (
        "id"               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"       TIMESTAMP,
        "created_by"       character varying,
        "updated_by"       character varying,
        "deleted_by"       character varying,
        "tenantId"         uuid NOT NULL,
        "userId"           character varying,
        "name"             character varying NOT NULL,
        "description"      text,
        "originatorType"   character varying NOT NULL DEFAULT '*',
        "messageType"      character varying,
        "deviceProfileId"  uuid,
        "ruleChainId"      uuid NOT NULL,
        "priority"         integer NOT NULL DEFAULT 0,
        "enabled"          boolean NOT NULL DEFAULT true,
        "additionalInfo"   jsonb,
        "matchCount"       bigint NOT NULL DEFAULT '0'::bigint,
        "lastMatchedAt"    TIMESTAMP,
        CONSTRAINT "FK_default_rule_chains_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
        CONSTRAINT "FK_default_rule_chains_rule_chain"
          FOREIGN KEY ("ruleChainId") REFERENCES "rule_chains"("id"),
        CONSTRAINT "FK_default_rule_chains_device_profile"
          FOREIGN KEY ("deviceProfileId") REFERENCES "device_profiles"("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_default_rule_chains_tenant_enabled"
        ON "default_rule_chains" ("tenantId", "enabled")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_default_rule_chains_match"
        ON "default_rule_chains" ("tenantId", "originatorType", "messageType")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_default_rule_chains_profile"
        ON "default_rule_chains" ("tenantId", "deviceProfileId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_default_rule_chains_chain"
        ON "default_rule_chains" ("ruleChainId")
    `);
    // See the class comment: an expression index TypeORM cannot declare, so
    // that two "any message type" rules for one originator cannot both exist.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_default_rule_chains_key"
        ON "default_rule_chains" (
          "tenantId",
          "originatorType",
          COALESCE("messageType", '*'),
          COALESCE("deviceProfileId", '00000000-0000-0000-0000-000000000000'::uuid)
        )
        WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Children before parents: report_executions references report_templates
    // and entity_group_members references entity_groups.
    await queryRunner.query(`DROP TABLE IF EXISTS "default_rule_chains"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "report_executions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "report_templates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_group_members"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "entity_groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "queues"`);
  }
}
