# Configuration hardening — change summary

Everything below compiles (`npm run build`) and typechecks (`tsc --noEmit -p
tsconfig.build.json`) with no new errors. `eslint --fix` has been run over the
changed files; the remaining warnings are pre-existing.

Read the "Behaviour changes" section before deploying — three of these will stop
a currently-running deployment from booting until variables are added. That is
intentional, but it should not be a surprise at 2am.

---

## 1. Bugs found, not just cleanup

These were live defects, independent of the hardcoding question.

### `ssl: false` was hardcoded in the DataSource the app actually boots with
`src/database/data-source.ts`

`AppModule` passes `AppDataSource.options` to `TypeOrmModule.forRoot`, so this
file — not `database.config.ts` — decides the runtime connection. `DB_SSL` was
declared in the env, parsed in `database.config.ts`, and never reached the app.
Against a managed Postgres that offers but does not require TLS, the connection
silently downgraded to plaintext, carrying the database password with it.

`DB_POOL_SIZE`, `DB_RETRY_ATTEMPTS` and `DB_RETRY_DELAY` were ignored the same
way.

### CORS was never enabled
`src/main.ts`

`allowedOrigins` was computed from `CORS_ORIGIN`, then `app.enableCors(...)` sat
commented out beneath it. The variable was dead and every cross-origin browser
request failed.

Now applied, with the wildcard/credentials conflict handled: browsers reject
`Access-Control-Allow-Origin: *` on credentialed requests, so sending both looks
configured while silently breaking cookie auth. It warns and drops credentials.

### Kafka multi-broker never worked
`src/lib/kafka/kafka.service.ts`

`brokers: [process.env.KAFKA_BROKERS]` wraps `"a:9092,b:9092"` in a single array
element, so kafkajs treated the whole string as one hostname. Only single-broker
setups ever connected. Now split on commas via `envList`.

Topic replication factor was pinned at `1` — no replicas, partition loss if that
broker dies. Now `KAFKA_TOPIC_REPLICATION_FACTOR`.

### Two different .env files could load simultaneously
`src/database/data-source.ts` loaded `.env.${NODE_ENV}`; `AppModule` loaded
`.env`. In production those are different files, so TypeORM and ConfigService
could read different values for the same key. Both now use
`src/config/load-env.ts`.

### `migrationDataSource` fell back to `postgres` / `123456` / `postgres`
`src/config/migration.config.ts`

If the env was not loaded, `migration:run` would connect to a *different*
database, report success, and leave the real schema untouched. All fields are
now required.

### JWT expiry variable name mismatch
`src/common/guards/guards.module.ts`

Read `JWT_EXPIRES_IN` — a name used nowhere else and absent from the env file —
so this module always fell back to `15m` while `AlarmsModule` and
`WebsocketModule` read `JWT_EXPIRATION` and used `7d`. Token lifetime depended on
which module happened to sign. Now reads `JWT_EXPIRATION`, with `JWT_EXPIRES_IN`
kept as a fallback so no environment changes behaviour on upgrade.

### Floor plan uploads written to the wrong directory
`src/modules/floor-plans/floor-plans.service.ts`

`process.env.UPLOAD_PATH || './uploads/floor-plans'` — the fallback included the
`/floor-plans` segment but the configured value did not. With `UPLOAD_PATH=./uploads`
(what the env example sets), floor plans went straight into `./uploads/` and
their `dwg/` and `models/` subdirectories landed beside every other module's
uploads. This matches the stray `uploads/dwg` and `uploads/models` directories
in the repo. The segment is now always appended.

### Device API key check was fail-open and timing-leaky
`src/modules/protocols/adapters/http.adapter.ts`

If `REQUIRE_API_KEY=true` but `DEVICE_API_KEY` was unset, both sides of the
comparison were `undefined` and every request with no key passed. Missing config
now denies.

`apiKey !== process.env.DEVICE_API_KEY` also compares with early exit, leaking
via response time how many leading characters matched — a practical attack
against an unauthenticated ingestion endpoint. Now `crypto.timingSafeEqual`.

### WebSocket JWT verification could skip verification
`src/common/guards/ws-jwt.guard.ts`

