/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Guard: Kafka and Redis are wired so that neither can take the platform down,
 *        and nothing is cached without a path that invalidates it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three classes of bug live here, and all three typecheck perfectly.
 *
 *   1. **A broker that decides whether the app boots.** `KafkaModule`'s factory
 *      awaited `initProducer()`, and `DeviceCommandsConsumer`'s un-caught
 *      `connect()` was an unhandled rejection. Either one killed the process
 *      before `app.listen()`, so there was no HTTP server and no `/health` to
 *      explain it. The only way to notice is to try it with the broker down —
 *      which nobody does, because the fix is one `await` away from coming back.
 *
 *   2. **A cache with no invalidation.** A cached permission set that outlives
 *      a revocation is a security bug: the administrator is told access was
 *      removed and it is still being granted. The dangerous version is not a
 *      missing TTL, it is a *missing call site* — the fifteenth place that
 *      writes a row, added by someone with no reason to know a cache exists.
 *
 *   3. **A topic nobody reads, or a consumer with nowhere to fail to.** A
 *      declared-but-unconsumed topic looks live in every operator's topic
 *      list, and a consumer whose handler swallows its own errors drops
 *      messages with one log line and an advanced offset — unrecoverable and
 *      uncountable.
 *
 * `tsc` sees none of it, and a test would need a database, a broker and Redis.
 * This reads the source and asserts the properties.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/check-infra-wiring.ts
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..');
let failures = 0;
let checks = 0;

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

