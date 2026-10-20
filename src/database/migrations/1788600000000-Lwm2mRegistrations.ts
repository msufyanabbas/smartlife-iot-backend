import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `lwm2m_registrations` — LwM2M registrations that survive a restart.
 *
 * `Lwm2mService` kept its whole registry in two in-process `Map`s. A client
 * with a long lifetime therefore would not re-register for hours after a
 * deploy, and in the meantime its Update was answered 4.04 and its Send 4.03;
 * nothing was shared between replicas; and `GET /lwm2m/registrations` reported
 * one node's memory as though it were the platform's state.
 *
 * `tenantId`, `customerId` and `deviceId` are `uuid` with real FKs because the
 * entity declares `@ManyToOne` against all three — a join column takes the
 * referenced key's type and gets a constraint whether a hand-written migration
 * says so or not (see the note in 1788000000000-AiModels).
 *
 * ─── Why there are two endpoint columns ───────────────────────────────────
 * The LwM2M endpoint name is also the credential this server authenticates
 * with (there is no DTLS/PSK in this stack), so storing it verbatim would put
 * an access token in a column that `GET /lwm2m/registrations` returns.
 *
 * `endpointHash` is SHA-256 of the name as presented and carries the unique
 * index — it is the identity a re-registration replaces and a `?ep=` on /dp
 * resolves through. `endpoint` holds the authenticated device's KEY, which is
 * a public identifier and is what the UI shows.
 */
export class Lwm2mRegistrations1788600000000 implements MigrationInterface {
  name = 'Lwm2mRegistrations1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lwm2m_registrations" (
        "id"              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"      TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at"      TIMESTAMP,
        "created_by"      character varying,
        "updated_by"      character varying,
        "deleted_by"      character varying,
        "tenantId"        uuid NOT NULL,
        "customerId"      uuid,
        "deviceId"        uuid NOT NULL,
        "registrationId"  character varying(32) NOT NULL,
        "endpoint"        character varying(255) NOT NULL,
        "endpointHash"    character(64) NOT NULL,
        "lifetime"        integer NOT NULL,
        "bindingMode"     character varying(8) NOT NULL DEFAULT 'U',
        "lwm2mVersion"    character varying(16),
        "objects"         jsonb NOT NULL DEFAULT '[]'::jsonb,
        "address"         character varying(64),
        "port"            integer,
        "registeredAt"    TIMESTAMP NOT NULL,
        "lastUpdateAt"    TIMESTAMP NOT NULL,
        "expiresAt"       TIMESTAMP NOT NULL,
        "authenticated"   boolean NOT NULL DEFAULT true,
        "credentialsType" character varying(32),
        CONSTRAINT "UQ_lwm2m_registrations_registration_id"
          UNIQUE ("registrationId"),
        CONSTRAINT "FK_lwm2m_registrations_tenant"
          FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lwm2m_registrations_customer"
          FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_lwm2m_registrations_device"
          FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE
      )
    `);

    // Partial unique: one live registration per endpoint identity, while a
    // soft-deleted (de-registered or expired) row does not block a client
    // registering again with the same credential.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lwm2m_registrations_endpoint_hash"
        ON "lwm2m_registrations" ("endpointHash") WHERE "deleted_at" IS NULL
    `);
    // The expiry sweep's query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lwm2m_registrations_expires_at"
        ON "lwm2m_registrations" ("expiresAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lwm2m_registrations_tenant_expires"
        ON "lwm2m_registrations" ("tenantId", "expiresAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lwm2m_registrations_tenant_device"
        ON "lwm2m_registrations" ("tenantId", "deviceId")
    `);
    // Identifying a /dp Send that carries no ?ep= by its source address.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_lwm2m_registrations_address_port"
        ON "lwm2m_registrations" ("address", "port")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lwm2m_registrations_address_port"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lwm2m_registrations_tenant_device"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lwm2m_registrations_tenant_expires"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_lwm2m_registrations_expires_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_lwm2m_registrations_endpoint_hash"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "lwm2m_registrations"`);
  }
}