Read `process.env.JWT_SECRET` directly, bypassing the namespace that enforces
presence. `jsonwebtoken` treats an undefined secret as grounds to skip
verification, so an unauthenticated socket would have been accepted as
authenticated. Now reads through `ConfigService` and throws if unset.

### The two WebSocket gateways disagreed about CORS
`WebsocketGateway` read `FRONTEND_URL`; `AlarmsGateway` read `CORS_ORIGIN`. A
deployment setting only one ended up with one socket endpoint locked down and
the other open to `*`. Neither split on commas, so multi-origin values matched
nothing. Both now use `src/common/utils/websocket-cors.ts`.

### Password re-hashing lockout
`src/modules/users/entities/user.entity.ts`

The `@BeforeInsert`/`@BeforeUpdate` hook guarded on `startsWith('$2b$')` only.
A hash imported from another bcrypt implementation (`$2a$`, `$2y$` prefixes)
would be hashed *again* — permanently locking that account out. Guard is now
`/^\$2[aby]\$/`.

### The seeder printed credentials to stdout
`src/database/seeds/user/user.seeder.ts`

It logged `Super Admin: Admin@123` in full, putting the platform super-admin
credential into the container log driver and any log aggregator downstream. Now
prints the variable names only.

### `ENABLE_SWAGGER` was never checked
The full API surface, including every DTO shape, was published on `/docs` in
production. Now gated, defaulting to off when `NODE_ENV=production`.

---

## 2. Hardcoded values moved to the environment

| Was | File | Now |
|---|---|---|
| `smartlife` / `smartlife123` / `smartlife_iot` DB fallbacks | `database.config.ts` | required, no fallback |
| `postgres` / `123456` DB fallbacks | `migration.config.ts` | required, no fallback |
| `ttl: 60000, limit: 100` | `app.module.ts` | `THROTTLE_TTL` / `THROTTLE_LIMIT` |
| `ttl: 60 * 60 * 1000` cache | `app.module.ts` | `REDIS_TTL` |
| `'smartlife-iot-platform'` Kafka client id, timeouts, retries | `kafka.service.ts` | `kafka` namespace |
| Frozen MQTT topic array, `qos: 1`, `reconnectPeriod: 5000` | `mqtt.service.ts` | `mqtt` namespace |
| Redis key prefix, timeouts, ready check, offline queue | `redis.service.ts` | `redis` namespace |
| `https://api.moyasar.com/v1` | `payments.service.ts` | `MOYASAR_API_URL` |
| `'SAR'` × 4 | `payments.service.ts` | `PAYMENT_CURRENCY` |
| `https://dev.smart-life.sa/assets/...png` | `payments.service.ts` | `PAYMENT_LOGO_URL` |
| `https://api.smart-life.sa` edge fallbacks | `edge.service.ts` | `EDGE_CLOUD_URL` / `EDGE_MQTT_URL` |
| `http://localhost:5000` OTA URL | `firmware.service.ts` | `OTA_PUBLIC_URL` |
| `http://localhost:3000` in emails × 5 | `mail.service.ts`, `users.service.ts` | `FRONTEND_URL`, required |
| `bcrypt` cost `10` × 8 | `password.util.ts` | `BCRYPT_SALT_ROUNDS` (default 12) |
| `Admin@123` / `TenantAdmin@123` / `User@123` × 21 | `user.seeder.ts` | `SEED_*_PASSWORD`, required |
| SMTP connect/greeting timeouts | `mail.service.ts` | `SMTP_*_TIMEOUT` |
| `'localhost'` CoAP device fallback | `coap.adapter.ts` | `COAP_DEFAULT_DEVICE_HOST` |
| `https://docs.smartlife.sa/...` | `device-credentials.service.ts` | `DOCS_BASE_URL` |

---

## 3. New files

- **`src/config/load-env.ts`** — one deterministic env load. Gateway decorators
  and `AppDataSource` read `process.env` at *import* time, before `ConfigModule`
  initialises; the old code got this right only because `data-source.ts` happened
  to call dotenv as a side effect first. That was load-order luck.
- **`src/config/env.utils.ts`** — shared coercion. The repo used both
  `=== 'true'` and `!== 'false'`, so an unset variable defaulted *on* in some
  places and *off* in others.
