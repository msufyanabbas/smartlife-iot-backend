/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: the backend is safe to run on more than one replica
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every defect this file asserts against has already shipped once, and every
 * one of them typechecks perfectly:
 *
 *   • `RedisService.acquireLock()` existed, was correct, and had ZERO callers,
 *     while six `@Cron` jobs fired on every replica — duplicate report emails,
 *     N copies of every scheduled notification, scheduled automations firing
 *     device commands N times, billing state swept concurrently.
 *   • `MQTTService` subscribed to `devices/+/telemetry` with no `$share/`
 *     prefix, so every replica received every uplink and persisted it: the
 *     telemetry table, Kafka throughput and alarm evaluation all multiplied by
 *     the replica count.
 *   • `@socket.io/redis-adapter` was in package.json and never wired, so
 *     `server.to(room).emit()` reached only the sockets on the emitting
 *     replica.
 *
 * `tsc` cannot see any of it. A test would need Redis, a broker, Kafka and two
 * processes. This reads the source and asserts the properties, so a NEW
 * unlocked cron — the way this regresses — fails the build.
 *
 *   npm run check:cluster-safety
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
let failures = 0;
let checks = 0;
const notes: string[] = [];

function ok(label: string, condition: boolean, detail?: unknown): void {
  checks++;
  if (condition) {
    console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \u001b[31m✗\u001b[0m ${label}`);
    if (detail !== undefined) console.log('     ', detail);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const read = (p: string): string => {
  const full = join(root, p);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

function walk(dir: string, out: string[] = []): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return out;
  for (const entry of readdirSync(full)) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ALLOW-LIST
//
// A `@Cron` may stay unlocked only by appearing here WITH A REASON. Adding an
// entry is a deliberate, reviewable act; the regression this file exists to
// catch is a new `@Cron` added with no thought about replicas at all.
//
// Categories:
//   idempotent     — a bounded, repeatable statement. Running it on three
//                    replicas wastes three queries and converges on the same
//                    state. No side effects outside the database.
//   queue-deduped  — enqueues onto Bull with a DETERMINISTIC jobId, so N
//                    ticks collapse into one actual run. This is the pattern
//                    TelemetryMaintenanceService established; it is strictly
//                    better than a lock where the work belongs on a queue.
//   db-arbitrated  — the UPDATE itself picks the winner (e.g. ... RETURNING
//                    over a status predicate), so only one replica sees rows
//                    and only it acts on them.
//   per-replica    — MUST run on every replica, because it reconciles state
//                    that process owns. Locking it would break it.
//   known-gap      — not safe, not fixed here, and owned by someone else.
//                    Reported loudly and listed in CLAUDE.md §11.
// ═══════════════════════════════════════════════════════════════════════════
type Category =
  | 'idempotent'
  | 'queue-deduped'
  | 'db-arbitrated'
  | 'per-replica'
  | 'known-gap';

interface AllowListEntry {
  file: string;
  method: string;
  category: Category;
  why: string;
}

const ALLOW_LIST: AllowListEntry[] = [
  {
    file: 'src/modules/telemetry/telemetry-maintenance.service.ts',
    method: 'enqueueAggregation',
    category: 'queue-deduped',
    why: 'jobId `agg:<tenant>:<15-min slot>` — Bull keeps one job per slot',
  },
  {
    file: 'src/modules/telemetry/telemetry-maintenance.service.ts',
    method: 'enqueueCleanup',
    category: 'queue-deduped',
    why: 'jobId `retention:<tenant>:<UTC day>`',
  },
  {
    file: 'src/modules/telemetry/telemetry-maintenance.service.ts',
    method: 'enqueueStatistics',
    category: 'queue-deduped',
    why: 'jobId `stats:<tenant>:<UTC day>`',
  },
  {
    file: 'src/modules/edge/edge.service.ts',
    method: 'detectOfflineEdges',
    category: 'db-arbitrated',
    why:
      'UPDATE ... WHERE status = active ... RETURNING *. Postgres serialises the ' +
      'two writers, so the loser gets zero rows back and emits no events — the ' +
      'database is the lock',
  },
  {
    file: 'src/modules/auth/auth.service.ts',
    method: 'cleanupExpiredBlacklistedTokens',
    category: 'idempotent',
    why: 'DELETE WHERE expiresAt < now() — the second run deletes nothing',
  },
  {
    file: 'src/modules/api-monitoring/api-monitoring.service.ts',
    method: 'cleanupOldLogs',
    category: 'idempotent',
    why: 'DELETE WHERE timestamp < cutoff — nothing to repeat',
  },
  {
    file: 'src/modules/integrations/integration-events.service.ts',
    method: 'prune',
    category: 'idempotent',
    why: 'DELETE WHERE createdAt < cutoff — nothing to repeat',
  },
  {
    file: 'src/modules/audit/audit-retention.service.ts',
    method: 'prune',
    category: 'idempotent',
    why:
      'DELETE FROM audit_logs WHERE timestamp < cutoff — one statement, no ' +
      'read-then-write, no per-row side effects. The losing replicas report ' +
      'affected: 0. Listed by the owning work stream, which notes in the file ' +
      'that adding an archive or notification step would make a lock necessary',
  },
  {
    file: 'src/modules/integrations/integration-mqtt-inbound.service.ts',
    method: 'sync',
    category: 'per-replica',
    why:
      'reconciles THIS process’s own persistent MQTT clients against the ' +
      'integration rows. Every replica must run it or its clients drift. ' +
      'Duplicate ingestion is prevented at the broker instead: the client id ' +
      'carries a per-process suffix and the topic is wrapped in $share/',
  },
  {
    file: 'src/modules/analytics/analytics.service.ts',
    method: 'generateDailyAnalytics',
    category: 'known-gap',
    why:
      'writes one analytics row per tenant per day with no uniqueness ' +
      'constraint, so N replicas write N rows and every historical series is ' +
      'multiplied. src/modules/analytics/ is owned by another work stream this ' +
      'round and was left untouched on purpose — see CLAUDE.md §11. Until it is ' +
      'locked, run it on one replica',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every @Cron is locked or explicitly allow-listed
// ═══════════════════════════════════════════════════════════════════════════
section('1. Every @Cron is locked or allow-listed');

interface FoundCron {
  file: string;
  method: string;
  distributed: boolean;
  lockName?: string;
  lockTtl?: number;
}

const found: FoundCron[] = [];

for (const file of walk('src')) {
  const src = read(file);
  if (!/@(Cron|DistributedCron)\(/.test(src)) continue;

  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*@(Cron|DistributedCron)\(/.exec(lines[i]);
    if (!match) continue;

    // The decorator call plus the method signature that follows it. Decorator
    // options are routinely wrapped over several lines, hence the window.
    const window = lines.slice(i, i + 14).join('\n');
    const method =
      /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(
        window.slice(window.indexOf('\n')),
      )?.[1] ?? '(unknown)';

    const distributed = match[1] === 'DistributedCron';
    found.push({
      file,
      method,
      distributed,
      lockName: /name:\s*'([^']+)'/.exec(window)?.[1],
      lockTtl: Number(/lockTtl:\s*(\d+)/.exec(window)?.[1] ?? NaN) || undefined,
    });
  }
}

ok(
  `found @Cron/@DistributedCron handlers to classify (${found.length})`,
  found.length >= 15,
  found.length,
);

const allowed = new Set(ALLOW_LIST.map((e) => `${e.file}#${e.method}`));
const unaccounted = found.filter(
  (c) => !c.distributed && !allowed.has(`${c.file}#${c.method}`),
);

ok(
  'no @Cron is both unlocked and unaccounted for',
  unaccounted.length === 0,
  unaccounted.length
    ? 'Add a distributed lock with @DistributedCron, or add an entry to ' +
      'ALLOW_LIST in this script stating why it is safe:\n' +
      unaccounted.map((c) => `       ${c.file} → ${c.method}()`).join('\n')
    : undefined,
);

// A stale allow-list is its own failure: an entry for a cron that has been
// renamed or deleted silently stops protecting anything.
const foundKeys = new Set(found.map((c) => `${c.file}#${c.method}`));
const stale = ALLOW_LIST.filter((e) => !foundKeys.has(`${e.file}#${e.method}`));
ok(
  'the allow-list has no stale entries',
  stale.length === 0,
  stale.map((e) => `       ${e.file} → ${e.method}()`).join('\n'),
);

// Every locked cron needs a name (it IS the lock key) and a TTL above the
// floor. A TTL left at the default would be sized for nothing in particular.
const unnamed = found.filter((c) => c.distributed && !c.lockName);
ok(
  'every @DistributedCron names its lock',
  unnamed.length === 0,
  unnamed.map((c) => `       ${c.file} → ${c.method}()`).join('\n'),
);

const names = found.filter((c) => c.distributed).map((c) => c.lockName);
ok(
  'no two locked crons share a lock name (they would starve each other)',
  new Set(names).size === names.length,
  names,
);

const shortTtl = found.filter(
  (c) => c.distributed && (c.lockTtl === undefined || c.lockTtl < 20),
);
ok(
  'every @DistributedCron sets a lockTtl of at least 20s',
  shortTtl.length === 0,
  shortTtl.map((c) => `       ${c.method}() → ${c.lockTtl ?? 'unset'}`).join('\n'),
);

// The six jobs named in the original defect report. Asserted by NAME, so
// removing a lock from one of them fails here even if the method is renamed.
const mustBeLocked = [
  ['src/modules/reports/report-scheduler.service.ts', 'report-schedule-tick'],
  ['src/modules/notifications/notifications.service.ts', 'notifications-scheduled-tick'],
  ['src/modules/automation/automation.scheduler.ts', 'automation-schedule-tick'],
  ['src/modules/integrations/tuya-sync.service.ts', 'tuya-state-poll'],
  ['src/modules/subscriptions/subscriptions.service.ts', 'subscriptions-expiry-sweep'],
  ['src/modules/subscriptions/subscriptions.service.ts', 'subscriptions-monthly-usage-reset'],
  // Not in the original list of six, and locked anyway: the bulk UPDATE is
  // idempotent but the loop underneath it emits device.offline, which fires
  // DEVICE_STATUS automations. See the note on the method.
  ['src/modules/devices/devices.service.ts', 'devices-offline-sweep'],
] as const;

for (const [file, lockName] of mustBeLocked) {
  const src = read(file);
  ok(
    `${lockName} is locked`,
    src.includes('DistributedCron') && src.includes(`'${lockName}'`),
    file,
  );
}

for (const entry of ALLOW_LIST.filter((e) => e.category === 'known-gap')) {
  notes.push(
    `KNOWN GAP — ${entry.file} → ${entry.method}(): ${entry.why}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The lock itself has the properties that make it a lock
// ═══════════════════════════════════════════════════════════════════════════
section('2. The lock is a real lock');

const lockSvc = read('src/lib/cluster/distributed-lock.service.ts');
const redisSvc = read('src/lib/redis/redis.service.ts');
const decorator = read('src/lib/cluster/distributed-cron.decorator.ts');

ok('DistributedLockService exists', lockSvc.length > 0);
ok(
  'it claims the lock with SET NX EX, through RedisService.acquireLock',
  lockSvc.includes('acquireLock('),
);
ok(
  'acquireLock still uses SET ... EX ... NX (atomic claim, with a TTL)',
  /set\(\s*lockKey,\s*owner,\s*'EX',\s*ttl,\s*'NX'\s*\)/.test(redisSvc),
);
ok(
  'the lock is RELEASED on completion, in a finally block',
  /finally\s*\{[\s\S]{0,400}releaseLockIfOwner/.test(lockSvc),
  'without this, the next tick of a per-minute cron is starved until the TTL',
);
ok(
  'release is compare-and-delete, so an overrun cannot unlock another replica',
  redisSvc.includes('releaseLockIfOwner') &&
    /get',\s*KEYS\[1\]\)\s*==\s*ARGV\[1\]/.test(redisSvc),
);
ok(
  'the lock still expires on its own, so a SIGKILLed holder does not wedge the job',
  /'EX',\s*ttl/.test(redisSvc) && lockSvc.includes('ttlSeconds'),
);
ok(
  'the TTL is RENEWED while the body runs, so it cannot be outlived',
  lockSvc.includes('extendLockIfOwner') && lockSvc.includes('startWatchdog'),
  'a TTL shorter than the run means two replicas execute anyway',
);
// Anchored on the reason string rather than on a character window.
//
// This previously read /catch[\s\S]{0,400}ran:\s*false/ and broke when the
// error message in that catch block grew — the message now names the
// consequence (nine crons stop platform-wide) and the escape hatch, which
// pushed `ran: false` past 400 characters. The behaviour had not changed at
// all, so the guard was reporting prose length as a safety regression.
//
// `reason: 'disabled-no-redis'` is a literal that exists for exactly this
// branch, so matching it is both tighter than the window and immune to the
// wording around it. A second assertion pins the fail direction explicitly,
// because the dangerous mutation here is a one-word edit — `ran: true` —
// which would make every replica run every cron whenever Redis hiccups.
ok(
  'an unreachable Redis SKIPS the job rather than running it everywhere',
  /reason:\s*'disabled-no-redis'/.test(lockSvc) &&
    /ran:\s*false,\s*reason:\s*'disabled-no-redis'/.test(lockSvc),
  'the Redis-unreachable branch must return ran: false',
);
ok(
  'and that skip is counted, so it is not silent',
  lockSvc.includes('recordSkip') && /degraded/.test(lockSvc),
  'nine crons stopping with nothing in a health probe is how it goes unnoticed for days',
);
ok(
  'the decorator refuses an unnamed job at class-definition time',
  decorator.includes('requires a name'),
);
ok(
  'a missing ClusterModule fails closed and says so',
  /if \(!lock\)\s*\{[\s\S]{0,800}return undefined;[\s\S]{0,20}\}/.test(decorator),
);
ok(
  'ClusterModule is registered in the application',
  read('src/modules/index.module.ts').includes('ClusterModule'),
  '@DistributedCron resolves the service through a static holder set on ' +
    'construction — unregistered means every locked cron silently no-ops',
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. MQTT uses a shared subscription
// ═══════════════════════════════════════════════════════════════════════════
section('3. MQTT ingestion is load-balanced, not fanned out');

const mqttSvc = read('src/lib/mqtt/mqtt.service.ts');
const mqttCfg = read('src/config/mqtt.config.ts');
const inbound = read(
  'src/modules/integrations/integration-mqtt-inbound.service.ts',
);

ok('MQTTService wraps uplink filters in $share/', mqttSvc.includes('$share/'));
ok(
  'the subscribe call uses the wrapped filter, not the raw topic',
  /subscribe\(\s*filter,/.test(mqttSvc),
  'wrapping a topic and then subscribing to the unwrapped one is the obvious ' +
    'way for this to regress',
);
ok(
  'it is configurable (some brokers do not implement the extension)',
  mqttCfg.includes('MQTT_SHARED_SUBSCRIPTION'),
);
ok(
  'and it DEFAULTS ON',
  /MQTT_SHARED_SUBSCRIPTION,\s*true/.test(mqttCfg),
  'off by default would mean a fresh deployment duplicates all telemetry',
);
ok(
  'the share group is configurable',
  mqttCfg.includes('MQTT_SHARED_GROUP') && mqttSvc.includes('sharedGroup'),
);
ok(
  'an already-$share filter is not double-wrapped',
  mqttSvc.includes("startsWith('$share/')"),
);
ok(
  'turning it off warns, rather than failing silently',
  /MQTT_SHARED_SUBSCRIPTION=false[\s\S]{0,200}every replica/.test(mqttSvc),
);
ok(
  'the integration inbound subscriptions are shared too',
  inbound.includes('$share/') && inbound.includes('sharedFilter'),
);
ok(
  'inbound MQTT client ids are unique per process',
  inbound.includes('NODE_SUFFIX'),
  'a fixed client id makes two replicas disconnect each other in a loop',
);
// The platform's own client id was already per-process; assert it stays so.
ok(
  'the platform MQTT client id is unique per process',
  /clientIdPrefix\}-\$\{process\.pid\}/.test(mqttSvc),
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. The Socket.IO Redis adapter is wired
// ═══════════════════════════════════════════════════════════════════════════
section('4. WebSocket pushes cross replicas');

const adapter = read('src/lib/websocket/redis-io.adapter.ts');
const main = read('src/main.ts');

ok('a custom IoAdapter exists', adapter.length > 0);
ok(
  'it is built on @socket.io/redis-adapter',
  adapter.includes("from '@socket.io/redis-adapter'"),
);
ok(
  'it uses two separate connections (a subscriber cannot run commands)',
  /pubClient[\s\S]{0,200}subClient/.test(adapter),
);
ok(
  'the duplicates are explicitly connected (duplicate() inherits lazyConnect)',
  /duplicate\(\)[\s\S]{0,600}connect\(\)/.test(adapter),
);
ok(
  'main.ts registers it',
  main.includes('RedisIoAdapter') && main.includes('useWebSocketAdapter'),
);
ok(
  'it is registered BEFORE listen(), when the Socket.IO server is created',
  // `await app.listen(` rather than `app.listen(`: the latter also matches the
  // prose in the comment above the registration, which sits earlier in the
  // file and made this assertion pass or fail on where a comment was written.
  main.indexOf('useWebSocketAdapter') < main.indexOf('await app.listen('),
);
ok(
  'a Redis failure degrades instead of preventing boot',
  /catch[\s\S]{0,500}Falling back to the in-memory adapter/.test(adapter) &&
    !/throw/.test(adapter.split('async connect')[1]?.split('createIOServer')[0] ?? ''),
);
ok(
  'the channel prefix is configurable, so two deployments can share one Redis',
  adapter.includes('WS_REDIS_ADAPTER_KEY'),
);

// All three gateways must be reachable for the adapter to be worth anything.
const gateways = [
  ['src/modules/websocket/websocket.gateway.ts', "'/ws'", 'WebsocketModule'],
  ['src/modules/alarms/alarms.gateway.ts', "'/alarms'", 'AlarmsModule'],
  [
    'src/modules/telemetry/telemetry.gateway.ts',
    "'/telemetry'",
    'TelemetryModule',
  ],
] as const;

for (const [file, namespace] of gateways) {
  const src = read(file);
  ok(`${namespace} gateway declares its namespace`, src.includes(namespace), file);
}

// The /telemetry gateway was dead code — in no module's providers — so the
// namespace did not exist at all. Registered, not deleted.
ok(
  'TelemetryGateway is registered in a module (it was dead code)',
  read('src/modules/telemetry/telemetry.module.ts').includes('TelemetryGateway'),
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. Cross-replica RPC correlation
// ═══════════════════════════════════════════════════════════════════════════
section('5. Two-way device RPC survives landing on another replica');

const correlator = read('src/modules/protocols/rpc-correlator.service.ts');

ok(
  'the correlator relays responses it does not own',
  correlator.includes('cluster:rpc:response') && correlator.includes('relay('),
);
ok(
  'it subscribes to the relay channel',
  /subscribe\(RELAY_CHANNEL/.test(correlator),
);
ok(
  'a relayed response is settled LOCAL-ONLY, so it cannot loop',
  correlator.includes('settleLocal') &&
    /onRelayed[\s\S]{0,900}settleLocal\(/.test(correlator) &&
    !/onRelayed[\s\S]{0,900}this\.relay\(/.test(correlator),
);
ok(
  'a node ignores its own echo',
  correlator.includes('message.origin === this.nodeId'),
);
ok(
  'a mismatched device key is NOT offered to other replicas',
  correlator.includes("outcome === 'unknown'"),
);
ok(
  'Redis is optional, so the class stays testable without it',
  correlator.includes('@Optional()'),
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. Uploads — the storage seam
// ═══════════════════════════════════════════════════════════════════════════
section('6. Uploads go through a storage abstraction');

const storageIface = read('src/lib/storage/storage.interface.ts');
const localDriver = read('src/lib/storage/local-storage.driver.ts');
const s3Driver = read('src/lib/storage/s3-storage.driver.ts');
const storageSvc = read('src/lib/storage/storage.service.ts');

ok('a StorageDriver interface exists', storageIface.includes('StorageDriver'));
ok('a local driver implements it', localDriver.includes('implements StorageDriver'));
ok(
  'the s3 driver is a clearly-marked stub that fails loudly',
  s3Driver.includes('NOT IMPLEMENTED') && s3Driver.includes('throw new Error'),
);
ok(
  'STORAGE_DRIVER=s3 fails at BOOT rather than on the first upload',
  /case 's3':[\s\S]{0,300}new S3StorageDriver\(\)/.test(storageSvc),
);
ok(
  'a non-shared driver warns that uploads are replica-local',
  storageSvc.includes('NOT shared'),
);
ok(
  'StorageModule is registered',
  read('src/modules/index.module.ts').includes('StorageModule'),
);

// Which call sites moved, and which did not. The ones that did not are listed
// so the report is honest rather than implying all six are done.
const converted = [
  'src/modules/images/images.service.ts',
  'src/modules/firmware/firmware.service.ts',
  'src/modules/solution-templates/solution-template.service.ts',
  'src/modules/floor-plans/floor-plans.service.ts',
];
for (const file of converted) {
  ok(
    `${file.split('/').slice(-1)[0]} writes through StorageService`,
    read(file).includes('this.storage.put('),
    file,
  );
}

// The two floor-plan files are now asserted rather than merely reported.
//
// Listing a file as "not converted" and printing a note was the right shape
// while another work stream owned it, but a note is not a guard: the next
// `fs.writeFile` added to either file would have been reported in exactly the
// same words as the ones that were already there, so nothing would have
// changed on the screen and nothing would have failed. These two files are
// done, so the assertion is now the other way round — a direct write
// reappearing in them FAILS the build.
//
// `dwg-parser.service.ts` is the interesting one. It still needs a real local
// file, because DWG → DXF conversion shells out to an external binary that
// takes a path. That scratch write lives in `src/lib/storage/scratch-file.ts`
// (`withScratchFile`), deliberately NOT in the service: a legitimate exception
// written into this check is a hole the next genuine regression hides in.
const noDirectWrites = [
  'src/modules/floor-plans/floor-plans.service.ts',
  'src/modules/floor-plans/dwg-parser.service.ts',
];
for (const file of noDirectWrites) {
  const source = read(file);
  ok(
    `${file.split('/').slice(-1)[0]} has NO direct fs.writeFile`,
    source.length > 0 && !/\bfs\.writeFile\b/.test(source),
    'uploads and generated artefacts must go through StorageService, or the ' +
      'bytes land on one replica and every later GET 404s elsewhere',
  );
  ok(
    `${file.split('/').slice(-1)[0]} has no mkdir for an upload directory`,
    source.length > 0 && !/\bfs\.mkdir\b/.test(source),
    'creating an upload directory here implies the artefact is local, which is ' +
      'exactly the assumption the seam removes',
  );
}

// The scratch seam the DWG converter depends on. Without the cleanup this
// trades a replica-local artefact for an unbounded tmpfs leak.
const scratch = read('src/lib/storage/scratch-file.ts');
ok(
  'a scratch-file helper exists for work that needs a real local path',
  scratch.includes('export async function withScratchFile'),
);
ok(
  'the scratch file is unique per call',
  scratch.includes('mkdtemp'),
  'a fixed name lets two concurrent parses delete each other’s converted DXF',
);
ok(
  'and is removed in a finally, on success and on throw',
  /finally\s*\{[\s\S]{0,400}fs\.rm\(/.test(scratch),
);

// The read paths. A converted write with an unconverted read is worse than no
// conversion: it looks finished and 404s (N-1)/N of the time.
const floorPlans = read('src/modules/floor-plans/floor-plans.service.ts');
ok(
  'the floor-plan read paths resolve bytes through StorageService',
  /getModelFile[\s\S]{0,1200}this\.readRef\(/.test(floorPlans) &&
    /getDwgFile[\s\S]{0,1200}this\.readRef\(/.test(floorPlans) &&
    /getPreviewFile[\s\S]{0,1200}this\.readRef\(/.test(floorPlans),
  'getModelFile used to rebuild <modelDir>/<id>.<type> and stream it with fs',
);
ok(
  'and nothing in the module streams a floor-plan file from a local path',
  !/createReadStream/.test(
    read('src/modules/floor-plans/floor-plans.controller.ts'),
  ),
);
ok(
  'a legacy /uploads URL or absolute path is still readable',
  floorPlans.includes('resolveRef') &&
    floorPlans.includes('legacyPath') &&
    /this\.urlPrefix/.test(floorPlans),
  'rows written before the seam hold a URL or an absolute path, not a key — ' +
    'they must keep resolving or the conversion is a data-loss event',
);
ok(
  'the row stores a driver-independent key, not a path',
  floorPlans.includes('dwgStorageKey') &&
    floorPlans.includes('modelStorageKey') &&
    floorPlans.includes('thumbnailStorageKey'),
);

const notConverted = ['src/modules/reports/reports.service.ts'];
for (const file of notConverted) {
  if (read(file).includes('fs.writeFile')) {
    notes.push(
      `STILL ON DIRECT fs — ${file} (owned by another work stream this round; ` +
        'the storage seam exists, the call site has not moved)',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. The deployment can actually be scaled
// ═══════════════════════════════════════════════════════════════════════════
section('7. The compose stack can run --scale app=N');

const prod = read('docker-compose.prod.yml');
const scale = read('docker-compose.scale.yml');

ok('the single-node file is unchanged and still pins a name', prod.includes('container_name: smartlife-app'));
ok('a scalable variant exists', scale.length > 0);
ok(
  'the scalable app service does NOT pin container_name',
  scale.length > 0 && !/app:[\s\S]{0,600}container_name:/.test(scale),
  'a fixed container_name makes --scale fail with a name conflict',
);
ok(
  'and does not bind a fixed host port',
  scale.length > 0 && !/^\s+-\s+"5000:5000"/m.test(scale),
  'a fixed host port makes the second replica fail to bind',
);
ok(
  'a reverse proxy fronts the replicas',
  scale.includes('nginx') && existsSync(join(root, 'docker/nginx/nginx.conf')),
);
ok(
  'the proxy is configured for WebSocket upgrades',
  read('docker/nginx/nginx.conf').includes('Upgrade'),
  'without the Upgrade headers every socket falls back to polling, and with ' +
    'round-robin polling a Socket.IO session breaks outright',
);

// ═══════════════════════════════════════════════════════════════════════════
section('Notes');
if (notes.length === 0) console.log('  (none)');
for (const note of notes) console.log(`  \u001b[33m!\u001b[0m ${note}`);

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: every cron is locked or accounted for, ` +
        `MQTT is shared, the Socket.IO adapter is wired\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
