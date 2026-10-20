import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.enforcePermissions`.
 *
 * `PermissionGuard` used to return true unconditionally for TENANT_ADMIN, so
 * any permission assigned to a tenant administrator was ignored without a
 * trace. This column is the opt-in that makes such a grant take effect.
 *
 * It defaults to FALSE deliberately. Defaulting to true would, on the first
 * deploy, restrict every existing tenant administrator to whatever
 * permissions happened to be attached to their account — which for most of
 * them is none, i.e. an instant lockout of every tenant's admin.
 */
export class UserEnforcePermissions1788200000000 implements MigrationInterface {
  name = 'UserEnforcePermissions1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "enforcePermissions" boolean NOT NULL DEFAULT false
    `);

    // Partial index: the flag is false for almost every row, so an index on
    // the whole column would be dead weight. Only the restricted accounts
    // are worth finding quickly — "which admins are restricted?" is the
    // question an operator actually asks.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_enforce_permissions"
      ON "users" ("tenantId")
      WHERE "enforcePermissions" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_users_enforce_permissions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "enforcePermissions"`,
    );
  }
}
