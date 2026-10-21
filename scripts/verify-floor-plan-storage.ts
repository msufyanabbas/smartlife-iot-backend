/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: floor-plan files survive behind a load balancer
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `check-cluster-safety.ts` reads the source and asserts that the two
 * floor-plan services name `StorageService` and not `fs.writeFile`. That is
 * worth having, but it proves only that the call exists. The failure mode this
 * repository keeps producing is code that compiles, looks right and does
 * nothing: device auth that was never called, audit handlers that wrote zero
 * rows, a Redis cache with no reader.
 *
 * So this runs the real `StorageService`, the real `FloorPlansService` and the
 * real `DWGParserService` against a real Postgres, pushes an actual DXF through
 * the upload → parse → preview → model → download pipeline, and compares
 * BYTES. A regression here is a length that does not match, not a stack trace.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-floor-plan-storage.ts [db]
 *   npm run verify:floor-plan-storage
 *
 * It creates its own throwaway rows in whatever database is named (default
 * `fpstorage`) and deletes them again. Uploads go to a unique directory under
 * os.tmpdir(), never the repository's ./uploads.
 *
 * Nothing here needs Kafka, Redis, MQTT or the Nest DI container. A `.dxf`
 * upload also needs no external converter — only `.dwg` shells out — so the
 * whole parse path is exercised on a bare machine.
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Environment, BEFORE anything constructs a driver ───────────────────────
// Both StorageService and FloorPlansService read these at construction, so
// pointing them at a scratch directory here keeps the verification out of the
// repository's own upload directory.
const UPLOAD_ROOT = path.join(os.tmpdir(), `fp-storage-verify-${randomUUID()}`);
process.env.UPLOAD_PATH = UPLOAD_ROOT;
process.env.STORAGE_DRIVER = 'local';
process.env.UPLOAD_URL_PREFIX = '/uploads';

import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';
import { FloorPlan } from '../src/modules/floor-plans/entities/floor-plan.entity';
import { FloorPlansService } from '../src/modules/floor-plans/floor-plans.service';
import { DWGParserService } from '../src/modules/floor-plans/dwg-parser.service';
import { StorageService } from '../src/lib/storage/storage.service';
import { withScratchFile } from '../src/lib/storage/scratch-file';
import { FloorPlanStorageKeys1788800000000 } from '../src/database/migrations/1788800000000-FloorPlanStorageKeys';
import { FloorPlanStatus, UserRole } from '../src/common/enums/index.enum';
import { ModelFormat } from '../src/modules/floor-plans/dto/generate-model.dto';

const database = process.argv[2] ?? 'fpstorage';

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/** devices/floor_plans.userId is NOT NULL with an FK, so fixtures need a graph. */
const TENANT = randomUUID();
const OWNER = randomUUID();
const ASSET = randomUUID();

/**
 * A minimal but genuinely valid DXF: two LINE entities on `A-WALL`, which
 * `DxfFloorPlanParser.WALL_LAYERS` matches (`/^a-wall/i`). Two walls is enough
 * for `validateGeometry()` to pass and for the mesh factory to produce solids,
 * which is what makes the generate-model leg of this reachable.
 */
const DXF = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$INSUNITS', '70', '6',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'A-WALL',
  '10', '0.0', '20', '0.0', '30', '0.0',
  '11', '10.0', '21', '0.0', '31', '0.0',
  '0', 'LINE', '8', 'A-WALL',
  '10', '10.0', '20', '0.0', '30', '0.0',
  '11', '10.0', '21', '8.0', '31', '0.0',
  '0', 'LINE', '8', 'A-WALL',
  '10', '10.0', '20', '8.0', '30', '0.0',
  '11', '0.0', '21', '8.0', '31', '0.0',
  '0', 'LINE', '8', 'A-WALL',
  '10', '0.0', '20', '8.0', '30', '0.0',
  '11', '0.0', '21', '0.0', '31', '0.0',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

