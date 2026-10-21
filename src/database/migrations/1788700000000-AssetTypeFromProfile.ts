import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes `AssetProfile.type` the single source of an asset's type, and
 * reconciles the rows that two sources had been disagreeing about.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `assets.type` and `asset_profiles.type` both answered "what kind of thing is
 * this?", with different closed vocabularies and no rule for which won:
 *
 *   assets_type_enum       building floor room office vehicle equipment
 *                          infrastructure zone other
 *   AssetProfileType       building vehicle shop farm warehouse hospital
 *                          hotel factory custom
 *
 * `building` and `vehicle` are the only two values in both. So a warehouse
 * asset was `infrastructure` or `other` in one column and `warehouse` in the
 * other, and the 3D viewer — the one consumer that genuinely needs the answer
 * — read the profile when there was one and keyword-matched the free text when
 * there wasn't. Same asset, two types, scene depending on which read ran.
 *
 * ── What this migration does, and does not, do ──────────────────────────────
 *
 * It does **not** drop `assets.type`. The column keeps every value it holds,
 * because those values are the only surviving record of how an operator
 * originally classified each asset — including the ones this migration cannot
 * classify automatically and leaves for a human. See the entity docblock for
 * the other two reasons (an out-of-scope consumer in `AnalyticsService`, and
 * the fact that the vocabularies cannot be mapped onto each other anyway).
 * The column is marked deprecated with a `COMMENT ON COLUMN`, which is the
 * one place a DBA looking at the schema will actually see it.
 *
 * What it changes is the other side: it makes sure as many assets as possible
 * HAVE a profile, so that the single source of truth has something to say.
 *
 * ── The backfill rule, in precedence order ──────────────────────────────────
 *
 * For every live (not soft-deleted) asset:
 *
 *   1. `profiled_typed_agree` — has a profile with a type, and the legacy
 *      column happens to say the same thing. **Untouched.**
 *   2. `profiled_typed_disagree` — has a profile with a type, and the legacy
 *      column says something else. **Untouched.** This is not an error to
 *      repair; it is precisely the duplication being removed, and the profile
 *      is the answer. Counted and reported because its size is the honest
 *      measure of how much the two columns had drifted.
 *   3. `profiled_untyped` — has a profile, but that profile's own `type` is
 *      NULL. **Untouched and reported.** The fix belongs on the profile, and a
 *      profile is shared by every asset using it, so setting it here would
 *      silently retype assets this migration was never asked about.
 *   4. `profile_missing` — `assetProfileId` points at a soft-deleted or absent
 *      profile. **Untouched and reported.** Re-pointing a dangling reference
 *      is a guess about intent.
 *   5. `matched_by_legacy_type` — no profile, and the legacy value maps
 *      unambiguously onto an `AssetProfileType` for which the tenant has
 *      **exactly one** live profile. **Assigned.** The map is deliberately
 *      only `building → building` and `vehicle → vehicle`: those are the two
 *      values that exist in both vocabularies and mean the same thing.
 *      `floor`, `room`, `office` and `zone` are PARTS of a building, not kinds
 *      of building — mapping them to a Building profile would hand a single
 *      room a `totalFloors` field and a `floorsData` array, i.e. turn it into
 *      a multi-floor building. `equipment`, `infrastructure` and `other` name
 *      no profile type at all.
 *   6. `ambiguous_legacy_match` — as 5, but the tenant has two or more live
 *      profiles of that type. **Left unassigned and reported.** Which Building
 *      profile is unknowable from here, and the two can declare different
 *      required fields.
 *   7. `assigned_default_profile` — no profile and no unambiguous match, and
 *      the tenant has exactly one `default = true` profile (failing that,
 *      exactly one `custom` profile). **Assigned.** `custom` ships with an
 *      empty schema, so this adds no required fields and cannot invalidate the
 *      asset's existing `configuration`. Its type is `custom`, which carries
 *      no shape information — which is the truthful answer for an asset nobody
 *      ever classified.
 *   8. `unresolvable_no_default` — no profile, no match, and the tenant has
 *      neither a single default nor a single custom profile. **Left
 *      unassigned and reported.** Seeding the tenant's profiles is the fix.
 *
 * Branches 5 and 7 are the only writes. Run the report first:
 *
 *   npm run migration:asset-type-inheritance <database> plan
 *
 * ── Reversibility ───────────────────────────────────────────────────────────
 *
 * No column is dropped, so no value can be lost. The profile assignments are
 * undone by recording each one in `assets.additionalInfo._assetTypeBackfill`
 * (the previous `assetProfileId`, which is always NULL by construction, the
 * legacy type that drove the decision, the branch, and the profile assigned).
 * `down()` restores `assetProfileId` from that record and deletes the key, so
 * it reverts exactly the rows this migration wrote and nothing else — an asset
 * a human profiled afterwards is left alone because it has no such key.
 *
 * Re-running `up()` is a no-op: branches 5 and 7 both require
 * `assetProfileId IS NULL`, and after the first run those rows have one.
 */
