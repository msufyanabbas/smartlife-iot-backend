/**
 * Verifies that an asset has exactly ONE type, that it comes from its
 * AssetProfile, and that every floor-plan read resolves the same value.
 *
 *   createdb assettypecheck && npm run verify:asset-type-inheritance assettypecheck
 *   dropdb assettypecheck
 *
 * `assets.type` and `asset_profiles.type` were two closed vocabularies
 * answering the same question with no rule for which won — so a warehouse was
 * `warehouse` to its profile and `infrastructure` or `other` to its own
 * column, and the 3D viewer picked a context scene from whichever read
 * happened to run. The asserts below are the properties that make "the profile
 * is the answer" true rather than merely intended:
 *
 *   1. the asset's type IS its profile's type, on every read path
 *   2. a floor plan resolves the same value as its asset — on the detail read,
 *      the per-asset overview and the 3D simulation route
 *   3. repointing the asset at a different profile changes BOTH, with no write
 *      to the asset's own type; and editing the PROFILE's type changes both too
 *   4. a write that still sends `type` is ignored, and the legacy column keeps
 *      the value it had — the deprecation does not mutate live data
 *   5. an asset with no profile resolves to null and its floor plans still
 *      read, which is the documented "behaves sensibly" case
 *   6. the backfill classifies each row into exactly one branch, writes only
 *      the two resolvable branches, is idempotent, and down() reverts exactly
 *      what up() wrote
 */
import * as os from 'os';
import * as path from 'path';
import { randomUUID as uuidForUploadRoot } from 'crypto';

// FloorPlansService and StorageService both read these at CONSTRUCTION, so
// they are set before either is imported. A scratch upload root keeps this
// verification out of the repository's ./uploads directory.
process.env.UPLOAD_PATH = path.join(
  os.tmpdir(),
  `asset-type-verify-${uuidForUploadRoot()}`,
);
process.env.STORAGE_DRIVER = 'local';

import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import * as entities from '../src/modules/index.entities';
import { StorageService } from '../src/lib/storage/storage.service';
import { AssetsService } from '../src/modules/assets/assets.service';
import { FloorPlansService } from '../src/modules/floor-plans/floor-plans.service';
import { AssetTypeFromProfile1788700000000 } from '../src/database/migrations/1788700000000-AssetTypeFromProfile';
import { UserRole } from '../src/common/enums/index.enum';

const database = process.argv[2] ?? 'assettypecheck';

let failures = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};
const section = (t: string) => console.log(`\n── ${t} ─────────────`);

const T_A = randomUUID();
const T_B = randomUUID();
const USER_A = randomUUID();