/** A multer file as the controller hands one over. */
const upload = (name: string, bytes: Buffer) =>
  ({
    originalname: name,
    buffer: bytes,
    size: bytes.length,
    mimetype: 'application/octet-stream',
  }) as any;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dataSource = new DataSource({
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
  await dataSource.initialize();

  const planRepo = dataSource.getRepository(FloorPlan);
  const q = (sql: string, params: any[] = []) => planRepo.query(sql, params);

  /** Directories this script created under process.cwd(), removed at the end. */
  const createdCwdDirs: string[] = [];
  const createdCwdFiles: string[] = [];

  // `tenants.name` is UNIQUE, so the fixture names carry the run's uuid and
  // cleanup sweeps by prefix as well as by id. Without the prefix sweep, one
  // crashed run leaves a row that makes every later run fail on the insert
  // rather than on whatever it was meant to check.
  const cleanup = async () => {
    await q(
      `DELETE FROM floor_plan_devices WHERE "tenantId" IN
         (SELECT id FROM tenants WHERE name LIKE 'fp-storage-tenant-%')`,
    );
    await q(
      `DELETE FROM floor_plans WHERE "tenantId" IN
         (SELECT id FROM tenants WHERE name LIKE 'fp-storage-tenant-%')`,
    );
    await q(
      `DELETE FROM assets WHERE "tenantId" IN
         (SELECT id FROM tenants WHERE name LIKE 'fp-storage-tenant-%')`,
    );
    await q(`DELETE FROM users WHERE name LIKE 'fp-storage-owner-%'`);
    await q(`DELETE FROM tenants WHERE name LIKE 'fp-storage-tenant-%'`);
  };
  await cleanup();

  await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
    TENANT,
    `fp-storage-tenant-${TENANT.slice(0, 8)}`,
    `t-${TENANT.slice(0, 8)}@example.test`,
  ]);
  await q(
    'INSERT INTO users (id, name, email, password) VALUES ($1, $2, $3, $4)',
    [
      OWNER,
      `fp-storage-owner-${OWNER.slice(0, 8)}`,
      `o-${OWNER.slice(0, 8)}@example.test`,
      'not-a-real-hash',
    ],
  );
  // `assets` has no userId column (unlike devices and floor_plans) — found by
  // running this, not by reading the entity.
  await q('INSERT INTO assets (id, "tenantId", name) VALUES ($1, $2, $3)', [
    ASSET,
    TENANT,
    'fp-storage-asset',
  ]);

  const storage = new StorageService();
  const parser = new DWGParserService();

  // `incrementTenantUsage` / `decrementTenantUsage` are the only two methods
  // FloorPlansService calls on SubscriptionsService, and both call sites
  // already swallow failures. A stub keeps this verification off the payment
  // and mail dependency graph.
  const subscriptionsStub = {
    incrementTenantUsage: async () => undefined,
    decrementTenantUsage: async () => undefined,
  } as any;

  const service = new FloorPlansService(
    planRepo,
    dataSource.getRepository(entities.FloorPlanDevice as any) as any,
    dataSource.getRepository(entities.Asset as any) as any,
    dataSource.getRepository(entities.Device as any) as any,
    dataSource.getRepository(entities.Telemetry as any) as any,
    dataSource.getRepository(entities.Alarm as any) as any,
    dataSource.getRepository(entities.Subscription as any) as any,
    subscriptionsStub,
    parser,
    storage,
  );

  const actor = { userId: OWNER, tenantId: TENANT, role: UserRole.SUPER_ADMIN };
  const priv = service as any;

  const newPlan = async (name: string): Promise<FloorPlan> =>
    planRepo.save(
      planRepo.create({
        tenantId: TENANT,
        userId: OWNER,
        assetId: ASSET,
        name,
        building: 'fp-storage-building',
        floor: name,
        floorNumber: null as any,
        dimensions: { width: 100, height: 100, unit: 'meters' },
        devices: [],
        zones: [],
        createdBy: OWNER,
      }),
    );

  // ═══════════════════════════════════════════════════════════════════════
  section('1. StorageService actually round-trips bytes');

  ok(
    'the driver in use is reported',
    storage.describe().driver === 'local',
    storage.describe(),
  );

  // Random bytes, not text: a driver that mangled encodings would pass a
  // string comparison and corrupt a GLB.
  const probe = Buffer.alloc(64 * 1024);
  for (let i = 0; i < probe.length; i++) probe[i] = (i * 31 + 7) % 256;
  const probeKey = `floor-plans/dwg/${randomUUID()}.bin`;

  const storedProbe = await storage.put(probeKey, probe, {
    contentType: 'application/octet-stream',
  });
  ok('put() returns the key it was given', storedProbe.key === probeKey, storedProbe);
  ok('put() reports the real size', storedProbe.size === probe.length, storedProbe);
  ok(
    'put() produces a /uploads URL for the local driver',
    storedProbe.url === `/uploads/${probeKey}`,
    storedProbe.url,
  );
  ok('exists() is true after a put', await storage.exists(probeKey));

  const readBack = await storage.get(probeKey);
  ok(
    'get() returns byte-identical content',
    readBack.length === probe.length && readBack.equals(probe),
    { got: readBack.length, want: probe.length },
  );

  ok('delete() reports success', (await storage.delete(probeKey)) === true);
  ok('exists() is false after a delete', (await storage.exists(probeKey)) === false);
  ok(
    'deleting an absent key is not an error',
    (await storage.delete(probeKey)) === false,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('2. The scratch seam the DWG converter needs');

  let scratchSeen = '';
  const scratchResult = await withScratchFile(probe, '.dwg', async (file) => {
    scratchSeen = file.path;
    const onDisk = await fs.readFile(file.path);
    ok(
      'the bytes are readable at a real local path',
      onDisk.equals(probe),
      file.path,
    );
    ok('the path keeps the extension the converter dispatches on', file.path.endsWith('.dwg'));
    ok('it is outside the upload root', !file.path.startsWith(UPLOAD_ROOT));
    return 'done';
  });
  ok('the callback result is returned', scratchResult === 'done');
  ok(
    'the scratch file is gone afterwards',
    !(await fs
      .access(scratchSeen)
      .then(() => true)
      .catch(() => false)),
    scratchSeen,
  );

  let thrownThrough = false;
  let pathOnThrow = '';
  try {
    await withScratchFile(probe, '.dwg', async (file) => {
      pathOnThrow = file.path;
      throw new Error('converter blew up');
    });
  } catch (error) {
    thrownThrough = (error as Error).message === 'converter blew up';
  }
  ok('an error in the work is not swallowed', thrownThrough);
  ok(
    'and the scratch file is STILL removed',
    !(await fs
      .access(pathOnThrow)
      .then(() => true)
      .catch(() => false)),
    pathOnThrow,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('3. The legacy-path resolver classifies all four shapes');

  const refOf = (v: string | null | undefined) => priv.resolveRef(v);

  ok(
    'a storage key stays a key',
    refOf('floor-plans/dwg/a.dxf').key === 'floor-plans/dwg/a.dxf' &&
      refOf('floor-plans/dwg/a.dxf').legacyPath === null,
    refOf('floor-plans/dwg/a.dxf'),
  );
  ok(
    'a legacy /uploads URL yields the SAME key the local driver would write',
    refOf('/uploads/floor-plans/dwg/a.dxf').key === 'floor-plans/dwg/a.dxf',
    refOf('/uploads/floor-plans/dwg/a.dxf'),
  );
  ok(
    'and keeps the absolute path it used to mean as a fallback',
    refOf('/uploads/floor-plans/dwg/a.dxf').legacyPath ===
      path.join(process.cwd(), '/uploads/floor-plans/dwg/a.dxf'),
    refOf('/uploads/floor-plans/dwg/a.dxf'),
  );
  ok(
    'a legacy absolute path under the storage root yields a key',
    refOf(path.join(UPLOAD_ROOT, 'floor-plans/models/x.glb')).key ===
      'floor-plans/models/x.glb',
    refOf(path.join(UPLOAD_ROOT, 'floor-plans/models/x.glb')),
  );
  ok(
    'an absolute path OUTSIDE the root yields no key, only the path',
    refOf('/var/data/elsewhere/x.glb').key === null &&
      refOf('/var/data/elsewhere/x.glb').legacyPath === '/var/data/elsewhere/x.glb',
    refOf('/var/data/elsewhere/x.glb'),
  );
  ok(
    'an http(s) URL is external — not read, not deleted',
    refOf('https://example.com/floorplans/hq-thumb.png').external === true &&
      refOf('https://example.com/floorplans/hq-thumb.png').key === null,
    refOf('https://example.com/floorplans/hq-thumb.png'),
  );
  ok(
    'the seeded thumbnail shape reads as external rather than as a key',
    (await priv.readRef('https://example.com/floorplans/hq-thumb.png')) === null,
  );
  ok(
    'a traversal in a stored value is refused, not resolved',
    refOf('floor-plans/../../etc/passwd').key === null,
    refOf('floor-plans/../../etc/passwd'),
  );
  ok(
    'null and empty are not references',
    refOf(null).key === null && refOf('').key === null && refOf('   ').key === null,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('4. Upload → parse → preview, end to end');

  const plan = await newPlan('Storage Floor 1');
  const dxfBytes = Buffer.from(DXF, 'utf-8');

  const uploaded = await service.uploadDWGFile(
    plan.id,
    actor,
    upload('client supplied name.dxf', dxfBytes),
  );

  ok(
    'the row stores a relative POSIX key, not a path',
    !!uploaded.dwgStorageKey &&
      uploaded.dwgStorageKey.startsWith('floor-plans/dwg/') &&
      !path.isAbsolute(uploaded.dwgStorageKey) &&
      !uploaded.dwgStorageKey.includes('\\'),
    uploaded.dwgStorageKey,
  );
  ok(
    'the key does NOT contain the client-supplied filename',
    !uploaded.dwgStorageKey!.includes('client supplied'),
    uploaded.dwgStorageKey,
  );
  ok(
    'the public URL is still /uploads/... so existing clients keep working',
    uploaded.dwgFileUrl === `/uploads/${uploaded.dwgStorageKey}`,
    uploaded.dwgFileUrl,
  );
  ok(
    'the driver that wrote it is recorded',
    uploaded.storageProvider === 'local',
    uploaded.storageProvider,
  );
  ok(
    'the bytes really are in storage under that key',
    await storage.exists(uploaded.dwgStorageKey!),
  );

  // The download route — the half that, left unconverted, makes the whole
  // exercise look finished and 404 behind a balancer.
  const dwgDownload = await service.getDwgFile(plan.id, TENANT);
  ok(
    'GET /floor-plans/:id/dwg returns byte-identical content',
    dwgDownload.buffer.equals(dxfBytes),
    { got: dwgDownload.buffer.length, want: dxfBytes.length },
  );
  ok(
    'the download filename is derived from the plan, not the upload',
    dwgDownload.fileName === 'Storage Floor 1.dxf',
    dwgDownload.fileName,
  );

  // The parse is fire-and-forget; poll the row rather than guessing a delay.
  let parsed: FloorPlan | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(500);
    parsed = await planRepo.findOne({ where: { id: plan.id } });
    if (parsed && parsed.status !== FloorPlanStatus.PROCESSING) break;
  }

  ok(
    'the async parse reads the source back THROUGH storage and succeeds',
    parsed?.status === FloorPlanStatus.ACTIVE,
    { status: parsed?.status, error: parsed?.parsingError },
  );
  ok(
    'geometry was extracted',
    (parsed?.parsedGeometry?.walls?.length ?? 0) > 0,
    parsed?.parsedGeometry?.walls?.length,
  );
  ok(
    'the preview is keyed off the floor plan id, under previews/',
    parsed?.thumbnailStorageKey === `floor-plans/previews/${plan.id}.png`,
    parsed?.thumbnailStorageKey,
  );

  const previewDownload = await service.getPreviewFile(plan.id, TENANT);
  ok(
    'the preview is served back from storage as a real PNG',
    previewDownload.buffer.length > 0 &&
      previewDownload.buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    previewDownload.buffer.subarray(0, 8),
  );
  ok(
    'and its bytes match what is in storage',
    (await storage.get(parsed!.thumbnailStorageKey!)).equals(
      previewDownload.buffer,
    ),
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('5. Generated and uploaded 3D models');

  const generated = await service.generateModel(plan.id, actor, {
    format: ModelFormat.OBJ,
  });
  const afterGenerate = await planRepo.findOne({ where: { id: plan.id } });

  ok(
    'generateModel stores the model under a key',
    afterGenerate?.modelStorageKey === `floor-plans/models/${plan.id}.obj`,
    afterGenerate?.modelStorageKey,
  );
  ok(
    'the companion .mtl is stored too, not written beside it on disk',
    generated.companionFiles.length === 1 &&
      (await storage.exists(`floor-plans/models/${plan.id}.mtl`)),
    generated.companionFiles,
  );

  const modelDownload = await service.getModelFile(plan.id, TENANT);
  ok(
    'GET /floor-plans/:id/model returns the generated bytes',
    modelDownload.buffer.length === generated.sizeBytes &&
      modelDownload.buffer.equals(
        await storage.get(afterGenerate!.modelStorageKey!),
      ),
    { got: modelDownload.buffer.length, want: generated.sizeBytes },
  );
  ok(
    'with the right content type for the format',
    modelDownload.contentType === 'model/obj',
    modelDownload.contentType,
  );

  // A format change must remove the old artefact, or it is an orphan nothing
  // can reach.
  const glbPlan = await service.generateModel(plan.id, actor, {
    format: ModelFormat.GLB,
  });
  ok(
    'changing format stores the new model',
    await storage.exists(`floor-plans/models/${plan.id}.glb`),
    glbPlan.fileName,
  );
  ok(
    'and deletes the superseded one through the seam',
    (await storage.exists(`floor-plans/models/${plan.id}.obj`)) === false,
  );

  // uploadModel: the same key, a different source of bytes.
  const objBytes = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'utf-8');
  const uploadedModel = await service.uploadModel(
    plan.id,
    actor,
    upload('mine.obj', objBytes),
  );
  ok(
    'uploadModel stores through the seam',
    uploadedModel.modelStorageKey === `floor-plans/models/${plan.id}.obj`,
    uploadedModel.modelStorageKey,
  );
  ok(
    'and its bytes come back unchanged',
    (await service.getModelFile(plan.id, TENANT)).buffer.equals(objBytes),
  );
  ok(
    'the superseded .glb was removed',
    (await storage.exists(`floor-plans/models/${plan.id}.glb`)) === false,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('6. Rows written BEFORE the seam still read');

  // (a) A row holding only a legacy /uploads URL, bytes in the storage root.
  const legacyUrlPlan = await newPlan('Legacy URL Floor');
  const legacyName = `${randomUUID()}.dxf`;
  await storage.put(`floor-plans/dwg/${legacyName}`, dxfBytes);
  await planRepo.update(
    { id: legacyUrlPlan.id },
    {
      dwgStorageKey: null as any,
      dwgFileUrl: `/uploads/floor-plans/dwg/${legacyName}`,
    },
  );
  ok(
    'a /uploads URL with a NULL key still serves the right bytes',
    (await service.getDwgFile(legacyUrlPlan.id, TENANT)).buffer.equals(dxfBytes),
  );

  // (b) A row holding an absolute filesystem path inside the storage root.
  const legacyAbsPlan = await newPlan('Legacy Absolute Floor');
  const absName = `${randomUUID()}.dxf`;
  const absStored = await storage.put(`floor-plans/dwg/${absName}`, dxfBytes);
  await planRepo.update(
    { id: legacyAbsPlan.id },
    { dwgStorageKey: null as any, dwgFileUrl: absStored.localPath! },
  );
  ok(
    'an absolute path with a NULL key still serves the right bytes',
    (await service.getDwgFile(legacyAbsPlan.id, TENANT)).buffer.equals(dxfBytes),
  );

  // (c) The hard case: the key MISSES and only the legacy path hits. This is a
  //     deployment whose UPLOAD_PATH moved after the rows were written — the
  //     derived key points at the new root, where the bytes are not.
  const strandedPlan = await newPlan('Stranded Floor');
  const strandedName = `${randomUUID()}.dxf`;
  const strandedDir = path.join(process.cwd(), 'uploads', 'floor-plans', 'dwg');
  await fs.mkdir(strandedDir, { recursive: true });
  createdCwdDirs.push(
    strandedDir,
    path.dirname(strandedDir),
    path.join(process.cwd(), 'uploads'),
  );
  const strandedFile = path.join(strandedDir, strandedName);
  await fs.writeFile(strandedFile, dxfBytes);
  createdCwdFiles.push(strandedFile);
  await planRepo.update(
    { id: strandedPlan.id },
    {
      dwgStorageKey: null as any,
      dwgFileUrl: `/uploads/floor-plans/dwg/${strandedName}`,
    },
  );
  ok(
    'the derived key really does miss for this row',
    (await storage.exists(`floor-plans/dwg/${strandedName}`)) === false,
  );
  ok(
    'and the legacy absolute path is used as the fallback',
    (await service.getDwgFile(strandedPlan.id, TENANT)).buffer.equals(dxfBytes),
    'without this fallback, moving UPLOAD_PATH would 404 every pre-seam row',
  );

  // (d) A row with nothing stored is a clean 404, not a 500.
  const emptyPlan = await newPlan('Empty Floor');
  let notFound = '';
  try {
    await service.getDwgFile(emptyPlan.id, TENANT);
  } catch (error) {
    notFound = (error as Error).constructor.name;
  }
  ok('a plan with no upload raises NotFoundException', notFound === 'NotFoundException', notFound);

  let missingPreview = '';
  try {
    await service.getPreviewFile(emptyPlan.id, TENANT);
  } catch (error) {
    missingPreview = (error as Error).constructor.name;
  }
  ok(
    'so does a plan with no preview',
    missingPreview === 'NotFoundException',
    missingPreview,
  );

  // (e) Tenant scoping is unchanged by any of this.
  let crossTenant = '';
  try {
    await service.getDwgFile(plan.id, randomUUID());
  } catch (error) {
    crossTenant = (error as Error).constructor.name;
  }
  ok(
    'another tenant cannot download this plan’s source',
    crossTenant === 'NotFoundException',
    crossTenant,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('7. The backfill migration populates the key columns');

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await new FloorPlanStorageKeys1788800000000().up(runner);
  await runner.release();

  const backfilled = await planRepo.findOne({ where: { id: legacyUrlPlan.id } });
  ok(
    'a legacy /uploads URL is turned into the matching key',
    backfilled?.dwgStorageKey === `floor-plans/dwg/${legacyName}`,
    backfilled?.dwgStorageKey,
  );
  ok(
    'and the URL itself is left exactly as it was',
    backfilled?.dwgFileUrl === `/uploads/floor-plans/dwg/${legacyName}`,
    backfilled?.dwgFileUrl,
  );
  ok(
    'the driver is recorded for backfilled rows',
    backfilled?.storageProvider === 'local',
    backfilled?.storageProvider,
  );

  // An absolute-path row has no /uploads prefix, so the backfill must leave it
  // alone rather than writing a nonsense key. The resolver still reads it —
  // asserted in section 6(b).
  const absRow = await planRepo.findOne({ where: { id: legacyAbsPlan.id } });
  ok(
    'an absolute-path row is NOT given a bogus key by the backfill',
    absRow?.dwgStorageKey == null,
    absRow?.dwgStorageKey,
  );

  // An external URL must never be rewritten into a key.
  const externalPlan = await newPlan('External Thumb Floor');
  await planRepo.update(
    { id: externalPlan.id },
    { thumbnailUrl: 'https://example.com/floorplans/hq-thumb.png' },
  );
  const runner2 = dataSource.createQueryRunner();
  await runner2.connect();
  await new FloorPlanStorageKeys1788800000000().up(runner2);
  await runner2.release();
  const externalRow = await planRepo.findOne({ where: { id: externalPlan.id } });
  ok(
    'an https:// thumbnailUrl is never turned into a key',
    externalRow?.thumbnailStorageKey == null,
    externalRow?.thumbnailStorageKey,
  );
  ok(
    'and re-running the migration is idempotent',
    (await planRepo.findOne({ where: { id: legacyUrlPlan.id } }))
      ?.dwgStorageKey === `floor-plans/dwg/${legacyName}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section('8. Deleting a plan removes its bytes');

  const dwgKey = parsed!.dwgStorageKey!;
  const previewKey = parsed!.thumbnailStorageKey!;
  const modelKey = `floor-plans/models/${plan.id}.obj`;

  await service.remove(plan.id, actor);

  ok('the source drawing is gone', (await storage.exists(dwgKey)) === false, dwgKey);
  ok('the preview is gone', (await storage.exists(previewKey)) === false, previewKey);
  ok('the model is gone', (await storage.exists(modelKey)) === false, modelKey);

  // And the external-URL row deletes cleanly without trying to unlink a path
  // derived from someone else's hostname.
  let externalRemoveThrew = false;
  try {
    await service.remove(externalPlan.id, actor);
  } catch {
    externalRemoveThrew = true;
  }
  ok('removing a plan with an external thumbnail does not throw', !externalRemoveThrew);

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup
  await cleanup();
  await dataSource.destroy();

  for (const file of createdCwdFiles) {
    await fs.unlink(file).catch(() => undefined);
  }
  // Only removes them if they are empty, so a repository that already had an
  // uploads/ directory with content keeps it.
  for (const dir of createdCwdDirs) {
    await fs.rmdir(dir).catch(() => undefined);
  }
  await fs.rm(UPLOAD_ROOT, { recursive: true, force: true }).catch(() => undefined);

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: floor-plan files are written, read and ` +
          `deleted through StorageService, and pre-seam rows still resolve\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
