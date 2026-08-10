import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two Alarm columns the create/update payload needs and that had no
 * home on the entity:
 *
 *   assetId  — an alarm can be raised on an asset rather than a device
 *   details  — free-text operator notes, distinct from the generated `message`
 *
 * The rest of the payload already maps onto existing columns: the flat
 * `email`/`sms`/`push`/`webhook` fields fold into the `notifications` jsonb and
 * `userIds`/`emails`/`phones` into `recipients`, so nothing else changes here.
 *
 * NOTE: `migration:generate` also emitted ~100 statements of pre-existing
 * entity/DB drift unrelated to this change — the 8 assignment junction tables,
 * a *destructive* narrowing of solution_templates_category_enum (it drops six
 * in-use values), a firmware/schedules/attributes index rebuild and several
 * jsonb default rewrites. That drift is documented in CLAUDE.md §11 and needs
 * its own reviewed migration; it has been stripped from this one.
 */
export class AlarmDtoFix1786345215905 implements MigrationInterface {
  name = 'AlarmDtoFix1786345215905';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "alarms" ADD "assetId" uuid`);
    await queryRunner.query(`ALTER TABLE "alarms" ADD "details" text`);
    await queryRunner.query(
      `ALTER TABLE "alarms" ADD CONSTRAINT "FK_d0bcd97f9016fde8132270114f6" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alarms" DROP CONSTRAINT "FK_d0bcd97f9016fde8132270114f6"`,
    );
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "details"`);
    await queryRunner.query(`ALTER TABLE "alarms" DROP COLUMN "assetId"`);
  }
}
