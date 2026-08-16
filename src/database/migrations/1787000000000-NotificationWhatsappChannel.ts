import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'whatsapp' to the notifications channel enum.
 *
 * `NotificationChannel` is persisted as the PG enum `notifications_channel_enum`
 * (`@Column({ type: 'enum', enum: NotificationChannel })` on Notification.channel),
 * so the TypeScript member alone is not enough — inserting a notification with
 * channel='whatsapp' against an unmigrated database fails with
 * `invalid input value for enum notifications_channel_enum: "whatsapp"`.
 *
 * `ADD VALUE IF NOT EXISTS` is safe inside a transaction on PostgreSQL 12+
 * provided the new value is not *used* in the same transaction — it is not.
 *
 * Written by hand rather than generated: `migration:generate` currently emits a
 * large amount of unrelated pre-existing drift (8 assignment junction tables, a
 * destructive narrowing of solution_templates_category_enum, firmware index
 * rebuilds), none of which belongs in this change.
 *
 * down() is intentionally a no-op: PostgreSQL has no `ALTER TYPE ... DROP VALUE`.
 * Removing the member would mean recreating the type and rewriting every
 * dependent column, which is far more destructive than leaving an unused label.
 */
export class NotificationWhatsappChannel1787000000000
  implements MigrationInterface
{
  name = 'NotificationWhatsappChannel1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "notifications_channel_enum" ADD VALUE IF NOT EXISTS 'whatsapp'
    `);
  }

  public async down(): Promise<void> {
    // No-op — see the class doc block.
  }
}
