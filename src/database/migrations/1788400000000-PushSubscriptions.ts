import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `push_subscriptions` — where a push notification can be delivered.
 *
 * PushChannel had no device registry at all: `Notification.recipientDeviceToken`
 * had to come from whoever created the row, and nothing in the platform ever
 * collected a token. So even once the FCM calls were real there was nothing to
 * send to.
 *
 * `tenantId`, `customerId` and `userId` are `uuid` with real FKs because the
 * entity declares `@ManyToOne` against all three — a join column takes the
 * referenced key's type and gets a constraint whether a hand-written migration
 * says so or not (see the note in 1788000000000-AiModels).
 *
 * `platform` is varchar, not a PG enum, for the reason the integrations table
 * learned the hard way: a new TypeScript member passes `@IsIn` and then the
 * INSERT fails with `invalid input value for enum`.
 *
 * The unique index is on `token` ALONE, not `(tenantId, token)`. A token
 * identifies one browser subscription or one app install globally, and the same
 * device can be signed into a different tenant tomorrow; scoping the index by
 * tenant would let two rows claim the same device and deliver one user's
 * notifications to another. It is partial on `deleted_at IS NULL` so a
 * soft-deleted row does not hold the token hostage after a sign-out.
 */
export class PushSubscriptions1788400000000 implements MigrationInterface {
  name = 'PushSubscriptions1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "push_subscriptions" (
        "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"    TIMESTAMP,
        "created_by"    character varying,
        "updated_by"    character varying,
        "deleted_by"    character varying,
        "tenantId"      uuid NOT NULL,
        "customerId"    uuid,
        "userId"        uuid NOT NULL,
        "token"         text NOT NULL,
        "platform"      character varying(16) NOT NULL DEFAULT 'unknown',
        "keys"          jsonb,
        "deviceInfo"    jsonb,
        "enabled"       boolean NOT NULL DEFAULT true,
        "lastError"     text,
        "lastErrorAt"   TIMESTAMP,
        "lastSeenAt"    TIMESTAMP,
        CONSTRAINT "FK_push_subscriptions_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_push_subscriptions_customer"
          FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_push_subscriptions_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_subscriptions_token"
        ON "push_subscriptions" ("token") WHERE "deleted_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_push_subscriptions_tenant_user"
        ON "push_subscriptions" ("tenantId", "userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_push_subscriptions_tenant_platform"
        ON "push_subscriptions" ("tenantId", "platform")
    `);
    // The fan-out read: deliverable tokens for a set of users.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_push_subscriptions_user_enabled"
        ON "push_subscriptions" ("userId", "enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_push_subscriptions_user_enabled"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_push_subscriptions_tenant_platform"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_push_subscriptions_tenant_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_push_subscriptions_token"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "push_subscriptions"`);
  }
}
