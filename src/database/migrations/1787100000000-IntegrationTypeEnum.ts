import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * New IntegrationType members, plus the TTN device protocol.
 *
 * `integrations.type` and `devices.protocol` are Postgres ENUM columns, so a
 * new TypeScript member alone is not enough — the DTO's @IsEnum would accept
 * the value and the INSERT would then fail with
 * `invalid input value for enum integrations_type_enum: "azure_iot"`.
 *
 * - azure_iot / google_cloud: outbound cloud targets. Configurable and
 *   storable, but neither has an adapter in IntegrationDispatchService yet, so
 *   telemetry is not forwarded to them.
 * - chirpstack / ttn: inbound LoRaWAN network servers. These rows exist to map
 *   an uplink webhook to a tenant (LorawanService), not to dispatch to.
 * - devices.protocol 'lorawan_ttn': so devices auto-provisioned from a TTN
 *   uplink are not mislabelled as ChirpStack.
 *
 * `ADD VALUE IF NOT EXISTS` is safe inside a transaction on PostgreSQL 12+
 * provided the new value is not *used* in the same transaction — it is not.
 *
 * Written by hand rather than generated: `migration:generate` does not emit
 * `ALTER TYPE ... ADD VALUE` for enum additions (it tries to recreate the type
 * and rewrite every dependent column), and it currently also emits a large
 * amount of unrelated pre-existing drift.
 *
 * down() is intentionally a no-op: PostgreSQL has no `ALTER TYPE ... DROP
 * VALUE`. Removing a label means recreating the type and rewriting every
 * dependent column, which is far more destructive than an unused label.
 */
export class IntegrationTypeEnum1787100000000 implements MigrationInterface {
  name = 'IntegrationTypeEnum1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ['azure_iot', 'google_cloud', 'chirpstack', 'ttn']) {
      await queryRunner.query(
        `ALTER TYPE "integrations_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "devices_protocol_enum" ADD VALUE IF NOT EXISTS 'lorawan_ttn'`,
    );
  }

  public async down(): Promise<void> {
    // No-op — see the class doc block.
  }
}