- **`src/config/env.validation.ts`** — fail-fast validation, dependency-free
  (you have no Joi or zod; adding one means every deploy target reinstalls
  before it can boot). Reports every problem at once.
- **`src/config/kafka.config.ts`** — Kafka had no config namespace at all.
- **`src/common/utils/password.util.ts`** — bcrypt cost, clamped 10–15. Above 15,
  hashing takes seconds and login becomes a DoS vector against your own API.
- **`src/common/utils/websocket-cors.ts`** — shared gateway CORS resolution.

Validation rejects, in production: the placeholder secrets shipped in the example
file, `JWT_SECRET === JWT_REFRESH_SECRET` (lets an access token be replayed as a
refresh token), `DB_SYNCHRONIZE=true`, and `CORS_ORIGIN=*`.

---

## 4. `.env.production.example`

Forty variables used in code were missing from it, so a deploy made from that
file came up half-configured. The most consequential:

- **`MOYASAR_WEBHOOK_SECRET`** — absent, so webhook signature verification was
  silently disabled on every deploy made from this file. Anyone who found the
  webhook URL could forge a payment-succeeded event.
- `SYSTEM_TENANT_ID` / `SYSTEM_USER_ID` — auto-registration throws without them
- `DEVICE_API_KEY` / `REQUIRE_API_KEY` — ingestion auth
- `DB_RUN_MIGRATIONS`, `OTA_PUBLIC_URL`, `ODA_CONVERTER_PATH`
- All Firebase and APNS push credentials
- All Zigbee and Modbus adapter settings

Duplicate keys were also removed. `APP_NAME`, `CORS_ORIGIN` and `FRONTEND_URL`
were each defined twice; dotenv keeps the first, so the second `CORS_ORIGIN=*`
silently overrode the restrictive value above it.

Every variable is now marked `[required]`, `[required:prod]` or `[optional]`.

---

## 5. Behaviour changes — read before deploying

**Three things will now refuse to boot** where they previously started in a
broken state. This is the point, but plan for it:

1. **Missing DB or Redis connection variables** — previously fell back to
   `localhost` / `smartlife123`. Now named at boot.
2. **`FRONTEND_URL` unset** — `PaymentsService` and `MailService` now throw at
   construction. Previously they sent customers dead links.
3. **`npm run seed`** requires `SEED_ADMIN_PASSWORD`,
   `SEED_TENANT_ADMIN_PASSWORD`, `SEED_USER_PASSWORD` (min 12 chars each).

**One default flipped:** `ENABLE_SWAGGER` now defaults to off in production. Set
it explicitly to `true` if you rely on `/docs` there.

**One thing deliberately left alone.** `API_PREFIX` is read by `app.config.ts`
but `setGlobalPrefix` was never called, so routes serve from the root. Your
Postman collection agrees (`{{base_url}}/auth/login`); the OAuth callback URLs in
the env example do not (`/api/auth/google/callback`). The likely explanation is a
proxy stripping `/api`. Enabling it would break every existing client and every
saved OAuth redirect URI, so it is behind `API_PREFIX_ENABLED`, defaulting to
**off** — current behaviour. **Confirm which is true in production before
changing it.**

**Also worth knowing:** MQTT client IDs now get `-{pid}-{timestamp}` appended.
A fixed client ID across replicas is a footgun — MQTT requires uniqueness, and a
broker disconnects the existing session when a second client claims the same ID,
so two replicas kick each other off in a loop. Bull queues also moved to
`REDIS_QUEUE_DB=1` so a cache flush no longer drops queued jobs; drain the queue
before deploying if you have jobs pending on db 0.

---

## 6. Not done

Left for a follow-up, all lower risk and none of it blocking:

- ~28 `process.env` reads remain in modules — mostly the BLE, Zigbee and Modbus
  adapters, which are feature-flagged off by default. Same treatment applies.
- `analytics.service.ts` still derives its upload path independently.
- Seed data still contains placeholder integration secrets
  (`your-webhook-secret`, `your-tuya-client-secret`). Harmless as seeds, but
  worth confirming they are not being seeded into production.
- `assignment-safety-triggers.sql`, `__pycache__/`, `backup/`, `backups/` and
  `logs/` are committed to the repo. `__pycache__` and `logs` in particular
  should be in `.gitignore`.