export class AssetTypeFromProfile1788700000000 implements MigrationInterface {
  name = 'AssetTypeFromProfile1788700000000';

  /**
   * Legacy enum value → `AssetProfileType`, for the values where the two
   * vocabularies genuinely agree. Anything absent falls through to the
   * tenant's default profile (branch 7) rather than being guessed at.
   */
  private static readonly LEGACY_TYPE_MAP: Record<string, string> = {
    building: 'building',
    vehicle: 'vehicle',
  };

  /**
   * Classifies every live asset into exactly one branch.
   *
   * Written once and used by the report, the backfill and the verification
   * script, so the three cannot disagree about what a branch means.
   */
  private static classificationSql(): string {
    const mapEntries = Object.entries(
      AssetTypeFromProfile1788700000000.LEGACY_TYPE_MAP,
    )
      .map(([from, to]) => `('${from}','${to}')`)
      .join(',');

    return `
      WITH legacy_map(legacy_type, profile_type) AS (VALUES ${mapEntries}),

      -- Live profiles per (tenant, type), with a count so "exactly one" can be
      -- required rather than assumed.
      by_type AS (
        SELECT "tenantId", type,
               MIN(id::text) AS profile_id,
               COUNT(*)      AS n
        FROM asset_profiles
        WHERE deleted_at IS NULL AND type IS NOT NULL
        GROUP BY "tenantId", type
      ),

      -- The tenant's fallback profile. A tenant with two rows flagged
      -- default is a data defect, and picking one of them would be a guess,
      -- so n is carried and checked.
      fallback AS (
        SELECT "tenantId",
               MIN(id::text) FILTER (WHERE "default")        AS default_id,
               COUNT(*)      FILTER (WHERE "default")        AS default_n,
               MIN(id::text) FILTER (WHERE type = 'custom')  AS custom_id,
               COUNT(*)      FILTER (WHERE type = 'custom')  AS custom_n
        FROM asset_profiles
        WHERE deleted_at IS NULL
        GROUP BY "tenantId"
      ),

      classified AS (
        SELECT
          a.id,
          a."tenantId",
          a.type::text        AS legacy_type,
          a."assetProfileId"  AS current_profile_id,
          p.type              AS profile_type,
          m.profile_type      AS mapped_type,
          bt.profile_id       AS matched_profile_id,
          bt.n                AS matched_n,
          CASE
            WHEN f.default_n = 1 THEN f.default_id
            WHEN f.custom_n  = 1 THEN f.custom_id
            ELSE NULL
          END                 AS fallback_profile_id,
          CASE
            WHEN a."assetProfileId" IS NOT NULL AND p.id IS NULL
              THEN 'profile_missing'
            WHEN a."assetProfileId" IS NOT NULL AND p.type IS NULL
              THEN 'profiled_untyped'
            WHEN a."assetProfileId" IS NOT NULL AND p.type = a.type::text
              THEN 'profiled_typed_agree'
            WHEN a."assetProfileId" IS NOT NULL
              THEN 'profiled_typed_disagree'
            WHEN m.profile_type IS NOT NULL AND bt.n = 1
              THEN 'matched_by_legacy_type'
            WHEN m.profile_type IS NOT NULL AND bt.n > 1
              THEN 'ambiguous_legacy_match'
            WHEN (f.default_n = 1 OR f.custom_n = 1)
              THEN 'assigned_default_profile'
            ELSE 'unresolvable_no_default'
          END                 AS branch
        FROM assets a
        LEFT JOIN asset_profiles p
               ON p.id = a."assetProfileId" AND p.deleted_at IS NULL
        LEFT JOIN legacy_map m
               ON m.legacy_type = a.type::text
        LEFT JOIN by_type bt
               ON bt."tenantId" = a."tenantId" AND bt.type = m.profile_type
        LEFT JOIN fallback f
               ON f."tenantId" = a."tenantId"
        WHERE a.deleted_at IS NULL
      )
    `;
  }

  /**
   * Row counts per branch, without writing anything.
   *
   * Every branch appears even at zero, so a report is readable without
   * knowing which branches exist.
   */
  public async plan(
    queryRunner: QueryRunner,
  ): Promise<Record<string, number>> {
    const rows: Array<{ branch: string; n: string }> = await queryRunner.query(`
      ${AssetTypeFromProfile1788700000000.classificationSql()}
      SELECT branch, COUNT(*)::text AS n FROM classified GROUP BY branch
    `);

    const counts: Record<string, number> = {
      profiled_typed_agree: 0,
      profiled_typed_disagree: 0,
      profiled_untyped: 0,
      profile_missing: 0,
      matched_by_legacy_type: 0,
      ambiguous_legacy_match: 0,
      assigned_default_profile: 0,
      unresolvable_no_default: 0,
    };
    for (const row of rows) counts[row.branch] = Number(row.n);
    return counts;
  }

