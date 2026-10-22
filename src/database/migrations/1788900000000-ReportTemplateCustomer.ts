import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `report_templates.customerId` — the customer dimension the reports module
 * never had.
 *
 * ─── What was wrong ───────────────────────────────────────────────────────
 * Every read in `ReportsService` was tenant-only: `findAll`, `findOne`,
 * `findExecutions` and `getStatistics` all narrowed on `tenantId` and nothing
 * else. `GET /reports` is open to CUSTOMER (`@TenantOrCustomerAdmin()`), so a
 * customer admin listed every template of its tenant — sibling customers'
 * included, and a template's `definition.filters` carries the device and asset
 * ids it was written for.
 *
 * ─── Why nullable, and why that is not a hole ─────────────────────────────
 * A report template is tenant-owned. NULL is a real value with a meaning of
 * its own: a tenant-wide template that every customer of the tenant may run.
 * So the read rule is "my customer's, or nobody's" — expressed as
 * `applyAccessScope(..., { includeUnassigned: true })`, the one call site in
 * the codebase that asks for it. Existing rows become tenant-wide templates,
 * which is exactly what they were when they were written.
 *
 * ─── No foreign key ───────────────────────────────────────────────────────
 * Deliberate, and the same call `report_templates.userId` already makes: a
 * hard-deleted customer must not take the tenant's templates with it, nor make
 * the delete fail. The read is a plain predicate either way, and an orphaned
 * customerId simply stops matching anybody — it does not widen to tenant-wide,
 * because the predicate asks for `= :id OR IS NULL`.
 *
 * `report_executions` gets NO column. An execution is scoped through the
 * template it was generated from (`ReportsService.scopedExecutions()` joins
 * it); a copied customerId would be a second source of truth that disagrees
 * with the template after a reassignment.
 *
 * ─── Running it ───────────────────────────────────────────────────────────
 * `migration:run` is blocked by two never-applied drift migrations that sort
 * ahead of everything later and abort the transaction (CLAUDE.md §11), so this
 * one ships with a standalone runner:
 *
 *   npm run migration:report-template-customer <database> [up|down]
 */
export class ReportTemplateCustomer1788900000000 implements MigrationInterface {
  name = 'ReportTemplateCustomer1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS: this is applied by hand on several databases and must be
    // safe to re-run.
    await queryRunner.query(`
      ALTER TABLE "report_templates"
        ADD COLUMN IF NOT EXISTS "customerId" uuid
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "report_templates"."customerId" IS
        'Owning customer, or NULL for a tenant-wide template every customer of the tenant may run. Read with applyAccessScope(..., { includeUnassigned: true }).'
    `);

    // Every scoped read is (tenantId, customerId): the list, the detail, the
    // statistics and the execution join all narrow on both.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_report_templates_tenant_customer"
        ON "report_templates" ("tenantId", "customerId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_report_templates_tenant_customer"
    `);
    await queryRunner.query(`
      ALTER TABLE "report_templates" DROP COLUMN IF EXISTS "customerId"
    `);
  }
}