/**
 * Source with comments removed.
 *
 * Needed because several assertions here look for the ABSENCE of a pattern,
 * and these files document the pattern they removed — `kafka.module.ts`
 * explains that it used to `await service.initProducer()`, so a naive search
 * for that string finds the explanation and reports the bug as still present.
 * A guard script that fails on its own documentation teaches people to delete
 * the documentation.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const kafkaService = read('src/lib/kafka/kafka.service.ts');
const kafkaModule = read('src/lib/kafka/kafka.module.ts');
const kafkaConfig = read('src/config/kafka.config.ts');
const redisService = read('src/lib/redis/redis.service.ts');
const redisModule = read('src/lib/redis/redis.module.ts');
const permCache = read('src/lib/redis/permission-cache.service.ts');
const subCache = read('src/lib/redis/subscription-cache.service.ts');
const subSubscriber = read(
  'src/modules/subscriptions/subscription-cache.subscriber.ts',
);
const latestCache = read(
  'src/modules/telemetry/telemetry-latest-cache.service.ts',
);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The app boots with Kafka unreachable
// ═══════════════════════════════════════════════════════════════════════════
section('1. An unreachable broker cannot stop the boot');

ok(
  'KafkaModule’s factory is NOT async — nothing in it can reject',
  /useFactory:\s*\(configService: ConfigService\):\s*KafkaService\s*=>/.test(
    kafkaModule,
  ),
  'an async factory that awaits a connect rejects the whole DI graph',
);
ok(
  'the factory does not await initProducer() or createTopics()',
  !/await\s+service\.(initProducer|createTopics)/.test(
    stripComments(kafkaModule),
  ),
  'this exact line is what used to exit the process before app.listen()',
);
ok(
  'the factory starts a background bootstrap instead',
  /service\.bootstrap\(\)/.test(kafkaModule),
);
ok(
  'bootstrap() is declared to return void, so it cannot be awaited by mistake',
  /bootstrap\(\):\s*void/.test(kafkaService),
);
ok(
  'the reconnect backoff is capped',
  kafkaService.includes('bootstrapMaxBackoffMs') &&
    /Math\.min\(\s*grown,\s*this\.settings\.bootstrapMaxBackoffMs/.test(
      kafkaService,
    ),
  'an uncapped backoff either hammers a dead broker or waits forever',
);
ok(
  'createConsumer() records the registration and retries rather than throwing',
  kafkaService.includes('this.registrations.set(') &&
    /attachConsumer\([\s\S]{0,120}\.catch\(/.test(kafkaService),
);

// The specific consumer whose missing try/catch was the unhandled rejection.
const commandsConsumer = read(
  'src/modules/device-commands/device-commands.consumer.ts',
);
ok(
  'DeviceCommandsConsumer still registers its group',
  commandsConsumer.includes("'device-commands-consumer-group'"),
);

// ── KAFKA_ENABLED=false is a real mode, not just an unread variable ────────
ok(
  'kafka.config declares `enabled`, defaulting to ON',
  /enabled:\s*envBoolean\(process\.env\.KAFKA_ENABLED,\s*true\)/.test(
    kafkaConfig,
  ),
  'only an explicit false may disable it — a forgotten variable in production '
    + 'must not silently stop ingestion',
);
ok(
  'with Kafka disabled no client is constructed at all',
  /if \(!this\.settings\.enabled\)[\s\S]{0,400}return;[\s\S]{0,200}this\.kafka = new Kafka/.test(
    kafkaService,
  ),
  'constructing a client against a broker that is not there produces a '
    + 'reconnect loop in the logs of every local dev run',
);
ok(
  'a produce with Kafka disabled is a logged no-op, not a throw',
  kafkaService.includes('warnDisabledOnce'),
  '"there is no broker here" is a different statement from "the broker is down"',
);
ok(
  'the health indicator reports a deliberately disabled Kafka as healthy',
  /if \(!status\.enabled\)[\s\S]{0,300}true/.test(
    read('src/modules/health/indicators/kafka.health.ts'),
  ),
  'otherwise KAFKA_ENABLED=false fails readiness and the orchestrator '
    + 'restarts the pod forever',
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. A produce that cannot be queued fails loudly
// ═══════════════════════════════════════════════════════════════════════════
section('2. A reading that was not queued is not reported as accepted');

ok(
  'sendMessage throws when the producer is not connected',
  kafkaService.includes('KafkaUnavailableError') &&
    kafkaService.includes('assertProducerReady'),
);
ok(
  'refused produces are counted, not only logged',
  kafkaService.includes('this.refusedProduces++'),
  '"telemetry stopped arriving" and "telemetry is being thrown away" look '
    + 'identical on a dashboard and need different responses',
);
ok(
  'the count is exposed on the health status',
  kafkaService.includes('refusedProduces:') &&
    read('src/modules/health/indicators/kafka.health.ts').includes(
      'refusedProduces',
    ),
);
ok(
  'DeviceListenerService names a dropped frame explicitly',
  read('src/modules/protocols/device-listener.service.ts').includes(
    'TELEMETRY DROPPED',
  ),
);
ok(
  'DeviceListenerService does NOT rethrow it',
  /KafkaUnavailableError'[\s\S]{0,700}return;/.test(
    read('src/modules/protocols/device-listener.service.ts'),
  ),
  'handleTelemetry() has ~20 callers, several of them bare timers where a '
    + 'rejection is an unhandled rejection — the failure this work removes',
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Every declared topic has a consumer, or a stated reason
// ═══════════════════════════════════════════════════════════════════════════
section('3. Topics: consumed, or documented as not');

ok(
  'the topic list is a registry with a consumer column',
  kafkaService.includes('TOPIC_REGISTRY'),
  'a bare array of topic names cannot express "and nobody reads this"',
);

// Parse the registry out of the source. Deliberately textual: importing the
// module would construct a Kafka client and read config.
const registryBlock =
  kafkaService.match(
    /export const TOPIC_REGISTRY[\s\S]*?\}> = \[([\s\S]*?)\n\];/,
  )?.[1] ?? '';

type Entry = {
  topic: string;
  consumedBy: string | null;
  dlqTopic?: string;
  hasReason: boolean;
};

const entries: Entry[] = [];
for (const chunk of registryBlock.split(/\n\s*\{\s*\n/).slice(1)) {
  const topic = chunk.match(/topic:\s*'([^']+)'/)?.[1];
  if (!topic) continue;
  const consumedByRaw = chunk.match(/consumedBy:\s*(null|'([^']+)')/);
  entries.push({
    topic,
    consumedBy: consumedByRaw?.[2] ?? null,
    dlqTopic: chunk.match(/dlqTopic:\s*'([^']+)'/)?.[1],
    hasReason: /reason:/.test(chunk),
  });
}

ok(`the registry parsed (${entries.length} topics)`, entries.length >= 20, entries.length);

const unconsumedWithoutReason = entries.filter(
  (e) => !e.consumedBy && !e.hasReason,
);
ok(
  'every unconsumed topic states WHY it has no consumer',
  unconsumedWithoutReason.length === 0,
  unconsumedWithoutReason.map((e) => e.topic),
);

const consumedWithoutDlq = entries.filter((e) => e.consumedBy && !e.dlqTopic);
ok(
  'every consumed topic names a dead-letter topic',
  consumedWithoutDlq.length === 0,
  consumedWithoutDlq.map((e) => e.topic),
);

// A group named in the registry must actually be created somewhere, and every
// group that is created must appear in the registry. Either direction being
// wrong means the registry has stopped describing reality — which makes every
// other assertion in this section worthless.
const consumerSources = [
  'src/modules/telemetry/telemetry.consumer.ts',
  'src/modules/automation/automation.consumer.ts',
  'src/modules/rules/rule-engine.consumer.ts',
  'src/modules/firmware/firmware.consumer.ts',
  'src/modules/device-commands/device-commands.consumer.ts',
].map((p) => ({ path: p, src: read(p) }));

const allConsumerSource = consumerSources.map((c) => c.src).join('\n');
const declaredGroups = new Set(
  entries.map((e) => e.consumedBy).filter((g): g is string => !!g),
);

const missingGroups = [...declaredGroups].filter(
  (g) => !allConsumerSource.includes(`'${g}'`),
);
ok(
  'every consumer group the registry names is really created',
  missingGroups.length === 0,
  missingGroups,
);

const createdGroups = new Set(
  [...allConsumerSource.matchAll(/createConsumer\(\s*\n?\s*'([^']+)'/g)].map(
    (m) => m[1],
  ),
);
const unregisteredGroups = [...createdGroups].filter(
  (g) => !declaredGroups.has(g),
);
ok(
  'every consumer group that is created appears in the registry',
  unregisteredGroups.length === 0,
  unregisteredGroups,
);

// Topics produced to but never declared get broker auto-creation, which uses
// the BROKER's partition count and replication factor rather than this
// platform's — so `KAFKA_TOPIC_REPLICATION_FACTOR` silently does not apply to
// them. Both firmware topics were in exactly that state.
const declaredTopics = new Set(entries.map((e) => e.topic));
for (const t of [
  'telemetry.device.raw',
  'telemetry.device.validated',
  'telemetry.device.invalid',
  'rules.input',
  'device.commands',
  'device.commands.retry',
  'firmware.update',
  'firmware.status',
]) {
  ok(`"${t}" is declared in the registry`, declaredTopics.has(t));
}

// The dead audit consumer. Owned elsewhere; this only asserts that the two
// topics it would read are still ACCOUNTED FOR rather than quietly dropped.
const auditTopics = entries.filter((e) =>
  e.topic.startsWith('audit.'),
);
ok(
  'the audit topics are present and carry a reason (the consumer is dead code)',
  auditTopics.length === 2 && auditTopics.every((e) => e.hasReason),
  auditTopics,
);

// ═══════════════════════════════════════════════════════════════════════════
// 4. A failed message is retried, bounded, and then dead-lettered
// ═══════════════════════════════════════════════════════════════════════════
section('4. Message failure is bounded and visible');

ok(
  'the handler wrapper retries a bounded number of times',
  kafkaService.includes('consumerMaxAttempts') &&
    /for \(let attempt = 1; attempt <= attempts; attempt\+\+\)/.test(
      kafkaService,
    ),
);
ok(
  'the backoff between attempts grows',
  /consumerRetryBackoffMs \* attempt/.test(kafkaService),
);
ok(
  'exhausted retries go to the DLQ named by the registry',
  kafkaService.includes('dlqTopicFor(') && kafkaService.includes('deadLetter('),
);
ok(
  'the DLQ entry carries the original value verbatim, so it can be replayed',
  /value: payload\.message\.value\?\.toString\(\)/.test(kafkaService),
);
ok(
  'the original key is preserved, so a device’s failures stay ordered',
  /payload\.message\.key\?\.toString\(\)/.test(kafkaService),
);
ok(
  'a failed DLQ send logs the raw payload — the last place that can hold it',
  /DLQ send to \$\{dlqTopic\} ALSO failed/.test(kafkaService),
);
ok(
  'the wrapper never rethrows, so a poison message cannot block its partition',
  !/await this\.deadLetter[\s\S]{0,200}throw/.test(kafkaService),
);

// Each consumer must RETHROW for any of the above to run. A handler that
// catches its own errors is invisible to the retry and the DLQ, and this is
// the single easiest thing to regress — the old code did exactly that in all
// five consumers.
for (const { path, src } of consumerSources) {
  const name = path.split('/').pop()!;
  // Comment-stripped: each of these rethrows is preceded by a long note
  // explaining why, which would otherwise push `throw error` outside any
  // sane match window.
  ok(
    `${name} rethrows from its message handler`,
    /catch \(error\)[\s\S]{0,400}throw error;/.test(stripComments(src)),
    'a handler that swallows its errors gets no retry and no DLQ, and the '
      + 'offset advances anyway',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Partition keys where ordering matters
// ═══════════════════════════════════════════════════════════════════════════
section('5. Ordering-sensitive topics are keyed');

ok(
  'telemetry.device.raw is keyed by deviceKey',
  /'telemetry\.device\.raw'[\s\S]{0,900}device\.deviceKey,/.test(
    read('src/modules/protocols/device-listener.service.ts'),
  ),
);
ok(
  'device.commands is keyed by deviceKey at the primary produce',
  /'device\.commands',[\s\S]{0,900}device\.deviceKey,/.test(
    read('src/modules/device-commands/device-commands.service.ts'),
  ),
  'unkeyed, two commands for one device land on different partitions and are '
    + 'applied in no defined order — "open" can win over a later "close"',
);
ok(
  'device.commands.retry is keyed too',
  /'device\.commands\.retry',[\s\S]{0,300}command\.deviceKey,/.test(
    commandsConsumer,
  ),
);
ok(
  'the scheduled-command release is keyed',
  /'device\.commands',[\s\S]{0,300}command\.deviceKey,/.test(commandsConsumer),
);
ok(
  'produces from inside setTimeout have a .catch()',
  (commandsConsumer.match(/setTimeout\(\(\) => \{\s*void this\.kafkaService/g)
    ?? []).length >= 2,
  'sendMessage now throws, and a rejection inside a timer has no caller — it '
    + 'becomes an unhandled rejection',
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. Consumer lag is observable
// ═══════════════════════════════════════════════════════════════════════════
section('6. Consumer lag can be seen');

ok('KafkaService can report per-partition lag', kafkaService.includes('getConsumerLag('));
ok(
  'lag snapshots are cached, so polling /health cannot amplify into load',
  kafkaService.includes('lagCache') && kafkaService.includes('lagCacheSeconds'),
);
ok(
  'a never-committed partition reports lag 0, not the whole log',
  /offset < 0 \? 0 :/.test(kafkaService),
  'otherwise a new group looks catastrophically behind on every empty partition',
);
ok(
  'the health indicator reads lag through KafkaService, not its own client',
  read('src/modules/health/indicators/kafka.health.ts').includes(
    'kafkaService.getConsumerLagSummary',
  ),
);
ok(
  'the indicator no longer builds its own Kafka client per request',
  !read('src/modules/health/indicators/kafka.health.ts').includes('new Kafka('),
  'it used to connect, describeCluster and disconnect on every probe',
);

// ═══════════════════════════════════════════════════════════════════════════
// 7. Redis cannot stop the boot either
// ═══════════════════════════════════════════════════════════════════════════
section('7. Redis: boot, failure mode and namespaces');

ok(
  'RedisService.connect() returns void and cannot be awaited into the boot path',
  /connect\(\):\s*void/.test(redisService),
);
ok(
  'RedisModule’s factory is not async',
  /useFactory:\s*\(configService: ConfigService\):\s*RedisService\s*=>/.test(
    redisModule,
  ),
);
ok(
  'the initial connect failure is caught and explained',
  /this\.client\.connect\(\)\.catch\(/.test(redisService),
);
ok(
  'the fail-closed / fail-open split is written down where connect() is',
  redisService.includes('fails closed') && redisService.includes('fail OPEN'),
  'sessions and the token blacklist live only in Redis, so logins MUST fail '
    + 'closed; caches must fall through to Postgres',
);

// The keyPrefix asymmetry. ioredis does not prefix a KEYS/SCAN pattern but
// does return prefixed keys, so the old keys() both failed to match and
// returned values that del() would prefix a second time.
ok(
  'keys() prefixes the pattern on the way out',
  /this\.client\.keys\(`\$\{prefix\}\$\{pattern\}`\)/.test(redisService),
);
ok(
  'keys() strips the prefix on the way back',
  /found\.map\(\(k\) => \(k\.startsWith\(prefix\)/.test(redisService),
  'without this, del() re-prefixes and deletes smartlife:smartlife:…',
);
ok(
  'scan() does the same',
  /const match = pattern === undefined \? undefined : `\$\{prefix\}\$\{pattern\}`/.test(
    redisService,
  ),
);
ok(
  'invalidateCache() uses SCAN, not KEYS',
  /invalidateCache[\s\S]{0,700}this\.scan\(/.test(redisService) &&
    !/invalidateCache[\s\S]{0,300}await this\.keys\(/.test(redisService),
  'KEYS is O(keyspace) and blocks the single-threaded server for the scan',
);

// Namespaces: three clients, one deployment.
const appModule = read('src/app.module.ts');
ok(
  'Bull has its own logical database',
  /REDIS_QUEUE_DB/.test(appModule),
  'sharing a database means a cache flush drops queued jobs',
);
ok(
  'the cache-manager store has a prefix distinct from RedisService’s',
  /\)\s*\+ 'cache:'/.test(appModule),
  'both were `smartlife:` on db 0, so a cached response body and a live '
    + 'session could occupy the same physical key',
);

// ═══════════════════════════════════════════════════════════════════════════
// 8. Nothing is cached without an invalidation path
// ═══════════════════════════════════════════════════════════════════════════
section('8. Every cache has an invalidation path');

// ── Permissions ───────────────────────────────────────────────────────────
ok('the permission cache exists', permCache.length > 0);
ok(
  'it is keyed on an epoch, so one INCR invalidates a whole tenant',
  permCache.includes('bumpTenant') && permCache.includes('increment('),
  'per-user keys cannot express "this ROLE changed", and finding the holders '
    + 'needs the query the cache exists to avoid',
);
ok(
  'there is a GLOBAL epoch for system roles',
  permCache.includes('bumpGlobal'),
  'a system role (tenantId IS NULL) is held across every tenant, and bumping '
    + 'its own tenant is a bump of null',
);
ok(
  'an unreadable epoch is a MISS, not epoch 0',
  /return '';/.test(permCache) && /if \(!epoch\) return null;/.test(permCache),
  'treating it as 0 lets a Redis blip resurrect entries written before the '
    + 'last bump — the stale-privilege case the epoch exists to prevent',
);
ok(
  'a corrupt entry authorises nothing',
  /if \(!Array\.isArray\(parsed\)\) return null;/.test(permCache),
);
ok(
  'a failed bump is logged at ERROR, not debug',
  /Could not bump the permission epoch[\s\S]{0,200}/.test(permCache) &&
    /logger\.error\([\s\S]{0,120}Could not bump the permission epoch/.test(
      permCache,
    ),
  'unlike a failed read it is not benign — the revocation was reported as done',
);
ok(
  'PermissionGuard reads it before the database',
  /permissionCache\.get\([\s\S]{0,120}resolveAndCache/.test(
    read('src/common/guards/permission.guard.ts'),
  ),
);

// The call sites. This is the list that rots, so it is asserted by name.
const usersService = read('src/modules/users/users.service.ts');
const rolesService = read('src/modules/roles/roles.service.ts');

ok(
  'UsersService injects the permission cache',
  usersService.includes('PermissionCacheService'),
);
for (const [label, re] of [
  ['bulkAssignRole', /users\.role\.bulk\.assigned/],
  ['bulkRemoveRole', /users\.role\.bulk\.removed/],
] as Array<[string, RegExp]>) {
  const idx = usersService.search(re);
  const window = usersService.slice(Math.max(0, idx - 700), idx);
  ok(
    `UsersService.${label} invalidates`,
    window.includes('invalidatePermissionCache'),
  );
}
ok(
  'UsersService.bulkUpdatePermissions invalidates',
  /bulkUpdatePermissions[\s\S]{0,1800}invalidatePermissionCache/.test(
    usersService,
  ),
);
ok(
  'UsersService.update invalidates (it can toggle enforcePermissions)',
  /permissionCache\.bumpTenant\(updatedUser\.tenantId\)/.test(usersService),
);

ok(
  'RolesService injects the permission cache',
  rolesService.includes('PermissionCacheService'),
);
ok(
  'RolesService routes system roles to the global bump',
  /invalidateForRole[\s\S]{0,600}bumpGlobal\(\)/.test(rolesService),
);
const roleInvalidations = (rolesService.match(/invalidateForRole\(/g) ?? [])
  .length;
ok(
  `every RolesService write invalidates (${roleInvalidations} call sites)`,
  roleInvalidations >= 6,
  'create, update, remove, assignPermissions, removePermissions and the '
    + 'tenant-move case — plus the helper’s own declaration',
);
ok(
  'a role moved between tenants invalidates the tenant it LEFT',
  rolesService.includes('previousTenantId'),
  'otherwise that tenant’s users keep a set derived from a role they no '
    + 'longer share',
);

// ── Subscriptions ─────────────────────────────────────────────────────────
ok('the subscription cache exists', subCache.length > 0);
ok(
  'it rehydrates into a real entity',
  /Object\.assign\(new Subscription\(\), parsed\)/.test(subCache),
  'SubscriptionGuard calls subscription.isActive() immediately — a plain '
    + 'object 500s every route on the first cache hit',
);
ok(
  'date columns are converted back to Date',
  subCache.includes('DATE_FIELDS'),
);
ok(
  'quota-enforcing routes BYPASS the cache',
  /SUBSCRIPTION_LIMIT_KEY[\s\S]{0,600}if \(!enforcesQuota\)/.test(
    read('src/common/guards/subscription.guard.ts'),
  ),
  'the row carries live usage counters; serving them from a cache turns a '
    + 'hard quota into "whatever the tenant can create within the TTL"',
);
ok(
  'the bypass reads the handler only, matching SubscriptionLimitGuard',
  /reflector\.get\(\s*\n?\s*SUBSCRIPTION_LIMIT_KEY,\s*\n?\s*context\.getHandler\(\)/.test(
    read('src/common/guards/subscription.guard.ts'),
  ),
  'reading the class too would disable the cache for whole controllers',
);
ok(
  'invalidation is an ORM subscriber, not N remembered call sites',
  subSubscriber.length > 0 && subSubscriber.includes('EntitySubscriberInterface'),
  'SubscriptionsService writes the row from 14 places',
);
ok(
  'the subscriber is registered as a provider',
  read('src/modules/subscriptions/subscriptions.module.ts').includes(
    'SubscriptionCacheSubscriber',
  ),
);
ok(
  'it re-invalidates after COMMIT',
  subSubscriber.includes('afterTransactionCommit'),
  'afterUpdate fires before commit, so a concurrent read can re-cache the '
    + 'old row AFTER the invalidation',
);
ok(
  'it falls back to databaseEntity for the tenant id',
  subSubscriber.includes('databaseEntity?.tenantId'),
  'a partial update leaves entity.tenantId undefined, and invalidating '
    + 'undefined is a silent no-op',
);

// Raw SQL is invisible to the subscriber — these three must invalidate by hand.
const subsService = read('src/modules/subscriptions/subscriptions.service.ts');
for (const method of [
  'incrementTenantUsage',
  'decrementTenantUsage',
  'syncUsageFromDB',
]) {
  const idx = subsService.indexOf(`async ${method}(`);
  const body = idx >= 0 ? subsService.slice(idx, idx + 2600) : '';
  ok(
    `${method} invalidates by hand (it bypasses the ORM)`,
    body.includes('subscriptionCache.invalidate('),
    'raw SQL and QueryBuilder .update() fire no entity events',
  );
}

// ── Latest telemetry ──────────────────────────────────────────────────────
ok('the latest-reading cache exists', latestCache.length > 0);
ok(
  'it has a TTL',
  latestCache.includes('TELEMETRY_LATEST_CACHE_TTL'),
  'the previous hash had none: one key per device, forever, on a Redis shared '
    + 'with Bull',
);
ok(
  'it states what invalidates it',
  latestCache.includes('## Invalidation'),
);
ok(
  'it rehydrates timestamp as a Date',
  /timestamp: new Date\(parsed\.timestamp\)/.test(latestCache),
);
ok(
  'a read failure returns null and falls through to Postgres',
  /catch \(error\)[\s\S]{0,300}return null;/.test(latestCache),
);

// The defect that made the old cache wrong rather than merely useless.
const telemetryService = read('src/modules/telemetry/telemetry.service.ts');
const telemetryConsumer = read('src/modules/telemetry/telemetry.consumer.ts');
ok(
  'BOTH ingest paths write it — HTTP (TelemetryService)',
  telemetryService.includes('latestCache.write('),
);
ok(
  'BOTH ingest paths write it — Kafka (TelemetryConsumer)',
  telemetryConsumer.includes('telemetryCache') &&
    /\.write\(payload\.deviceId, telemetry\)/.test(telemetryConsumer),
  'the old cache was written by the HTTP path only, so for every MQTT, CoAP, '
    + 'Modbus, SNMP and LwM2M device it held nothing or a stale reading',
);
ok(
  'the cached row is the SAVED entity, not the DTO',
  /cacheLatest\(device\.id, saved\)/.test(telemetryService),
  'the DTO has no id, no deviceKey and no server timestamp — a cache hit '
    + 'would return a different shape from a miss',
);
ok(
  'getLatest() reads the cache',
  /latestCache\.read\(device\.id\)/.test(telemetryService),
  'the read was commented out, which is the only reason the write-only cache '
    + 'never surfaced as a bug',
);
ok(
  'the ACCESS CHECK is not cached',
  /resolveDeviceForUser\(deviceId, userId\);\s*\n\s*\n?\s*const cached/.test(
    telemetryService,
  ),
  'a cached authorization decision that outlives an unassignment is a '
    + 'cross-tenant read',
);
// Comment-stripped: the removal is documented in that file, and a guard that
// fails on its own explanation teaches people to delete the explanation.
ok(
  'the removed `telemetry:*:recent` list is gone from the code',
  !stripComments(telemetryService).includes(':recent'),
  'nothing read it, and no 100-item Redis list can serve the time-range, '
    + 'key-filter and tenant-scoped queries the history endpoints run',
);

// ── Device credentials (pre-existing; assert it stays correct) ─────────────
const deviceAuth = read('src/modules/device-auth/device-auth.service.ts');
ok(
  'the device-credential cache has an invalidation method',
  deviceAuth.includes('async invalidate('),
);
ok(
  'it caches negatives too, so bad tokens cannot amplify into queries',
  deviceAuth.includes('NEGATIVE_TTL_SECONDS'),
);
ok(
  'it never caches the secret itself',
  /never the secret itself/.test(deviceAuth),
);

// ── Things deliberately NOT cached ────────────────────────────────────────
section('9. Deliberately not cached');

ok(
  'cad-standards touches no repository, so there is nothing to cache',
  !read('src/modules/cad-standards/cad-standards.service.ts').includes(
    'InjectRepository',
  ),
  'it is a frozen in-process catalogue; a Redis round trip would be slower '
    + 'than the array it already holds',
);

console.log(
  failures === 0
    ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: Kafka and Redis degrade instead of failing the boot, and every cache has an invalidation path\n`
    : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