  /** The assets this migration refuses to classify, with the reason. */
  public async unresolved(
    queryRunner: QueryRunner,
  ): Promise<Array<{ id: string; tenantId: string; legacy_type: string; branch: string }>> {
    return await queryRunner.query(`
      ${AssetTypeFromProfile1788700000000.classificationSql()}
      SELECT id, "tenantId", legacy_type, branch
      FROM classified
      WHERE branch IN (
        'profiled_untyped', 'profile_missing',
        'ambiguous_legacy_match', 'unresolvable_no_default'
      )
      ORDER BY branch, "tenantId", id
    `);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The schema marker first: it is the part a DBA reading the database
    // rather than this file will see.
    await queryRunner.query(`
      COMMENT ON COLUMN "assets"."type" IS
        'DEPRECATED since AssetTypeFromProfile1788700000000. An asset''s type '
        'is its AssetProfile''s type (asset_profiles.type). Retained because '
        'live rows carry the original operator classification and the two '
        'vocabularies do not map; writes are ignored. Do not read this.'
    `);

    // Counted before the write rather than from a `RETURNING` clause:
    // TypeORM's `query()` hands back a structured `[rows, affectedCount]`
    // pair for a data-modifying statement, so reducing over "the result" of
    // an UPDATE … RETURNING counted the wrapper, not the rows.
    const planned = await this.plan(queryRunner);

    // One statement does both writes: the branch expression already decided
    // which profile each asset gets, so splitting branch 5 from branch 7
    // would only create a window in which a concurrent write could move a row
    // between them.
    await queryRunner.query(`
      ${AssetTypeFromProfile1788700000000.classificationSql()},
      targets AS (
        SELECT id, branch, legacy_type,
               CASE branch
                 WHEN 'matched_by_legacy_type'   THEN matched_profile_id
                 WHEN 'assigned_default_profile' THEN fallback_profile_id
               END AS new_profile_id
        FROM classified
        WHERE branch IN ('matched_by_legacy_type', 'assigned_default_profile')
      )
      UPDATE assets a
      SET "assetProfileId" = t.new_profile_id::uuid,
          -- The audit record that makes down() exact. jsonb_set with
          -- create_missing cannot be used on a NULL additionalInfo, hence the
          -- COALESCE to an empty object.
          "additionalInfo" = COALESCE(a."additionalInfo", '{}'::jsonb)
            || jsonb_build_object('_assetTypeBackfill', jsonb_build_object(
                 'migration', 'AssetTypeFromProfile1788700000000',
                 'branch', t.branch,
                 'legacyType', t.legacy_type,
                 'previousAssetProfileId', a."assetProfileId",
                 'assignedAssetProfileId', t.new_profile_id,
                 'at', now()
               ))
      FROM targets t
      WHERE a.id = t.id
        AND t.new_profile_id IS NOT NULL
        -- Belt and braces: both write branches require it, and it is also
        -- what makes a second up() a no-op.
        AND a."assetProfileId" IS NULL
    `);

    const written =
      planned.matched_by_legacy_type + planned.assigned_default_profile;
    const unresolved =
      planned.profiled_untyped +
      planned.profile_missing +
      planned.ambiguous_legacy_match +
      planned.unresolvable_no_default;

    // eslint-disable-next-line no-console
    console.log(
      `${this.name}: assigned ${written} profile(s) ` +
        `(${planned.matched_by_legacy_type} matched by legacy type, ` +
        `${planned.assigned_default_profile} to the tenant default); ` +
        `left ${unresolved} unresolved; ` +
        `${planned.profiled_typed_disagree} row(s) where the legacy column ` +
        `disagreed with the profile were left alone — the profile wins.`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores only rows this migration wrote, identified by the audit key —
    // not "every asset of a default profile", which would strip profiles a
    // human attached afterwards.
    const pending: Array<{ n: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS n FROM assets
      WHERE "additionalInfo" -> '_assetTypeBackfill' ->> 'migration'
            = 'AssetTypeFromProfile1788700000000'
    `);

    await queryRunner.query(`
      UPDATE assets
      SET "assetProfileId" =
            NULLIF("additionalInfo" -> '_assetTypeBackfill'
                   ->> 'previousAssetProfileId', '')::uuid,
          "additionalInfo" = "additionalInfo" - '_assetTypeBackfill'
      WHERE "additionalInfo" -> '_assetTypeBackfill' ->> 'migration'
            = 'AssetTypeFromProfile1788700000000'
    `);

    await queryRunner.query(`COMMENT ON COLUMN "assets"."type" IS NULL`);

    // eslint-disable-next-line no-console
    console.log(
      `${this.name}: reverted ${Number(pending[0]?.n ?? 0)} profile assignment(s)`,
    );
  }
}