(async () => {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });
  await ds.initialize();
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);

  for (const t of ['floor_plan_devices', 'floor_plans', 'assets', 'asset_profiles', 'users', 'tenants']) {
    await q(`DELETE FROM "${t}"`).catch(() => undefined);
  }

  for (const [i, id] of [T_A, T_B].entries()) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1,$2,$3)', [
      id, `Type tenant ${i}`, `type${i}-${id.slice(0, 8)}@example.invalid`,
    ]);
  }
  await q(
    `INSERT INTO users (id,email,password,name,role,"tenantId")
     VALUES ($1,$2,'x','admin',$3,$4)`,
    [USER_A, `admin-${USER_A.slice(0, 8)}@example.invalid`, UserRole.TENANT_ADMIN, T_A],
  );

  // ── Profiles ────────────────────────────────────────────────────────────
  // Tenant A gets one profile per type plus a default Custom. Tenant B gets
  // TWO building profiles and no default — the ambiguous/unresolvable tenant.
  const profile = async (
    tenantId: string,
    name: string,
    type: string | null,
    isDefault = false,
    schema: unknown = { fields: [] },
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO asset_profiles (id,"tenantId",name,type,"default",schema)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenantId, name, type, isDefault, JSON.stringify(schema)],
    );
    return id;
  };

  const P_BUILDING = await profile(T_A, 'Building', 'building');
  const P_WAREHOUSE = await profile(T_A, 'Warehouse', 'warehouse');
  const P_VEHICLE = await profile(T_A, 'Vehicle', 'vehicle');
  const P_CUSTOM = await profile(T_A, 'Custom', 'custom', true);
  const P_UNTYPED = await profile(T_A, 'Legacy untyped', null);
  const P_DELETED = await profile(T_A, 'Retired', 'factory');
  await q('UPDATE asset_profiles SET deleted_at = now() WHERE id = $1', [P_DELETED]);

  const P_B_ONE = await profile(T_B, 'Tower profile', 'building');
  await profile(T_B, 'Campus profile', 'building');

  // ── Assets, one per backfill branch ─────────────────────────────────────
  const asset = async (
    tenantId: string,
    name: string,
    legacyType: string,
    assetProfileId: string | null,
    configuration: unknown = {},
  ) => {
    const id = randomUUID();
    await q(
      `INSERT INTO assets (id,"tenantId",name,type,"assetProfileId",configuration)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenantId, name, legacyType, assetProfileId, JSON.stringify(configuration)],
    );
    return id;
  };

  //                                            legacy      profile
  const A_AGREE = await asset(T_A, 'Agreeing tower', 'building', P_BUILDING);
  const A_DISAGREE = await asset(T_A, 'Depot', 'infrastructure', P_WAREHOUSE);
  const A_UNTYPED_PROFILE = await asset(T_A, 'Odd one', 'other', P_UNTYPED);
  const A_DANGLING = await asset(T_A, 'Orphan', 'building', P_DELETED);
  const A_MATCHABLE = await asset(T_A, 'Unprofiled tower', 'building', null);
  const A_MATCHABLE_VEHICLE = await asset(T_A, 'Unprofiled van', 'vehicle', null);
  const A_FALLBACK = await asset(T_A, 'Unprofiled room', 'room', null);
  const A_FALLBACK_2 = await asset(T_A, 'Unprofiled widget', 'equipment', null);
  const A_AMBIGUOUS = await asset(T_B, 'Ambiguous tower', 'building', null);
  const A_NO_DEFAULT = await asset(T_B, 'Nothing to go on', 'zone', null);

  // ── Services ────────────────────────────────────────────────────────────
  const repo = (e: any): Repository<any> => ds.getRepository(e);
  const noopSubscriptions = {
    incrementTenantUsage: async () => undefined,
    decrementTenantUsage: async () => undefined,
  } as any;

  const assets = new AssetsService(
    repo(entities.Asset),
    repo(entities.Device),
    repo(entities.FloorPlan),
    repo((entities as any).FloorPlanDevice),
    repo(entities.AssetProfile),
    repo(entities.Telemetry),
    repo(entities.Alarm),
    { emit: () => true } as any,
    noopSubscriptions,
  );

  const floorPlans = new FloorPlansService(
    repo(entities.FloorPlan),
    repo((entities as any).FloorPlanDevice),
    repo(entities.Asset),
    repo(entities.Device),
    repo(entities.Telemetry),
    repo(entities.Alarm),
    repo(entities.Subscription),
    noopSubscriptions,
    // DWGParserService: this script never uploads a drawing, and the parser is
    // only reached from the upload path.
    {} as any,
    // A REAL StorageService on the local driver, not a stub. FloorPlansService
    // now resolves every file reference through it (`resolveRef`/`readRef`), so
    // a stub answering undefined would let the projection assertions below
    // pass without the storage seam being exercised at all — the shape of bug
    // this whole suite of verifiers exists to catch. Pointed at a scratch
    // directory so it cannot touch the repository's ./uploads.
    new StorageService(),
  );

  const admin = {
    id: USER_A,
    tenantId: T_A,
    role: UserRole.TENANT_ADMIN,
    customerId: null,
  } as any;

  // Floor plans: one on a profiled asset, one on an asset with no profile.
  const plan = async (assetId: string, tenantId: string, floorNumber: number) => {
    const id = randomUUID();
    await q(
      `INSERT INTO floor_plans
         (id,"tenantId","userId","assetId",name,building,floor,"floorNumber",dimensions)
       VALUES ($1,$2,$3,$4,$5,'Block A','Floor 1',$6,$7)`,
      [id, tenantId, USER_A, assetId, `Plan ${floorNumber}`, floorNumber,
       JSON.stringify({ width: 50, height: 30, unit: 'meters' })],
    );
    return id;
  };
  const FP_PROFILED = await plan(A_DISAGREE, T_A, 1);
  const FP_UNPROFILED = await plan(A_FALLBACK, T_A, 1);

  // ════════════════════════════════════════════════════════════════════════
  section('1. The asset\'s type comes from its profile');

  const one = await assets.findOne(A_DISAGREE, admin);
  ok("findOne() answers the PROFILE's type, not the legacy column",
    one.assetType === 'warehouse', { assetType: one.assetType, legacy: one.type });
  ok('the legacy column still holds its original value, unread and unchanged',
    one.type === 'infrastructure', one.type);
  ok('resolveAssetType() and the materialised field agree',
    one.resolveAssetType() === one.assetType);

  const agreeing = await assets.findOne(A_AGREE, admin);
  ok('an asset whose two columns agreed is unaffected',
    agreeing.assetType === 'building', agreeing.assetType);

  const untypedProfile = await assets.findOne(A_UNTYPED_PROFILE, admin);
  ok('a profile with no type yields null, not a guessed default',
    untypedProfile.assetType === null, untypedProfile.assetType);

  const unprofiled = await assets.findOne(A_FALLBACK, admin);
  ok('an asset with no profile yields null',
    unprofiled.assetType === null, unprofiled.assetType);

  section('2. The list paths resolve it too, and filter/sort through it');

  const list = await assets.findAll(admin, undefined, { page: 1, limit: 50 } as any);
  const byName = new Map(list.data.map((a) => [a.name, a]));
  ok('every listed asset carries assetType',
    list.data.every((a) => a.assetType !== undefined), list.data.length);
  ok('and it is the profile\'s value',
    byName.get('Depot')?.assetType === 'warehouse',
    byName.get('Depot')?.assetType);

  const warehouses = await assets.findAll(admin, undefined, {
    page: 1, limit: 50, type: 'warehouse',
  } as any);
  ok('?type=warehouse matches through the PROFILE',
    warehouses.data.length === 1 && warehouses.data[0].id === A_DISAGREE,
    warehouses.data.map((a) => a.name));

  const legacyMiss = await assets.findAll(admin, undefined, {
    page: 1, limit: 50, type: 'building',
  } as any);
  ok('?type=building does NOT match an asset whose legacy column says building but whose profile does not',
    !legacyMiss.data.some((a) => a.id === A_DANGLING),
    legacyMiss.data.map((a) => a.name));

  const untyped = await assets.findAll(admin, undefined, {
    page: 1, limit: 50, untyped: true,
  } as any);
  ok('?untyped=true finds the assets with no resolvable type',
    untyped.data.every((a) => a.assetType === null) &&
      untyped.data.some((a) => a.id === A_UNTYPED_PROFILE),
    untyped.data.map((a) => [a.name, a.assetType]));

  const sorted = await assets.findAll(admin, undefined, {
    page: 1, limit: 50, sortBy: 'type', sortOrder: 'ASC',
  } as any);
  ok('?sortBy=type sorts without error and keeps the resolved values',
    sorted.data.length === list.data.length,
    { sorted: sorted.data.length, list: list.data.length });

  const stats = await assets.getStatistics(admin);
  ok('statistics are keyed by AssetProfileType',
    stats.byType.warehouse === 1 && stats.byType.building === 1,
    stats.byType);
  // Six of tenant A's eight assets have no resolvable type at this point:
  // the four with no profile, the one on an untyped profile, and the one whose
  // profile is soft-deleted. The last two are the cases that would otherwise
  // hide — they LOOK profiled.
  ok('and assets with no resolvable type land in `unassigned`, not in a type bucket',
    stats.byType.unassigned === 6, stats.byType);
  ok('the removed AssetType vocabulary is gone from the keys',
    !('infrastructure' in stats.byType) && !('room' in stats.byType),
    Object.keys(stats.byType));

  section('3. A floor plan resolves the SAME value as its asset');

  const enriched: any = await floorPlans.findOneEnriched(FP_PROFILED, T_A);
  ok('the detail read resolves the asset type through the profile',
    enriched.asset.assetType === 'warehouse', enriched.asset);
  ok('it matches what the asset itself answers',
    enriched.asset.assetType === one.assetType);
  ok('the duplicated free-text `type` is gone from the projection',
    !('type' in enriched.asset), Object.keys(enriched.asset));
  ok('and the profile id is exposed so a UI can offer to fix an untyped asset',
    enriched.asset.assetProfileId === P_WAREHOUSE, enriched.asset.assetProfileId);

  const overview: any = await floorPlans.getAssetFloorPlansOverview(A_DISAGREE, T_A);
  ok('GET /floor-plans/asset/:assetId resolves the same value',
    overview.asset.assetType === 'warehouse', overview.asset);

  const sim: any = await floorPlans.get3DSimulationData(A_DISAGREE, T_A);
  ok('the 3D simulation route resolves the same value',
    sim.assetType === 'warehouse' && sim.asset.assetType === 'warehouse',
    { assetType: sim.assetType, asset: sim.asset });

  const floors: any = await assets.getFloors(A_DISAGREE, admin);
  ok('GET /assets/:id/floors resolves the same value',
    floors.assetType === 'warehouse' && floors.assetProfileType === 'warehouse',
    { assetType: floors.assetType, assetProfileType: floors.assetProfileType });

  section('4. A floor plan whose asset has NO profile behaves sensibly');

  const orphanPlan: any = await floorPlans.findOneEnriched(FP_UNPROFILED, T_A);
  ok('the plan still reads — nothing throws and nothing is withheld',
    orphanPlan.id === FP_UNPROFILED && orphanPlan.dimensions?.width === 50,
    orphanPlan.id);
  ok('its asset type is null (→ the viewer\'s neutral `ground` scene)',
    orphanPlan.asset.assetType === null, orphanPlan.asset);
  ok('assetProfileId is null too, so a UI can say WHY there is no type',
    orphanPlan.asset.assetProfileId === null, orphanPlan.asset);
  const orphanSim: any = await floorPlans.get3DSimulationData(A_FALLBACK, T_A);
  ok('the 3D route answers null rather than failing',
    orphanSim.assetType === null && Array.isArray(orphanSim.floors),
    orphanSim.assetType);

  section('5. Changing the profile changes BOTH the asset and its floor plan');

  await assets.update(A_DISAGREE, { assetProfileId: P_BUILDING } as any, admin);
  const moved = await assets.findOne(A_DISAGREE, admin);
  const movedPlan: any = await floorPlans.findOneEnriched(FP_PROFILED, T_A);
  ok('the asset now answers the new profile\'s type',
    moved.assetType === 'building', moved.assetType);
  ok('and so does its floor plan, with no floor-plan write of any kind',
    movedPlan.asset.assetType === 'building', movedPlan.asset.assetType);
  ok('the legacy column was not touched by the repoint',
    moved.type === 'infrastructure', moved.type);

  // Editing the PROFILE's own type, which is the other half of "single source":
  // nothing is copied onto the asset, so the change is visible immediately.
  await q(`UPDATE asset_profiles SET type = 'factory' WHERE id = $1`, [P_BUILDING]);
  const retyped = await assets.findOne(A_DISAGREE, admin);
  const retypedPlan: any = await floorPlans.findOneEnriched(FP_PROFILED, T_A);
  ok('retyping the PROFILE retypes the asset',
    retyped.assetType === 'factory', retyped.assetType);
  ok('and its floor plan',
    retypedPlan.asset.assetType === 'factory', retypedPlan.asset.assetType);
  await q(`UPDATE asset_profiles SET type = 'building' WHERE id = $1`, [P_BUILDING]);
  await assets.update(A_DISAGREE, { assetProfileId: P_WAREHOUSE } as any, admin);

  section('6. Writes no longer accept a type');

  const created = await assets.create(
    { name: 'Written with a type', type: 'vehicle', assetProfileId: P_WAREHOUSE } as any,
    admin,
  );
  ok('POST /assets ignores `type` and answers the profile\'s',
    created.assetType === 'warehouse', created.assetType);
  const createdRow = await q('SELECT type FROM assets WHERE id = $1', [created.id]);
  ok('the deprecated column got the enum default, not the submitted value',
    createdRow[0].type === 'other', createdRow[0].type);

  await assets.update(A_AGREE, { type: 'zone', label: 'touched' } as any, admin);
  const patched = await q('SELECT type, label FROM assets WHERE id = $1', [A_AGREE]);
  ok('PATCH /assets/:id ignores `type` while applying the rest of the body',
    patched[0].type === 'building' && patched[0].label === 'touched', patched[0]);

  section('7. The backfill: one branch per row, and only two of them write');

  const migration = new AssetTypeFromProfile1788700000000();
  const runner = ds.createQueryRunner();
  await runner.connect();

  const before = await migration.plan(runner);
  // 11 live assets: 10 fixtures + the one created in section 6.
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  ok('every live asset is classified exactly once', total === 11, before);
  ok('profiled-and-agreeing rows are counted, not rewritten',
    before.profiled_typed_agree === 1, before);
  ok('profiled-and-disagreeing rows are counted and LEFT ALONE — the profile wins',
    before.profiled_typed_disagree === 2, before);
  ok('a profile with no type is unresolved, not forced to `custom`',
    before.profiled_untyped === 1, before);
  ok('a dangling assetProfileId is unresolved, not re-pointed',
    before.profile_missing === 1, before);
  ok('building/vehicle match their tenant\'s single profile of that type',
    before.matched_by_legacy_type === 2, before);
  ok('two building profiles in one tenant is AMBIGUOUS, not a coin flip',
    before.ambiguous_legacy_match === 1, before);
  ok('room/equipment get the tenant default — they are not kinds of building',
    before.assigned_default_profile === 2, before);
  ok('a tenant with no single default leaves its asset unresolved',
    before.unresolvable_no_default === 1, before);

  const unresolvedList = await migration.unresolved(runner);
  ok('the unresolved rows are reported individually, with ids',
    unresolvedList.length === 4 &&
      unresolvedList.every((r) => !!r.id && !!r.branch),
    unresolvedList);

  await migration.up(runner);

  const matched = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_MATCHABLE]);
  ok('the matchable building asset got the tenant\'s Building profile',
    matched[0].assetProfileId === P_BUILDING, matched[0]);
  const matchedVehicle = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_MATCHABLE_VEHICLE]);
  ok('the matchable vehicle got the Vehicle profile',
    matchedVehicle[0].assetProfileId === P_VEHICLE, matchedVehicle[0]);
  const fallback = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_FALLBACK]);
  ok('the unmatchable asset got the tenant default (Custom — an empty schema, so nothing becomes invalid)',
    fallback[0].assetProfileId === P_CUSTOM, fallback[0]);
  const ambiguous = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_AMBIGUOUS]);
  ok('the ambiguous asset was NOT assigned either candidate',
    ambiguous[0].assetProfileId === null, ambiguous[0]);
  const noDefault = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_NO_DEFAULT]);
  ok('nor was the one whose tenant has no default',
    noDefault[0].assetProfileId === null, noDefault[0]);
  const dangling = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_DANGLING]);
  ok('the dangling reference was left dangling rather than silently repaired',
    dangling[0].assetProfileId === P_DELETED, dangling[0]);
  ok('nothing wrote to the deprecated column',
    (await q('SELECT type FROM assets WHERE id = $1', [A_MATCHABLE]))[0].type === 'building');

  // Resolution now flows through, which is the point of the backfill.
  const backfilled = await assets.findOne(A_MATCHABLE, admin);
  ok('a backfilled asset now resolves a type through its new profile',
    backfilled.assetType === 'building', backfilled.assetType);
  const backfilledPlan: any = await floorPlans.findOneEnriched(FP_UNPROFILED, T_A);
  ok('and the floor plan of a backfilled asset resolves the same value',
    backfilledPlan.asset.assetType === 'custom', backfilledPlan.asset.assetType);

  section('8. Idempotency and reversal');

  const afterFirst = await migration.plan(runner);
  ok('after up(), nothing is left in the two writing branches',
    afterFirst.matched_by_legacy_type === 0 &&
      afterFirst.assigned_default_profile === 0, afterFirst);

  const snapshot = await q(
    'SELECT id, "assetProfileId" FROM assets ORDER BY id',
  );
  await migration.up(runner);
  const afterSecond = await q(
    'SELECT id, "assetProfileId" FROM assets ORDER BY id',
  );
  ok('a second up() changes nothing — the backfill is idempotent',
    JSON.stringify(snapshot) === JSON.stringify(afterSecond));
  ok('and the unresolved count is unchanged by re-running it',
    JSON.stringify(await migration.plan(runner)) === JSON.stringify(afterFirst));

  // A human profiles the ambiguous asset by hand. down() must not undo that.
  await q('UPDATE assets SET "assetProfileId" = $1 WHERE id = $2', [P_B_ONE, A_AMBIGUOUS]);

  await migration.down(runner);
  const reverted = await q(
    'SELECT "assetProfileId", "additionalInfo" FROM assets WHERE id = ANY($1)',
    [[A_MATCHABLE, A_MATCHABLE_VEHICLE, A_FALLBACK, A_FALLBACK_2]],
  );
  ok('down() restores every assignment up() made',
    reverted.every((r: any) => r.assetProfileId === null), reverted);
  ok('and removes its own audit key rather than leaving litter in additionalInfo',
    reverted.every((r: any) => !r.additionalInfo?._assetTypeBackfill), reverted);
  const humanChoice = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_AMBIGUOUS]);
  ok('a profile a HUMAN attached afterwards survives down()',
    humanChoice[0].assetProfileId === P_B_ONE, humanChoice[0]);
  const stillAgreeing = await q('SELECT "assetProfileId" FROM assets WHERE id = $1', [A_AGREE]);
  ok('an asset that already had a profile is untouched by down()',
    stillAgreeing[0].assetProfileId === P_BUILDING, stillAgreeing[0]);

  await runner.release();
  await ds.destroy();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — one type per asset, inherited from its profile, resolved identically by every asset and floor-plan read',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
