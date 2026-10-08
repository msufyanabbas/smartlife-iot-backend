# CLAUDE.md — Smart Life IoT Platform Backend

## 1. Project Overview

**Smart Life IoT Platform** is a production-grade, multi-tenant IoT backend built with NestJS. It manages IoT devices, collects time-series telemetry from multiple protocols, enforces multi-tier access control, runs event-driven automations and alarms, and provides dashboards, floor plans, and analytics to end customers.

**High-level architecture:**

```
[MQTT / HTTP / CoAP / Modbus / BLE / Zigbee] 
         ↓ protocol adapters
   DeviceListenerService
         ↓ codec decode
   KafkaService (topic: telemetry.device.raw)
         ↓ consumer
   TelemetryConsumer → persist to Postgres + WebSocket broadcast + alarm check + automation trigger
```

The application is a single NestJS monolith running on port 5000. External services (Postgres, Redis, Kafka, EMQX) are containerised. Multi-tenancy is enforced at the guard layer; every piece of data is scoped to a `tenantId`.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 25, TypeScript 5.9 (ES2023 target, nodenext modules) |
| Builder | SWC (`@swc/core`) — replaces webpack; ~5–10s cold start vs ~74s with webpack |
| Framework | NestJS 11 |
| Database | PostgreSQL 15 via TypeORM 0.3.27 |
| Cache / Sessions | Redis 7 via `cache-manager-redis-yet` + `ioredis` |
| Message queue | Apache Kafka via `kafkajs` (Confluent Platform 7.5) |
| MQTT broker | EMQX 5.3 (external); client via `mqtt` v5 |
| WebSockets | Socket.IO 4 via `@nestjs/platform-socket.io` |
| Auth | Passport.js (`passport-jwt`, `passport-local`, `passport-google-oauth20`, `passport-github2`, `passport-apple`) |
| JWT | `@nestjs/jwt` |
| 2FA | `speakeasy` (TOTP), `qrcode` (QR generation) |
| Background jobs | Bull queues via `@nestjs/bull` + Redis |
| Scheduling | `@nestjs/schedule` (cron) |
| Payments | Moyasar (primary, via `axios`) + Stripe (dependency present) |
| Email | `nodemailer` via custom `MailService` |
| Logging | `winston` + `nest-winston` |
| Monitoring | `prom-client` + `@willsoto/nestjs-prometheus`; Prometheus + Grafana in Docker |
| HTTP client | `@nestjs/axios` + `axios` |
| Validation | `class-validator` + `class-transformer` |
| Swagger | `@nestjs/swagger` |
| Rate limiting | `@nestjs/throttler` |
| IoT protocols | `coap` (CoAP), `modbus-serial` (Modbus), `mqtt` (MQTT/LoRaWAN) |
| Floor plans | `dxf-parser`, `libredwg` (compiled from source in Docker) |
| PDF | `pdfkit` |
| Canvas | `canvas` (native; requires system libs) |
| Phone validation | `libphonenumber-js` |
| Crypto | Node.js built-in `crypto` |

---

## 3. Repository Structure

```
iot-platform-backend/
├── src/
│   ├── app.module.ts              # Root module — wires everything
│   ├── app.controller.ts          # GET / (health) and GET /ping
│   ├── app.service.ts             # Stub (unused)
│   ├── main.ts                    # Bootstrap: Swagger, CORS, compression, ValidationPipe
│   ├── common/
│   │   ├── decorators/            # @Public, @Roles, @CurrentUser, @RequirePermissions, @SubscriptionPlan, @Notify, @Audit
│   │   ├── dto/                   # BaseResponseDto<T>, ErrorResponseDto, PaginationDto, PaginatedResponseDto
│   │   ├── entities/              # BaseEntity (abstract base for all TypeORM entities)
│   │   ├── enums/                 # All application enums (barrel-exported via index.enum.ts)
│   │   ├── filters/               # HttpExceptionFilter (all-exceptions + http-exception)
│   │   ├── guards/                # 8 guards + guards.module.ts
│   │   ├── interceptors/          # Logging, Metrics, Audit, Notification, UsageTracking, Transform + interceptor.module.ts
│   │   ├── interfaces/            # StandardTelemetry, SubscriptionFeatures/Limits/Usage, AlarmRule, JwtPayload, etc.
│   │   ├── middleware/            # RequestIdMiddleware (injects x-request-id)
│   │   ├── pipes/                 # ValidationPipe, ParseIdPipe
│   │   ├── transformers/          # PhoneTransformer
│   │   └── utils/                 # helpers.ts, validators.ts
│   ├── config/
│   │   ├── index.ts               # Exports configModules array
│   │   ├── app.config.ts          # registerAs('app', …)
│   │   ├── database.config.ts     # registerAs('database', …)
│   │   ├── jwt.config.ts          # registerAs('jwt', …)
│   │   ├── redis.config.ts        # registerAs('redis', …)
│   │   ├── mqtt.config.ts         # registerAs('mqtt', …)
│   │   └── migration.config.ts    # TypeORM DataSource for migrations
│   ├── database/
│   │   ├── data-source.ts         # AppDataSource (used by TypeORM CLI)
│   │   ├── migrations/            # (empty — no migrations generated yet)
│   │   └── seeds/                 # Per-entity seeders + DatabaseSeederService + seed.command.ts
│   ├── lib/
│   │   ├── kafka/                 # KafkaService (producer + consumer group management)
│   │   ├── mqtt/                  # MQTTService (single MQTT client; handles uplinks + publish)
│   │   └── redis/                 # RedisService (get/set/del/expire)
│   ├── migrations/                # (separate from database/migrations; currently empty)
│   └── modules/
│       ├── index.entities.ts      # Barrel export for all TypeORM entities
│       ├── index.module.ts        # Barrel export for all modules + featureModules array
│       ├── index.service.ts       # Barrel export for all services
│       ├── alarms/                # Alarm rules, triggers, WebSocket alerts, Kafka consumer
│       ├── analytics/             # Aggregated metrics, dashboard view logs, data consumption
│       ├── api-monitoring/        # API log entity, request/response monitoring
│       ├── assets/                # Physical assets (buildings, rooms, equipment)
│       ├── assignments/           # Resource assignment junction tables (customer↔device, user↔device, etc.)
│       ├── attributes/            # Key-value device/asset attributes + timeseries stub
│       ├── audit/                 # Audit log entity + AuditInterceptor
│       ├── auth/                  # Login, register, OAuth, 2FA, invitations, sessions, password reset
│       ├── automation/            # Rule-based automations (trigger → condition → action)
│       ├── customers/             # Customer orgs (sub-tenants) with quota allocation
│       ├── customer-users/        # Users scoped to a customer
│       ├── dashboards/            # Configurable dashboards
│       ├── device-commands/       # Downlink command queue
│       ├── devices/               # Device registry, credentials, codecs
│       │   └── codecs/            # 80+ Milesight device codecs + generic MQTT-JSON codec
│       ├── edge/                  # Edge instance management + command dispatch + metrics snapshots
│       ├── email-templates/       # Customisable email templates with {{variable}} substitution
│       ├── floor-plans/           # Floor plan upload (DXF/SVG), device placement
│       ├── gateway/               # HTTP gateway for device telemetry ingestion
│       ├── health/                # @nestjs/terminus health endpoints
│       ├── images/                # Image entity (storage TODO: S3/local)
│       ├── integrations/          # Third-party integration configs (Slack, webhooks, etc.)
│       ├── mail/                  # MailService wrapping nodemailer
│       ├── metrics/               # Prometheus metrics module
│       ├── nodes/                 # Rule chain node execution (filter, enrichment, action)
│       ├── notifications/         # Multi-channel notifications (email, push, in-app, SMS)
│       ├── payments/              # Moyasar payment processing + subscription upgrades
│       ├── permissions/           # Permission entity (resource:action strings)
│       ├── profiles/              # DeviceProfile, AssetProfile
│       ├── protocols/             # DeviceListenerService + HTTP/CoAP/Modbus/BLE/Zigbee adapters
│       ├── roles/                 # Role entity (RBAC roles with permissions)
│       ├── rules/                 # RuleChain, RuleNode, RuleEngine
│       ├── schedules/             # Cron-based scheduled actions
│       ├── scripts/               # User-defined scripts (JS execution context)
│       ├── sharing/               # Public/private resource sharing with tokens
│       ├── solution-templates/    # Pre-built IoT solution templates
│       ├── subscriptions/         # Subscription plans, limits, usage counters
│       ├── telemetry/             # Time-series telemetry storage, queries, WebSocket push
│       ├── tenants/               # Tenant (org) management
│       ├── two-factor/            # TOTP/SMS/email 2FA setup and verification
│       ├── user-settings/         # Per-user preferences store
│       ├── users/                 # User entity + CRUD
│       ├── websocket/             # Socket.IO WebSocket gateway (namespace: /ws)
│       └── widgets/               # Widget bundles and widget types for dashboards
├── monitoring/
│   ├── prometheus.yml             # Prometheus scrape config
│   └── alerts.yml                 # Alert rules
├── scripts/
│   ├── backup.sh                  # Postgres backup script
│   └── restore.sh                 # Postgres restore script
├── .env                           # Local env (not committed)
├── .env.development               # Dev env overrides
├── .env.production.example        # Production env template
├── docker-compose.prod.yml        # Production stack
├── docker-compose.local.yml       # Local development stack
├── Dockerfile                     # Multi-stage production image
├── Dockerfile.dev                 # Development image
├── nest-cli.json                  # NestJS CLI config
├── tsconfig.json                  # TypeScript config with path aliases
├── jest.config.js                 # Jest config
└── .github/workflows/
    ├── deploy-production.yml      # Main CI/CD pipeline
    └── manual-deploy.yml          # Manual trigger deploy
```

---

## 4. Module Inventory

### Infrastructure / Shared
| Module | Responsibility |
|---|---|
| `GuardsModule` | Registers all 8 global `APP_GUARD` providers in execution order |
| `InterceptorsModule` | Registers all global `APP_INTERCEPTOR` providers |
| `KafkaModule` / `KafkaService` | Single Kafka producer + consumer group factory |
| `MQTTModule` / `MQTTService` | Single MQTT client; subscribes to uplink topics, calls `DeviceListenerService`, exposes `publish()` |
| `RedisModule` / `RedisService` | Thin wrapper over ioredis for get/set/del/expire |
| `MetricsModule` | Prometheus metrics endpoint (`/metrics`) via `prom-client` |
| `HealthModule` | `@nestjs/terminus` health checks at `/health` |
| `SeederModule` | Provides `DatabaseSeederService` for `npm run seed` |

### Core Auth & Users
| Module | Responsibility |
|---|---|
| `AuthModule` | Local login, OAuth (Google/GitHub/Apple), 2FA challenge, token refresh, logout, email verification, password reset, invitations |
| `UsersModule` | User CRUD, role/permission queries |
| `TenantsModule` | Tenant CRUD (org management) |
| `CustomersModule` | Customer (sub-tenant) management with quota allocation and permission grants |
| `CustomerUsersModule` | Customer-scoped user management |
| `ProfilesModule` | DeviceProfile and AssetProfile management |
| `RolesModule` | Custom role management (RBAC) |
| `PermissionsModule` | Permission string management (`resource:action`) |
| `TwoFactorAuthModule` | TOTP setup (speakeasy), QR generation, code verification, SMS/email 2FA |
| `UserSettingsModule` | Per-user key-value preferences |

### IoT Core
| Module | Responsibility |
|---|---|
| `DevicesModule` | Device registry, CRUD, credentials management |
| `CodecModule` + `CodecRegistryService` | 80+ Milesight device codecs + generic JSON codec; auto-detect by manufacturer/model/devEUI/fPort |
| `TelemetryModule` | Time-series storage (PostgreSQL), queries, batch ingest, latest-value Redis cache, Kafka consumer |
| `ProtocolsModule` | `DeviceListenerService` (unified entry point) + HTTP/CoAP/Modbus/BLE/Zigbee adapters |
| `GatewayModule` | HTTP gateway controller for device telemetry `POST /gateway/telemetry` |
| `DeviceCommandsModule` | Downlink command queue (send commands to devices via MQTT) |
| `AssetsModule` | Physical asset hierarchy (buildings, floors, rooms) |
| `AttributesModule` | Device/asset key-value attributes with scope and data type |
| `NodesModule` | Rule chain node execution (filter, enrichment, action, transformer) |
| `EdgeModule` | Edge instance lifecycle, heartbeat, command dispatch, metrics snapshots |

### Communication
| Module | Responsibility |
|---|---|
| `WebsocketModule` | Socket.IO gateway at `/ws`; room-based subscriptions for devices, dashboards, alarms |
| `MailModule` | `nodemailer` wrapper; sends verification, welcome, invitation, password reset emails |
| `NotificationsModule` | Multi-channel notifications (in-app, email, push, SMS — SMS is a stub) |
| `EmailTemplatesModule` | Custom email templates with `{{variable}}` substitution and validation |

### Visualisation
| Module | Responsibility |
|---|---|
| `DashboardsModule` | Dashboard CRUD with widget layout config |
| `WidgetsModule` | Widget bundles and widget type definitions |
| `FloorPlansModule` | Floor plan upload (DXF parsed by libredwg/dxf-parser), device placement on map |

### Monitoring & Analytics
| Module | Responsibility |
|---|---|
| `AlarmsModule` | Alarm rule definitions, trigger evaluation (via `TelemetryConsumer`), active alarm tracking, WebSocket broadcast |
| `AnalyticsModule` | Aggregated device/telemetry analytics, dashboard view logging, energy/geo analytics |
| `AuditModule` | Audit log storage; `AuditInterceptor` captures create/update/delete operations |
| `ApiMonitoringModule` | API request/response logging; `LoggingInterceptor` writes to `api_logs` table |

### Automation & Integration
| Module | Responsibility |
|---|---|
| `AutomationModule` | Trigger → conditions → actions automations. Six trigger types (TELEMETRY, ATTRIBUTE, ALARM, DEVICE_STATUS, SCHEDULE, MANUAL) and eight action types; `AutomationConsumer` (Kafka `telemetry.device.validated`), `AutomationListener` (`alarm.*` / `device.*` / `attributes.updated` events) and `AutomationScheduler` (per-minute cron) feed it. Every run writes an `automation_logs` row |
| `SchedulesModule` | Cron-expression-based schedules for automations |
| `ScriptsModule` | User-defined JavaScript scripts with execution context |
| `IntegrationsModule` | The Integration Centre: 18 types driven by a declarative catalogue, outbound adapters (MQTT, Kafka, AWS IoT, Azure IoT/Event Hubs, Google Pub/Sub, IBM Watson, CoAP, webhook), inbound uplinks (ChirpStack, TTN, generic HTTP, persistent MQTT subscriptions), Tuya device import and commands, and an append-only event log. See §4e |
| `RulesModule` | Visual rule chain nodes and connections (rule engine service) |

### Subscription & Payments
| Module | Responsibility |
|---|---|
| `SubscriptionsModule` | Subscription plan management; usage counter denormalisation; plan limits and feature flags |
| `PaymentsModule` | Moyasar payment processing, webhook verification, subscription upgrades, invoice PDF generation |

### Resources
| Module | Responsibility |
|---|---|
| `ImagesModule` | Image metadata entity (actual file storage is a TODO) |
| `SolutionTemplatesModule` | Pre-built IoT solution templates for quick deployment |
| `SharingModule` | Token-based public/private resource sharing |

---

## 4a. Asset Profile → Asset → Floor Plan → Device Chain

The spatial model is a single chain. Each link constrains the next.

```
AssetProfile  (type + schema)          "a Building has totalFloors and floorsData"
     ↓ assetProfileId
Asset         (configuration)          "this building has 3 floors: 1,2,3"
     ↓ assetId  +  floorNumber
FloorPlan     (one per floor)          "floor 2's DXF, geometry and zones"
     ↓ floorPlanId  +  deviceId
FloorPlanDevice (x/y/z placement)      "the CO2 sensor sits at (12, 4, 2.5) on floor 2"
                ↑ device.assetId MUST equal floorPlan.assetId
```

### AssetProfile defines the type and the schema
- `type` (varchar): `building | shop | farm | warehouse | hospital | hotel | factory | custom`
  (`AssetProfileType`). Varchar rather than a PG enum so new types need no DB migration.
- `schema` (jsonb): `{ fields: ProfileField[] }` where a field is
  `{ key, label, type, required, options?, min?, max?, defaultValue? }` and type is
  `text | number | boolean | select | floors_array` (`ProfileFieldType`).
- A `floors_array` field is what makes a profile **multi-floor** — building, hospital
  and hotel declare one (`floorsData`); shop, farm, warehouse and factory do not.
- Seeded by `src/database/seeds/asset-profile/asset-profile.seeder.ts` — 8 profiles per
  tenant, `Custom` being the tenant default. (The older 5-profile seeder in
  `seeds/asset-profiles/` is superseded and no longer registered in `index.seeder.ts`.)
- The legacy `attributesSchema` (required/optional split) still exists on the entity for
  backwards compatibility; `schema` is the one the new flow uses.

### Asset stores the values
- `configuration` (jsonb, default `{}`): values keyed by `ProfileField.key`.
- `configuration.totalFloors` and `configuration.floorsData: FloorConfig[]`
  (`{ floorNumber, name?, rooms?, area? }`) drive everything floor-related.
- `AssetsService.findOne()` always joins `assetProfile`, so the schema travels with the
  asset and the frontend can render `configuration` as a form.
- Still distinct from `attributes` (free-form/legacy) and `additionalInfo` (off-schema).

### FloorPlan is per floor
- `floorNumber` (int, default 1) + `floorName` (varchar) + **`UNIQUE (assetId, floorNumber)`**
  (`UQ_floor_plans_asset_floor`) — one plan per floor per asset.
- `floorNumber` is **required** when the asset is multi-floor (`totalFloors > 1`) and must
  match a floor declared in `floorsData`; single-floor assets default to 1.
- Postgres treats NULLs as distinct, so legacy rows with a NULL `floorNumber` do not
  collide. Soft-deleted rows **do** still occupy their slot — `deleted_at` is not part of
  the constraint, so re-creating a deleted floor needs a hard delete first.

### Device placement is filtered by asset
- `POST /floor-plans/:id/devices` **rejects with 400** unless
  `device.assetId === floorPlan.assetId`. (This was previously a soft warning that placed
  the device anyway.)
- `GET /floor-plans/:id/available-devices` is the picker: every device on the plan's asset,
  minus those already placed on *this* plan; devices placed on another floor of the same
  asset come back with `isAvailable: false` and `placedOnFloor` set.
- Link a device to an asset with `POST /assets/:id/devices` first.

### Key endpoints
| Endpoint | Purpose |
|---|---|
| `GET /assets/:id/floors` | **Entry point.** Merges `configuration.floorsData` (or 1..totalFloors) with existing plans → per floor: `hasFloorPlan`, `floorPlanId`, `hasDxf`, `deviceCount`, `rooms`, `area`. Plans not matching a configured floor come back with `inConfiguration: false`. |
| `GET /floor-plans/asset/:assetId` | All plans of an asset ordered by `floorNumber`, each with `deviceCount`, `hasDxf` and a `geometrySummary` (room/wall/door/window counts, total area). |
| `GET /floor-plans/:id/available-devices` | Device picker (see above). |
| `GET /floor-plans/asset/:assetId/3d-simulation` | Whole-building 3D payload, all floors. |

### Subscription limits
`SubscriptionLimits.maxFloorPlans` and `maxDevicesPerFloorPlan` (-1 = unlimited), enforced
in `FloorPlansService` (`create` and `placeDevice`), not by a guard decorator:

| Plan | maxFloorPlans | maxDevicesPerFloorPlan |
|---|---|---|
| FREE | 1 | 5 |
| STARTER | 5 | 20 |
| PROFESSIONAL | 25 | 100 |
| ENTERPRISE | -1 | -1 |

Checks are skipped for `SUPER_ADMIN`, for tenants with no subscription row, and for limits
the plan does not define — so adding a limit key never retroactively locks out a tenant.
Repositories (`Subscription`, `FloorPlan`, `FloorPlanDevice`) are registered directly via
`TypeOrmModule.forFeature` rather than importing each other's modules, to avoid cycles.

---

## 4b. Device Profile → Device → Alarm Chain

Device profiles carry transport settings, provisioning strategy and **alarm rule
templates** that apply to every device using the profile.

```
DeviceProfile (transportType + transportConfiguration + alarmRules)
     ↓ deviceProfileId  (CreateDeviceDto, validated against the caller's tenant)
Device
     ↓ ProfileAlarmService
Alarm   (one row per enabled rule, keyed on metadata.profileRuleId)
```

### Transport & provisioning
- `transportType`: `DEFAULT | MQTT | COAP | HTTP | LWM2M | SNMP` — **varchar, not a
  PG enum**, UPPERCASE (ThingsBoard contract). `SNMP` is retained beyond the
  ThingsBoard set because a seeded profile uses it.
- `transportConfiguration` (jsonb): per-protocol settings (`mqtt`, `http`, `coap`,
  `lwm2m`). `DeviceProfilesService.getDefaultTransportConfig()` fills in ThingsBoard
  defaults on create when the caller supplies none — an explicit `{}` is respected.
- `provisionType`: `DISABLED | ALLOW_CREATE_NEW_DEVICES | CHECK_PRE_PROVISIONED_DEVICES`
  plus flat `provisionDeviceKey` / `provisionDeviceSecret`. The legacy
  `provisionConfiguration` jsonb is **deprecated but retained** (the migration
  backfills the flat columns from it). *Provisioning itself is still not implemented —
  no code reads these yet.*
- `queueName` (was `defaultQueueName`) and `firmwareConfig` (was
  `firmwareConfiguration`) — renamed, not recreated, so seeded values survive.

### Alarm rules (`DeviceProfile.alarmRules`)
Shape: `DeviceProfileAlarmRule` in `src/common/interfaces/device-profile.interface.ts`.
Each rule has `condition.condition[]` filters (AND semantics), an optional `clearRule`,
a severity drawn from `AlarmSeverity` (`critical|error|warning|info`), and propagation
flags.

`ProfileAlarmService` (`src/modules/profiles/profile-alarm.service.ts`) is the engine:

| When | What happens |
|---|---|
| `POST /devices` with a `deviceProfileId` | `materialiseProfileAlarms()` writes one **INACTIVE** Alarm row per enabled rule, so the device's alarm list shows what is being watched before anything fires. Non-fatal on error. |
| Telemetry arrives (`TelemetryConsumer` step 2b) | `evaluateProfileAlarmRules()` tests each rule; a match triggers the existing row (ACTIVE, `triggerCount++`), a matching `clearRule` returns it to CLEARED. |

Key details:
- Rows are located by **`metadata.profileRuleId`**, never by `name` — the rule engine's
  action node (`src/modules/nodes/action-node.ts`) also creates alarms and can collide
  on name.
- Telemetry is normalised before evaluation: the ThingsBoard envelope
  `{ts, values:{temperature:45}}` is hoisted so rules can name the bare key
  `temperature`. Dotted paths (`values.temperature`) also resolve.
- `Alarm.rule` is NOT NULL, so the first filter is collapsed into the flat `AlarmRule`
  shape; the full rule lives in `metadata.profileRule`.
- **Not implemented:** `spec.type` `DURATION`/`REPEATING` are evaluated as `SIMPLE`
  (logged as a warning); `predicate.value.dynamicValue` causes the rule to be skipped;
  propagation flags are recorded but nothing acts on them.

## 4c. Asset Profile Schema Validation (bilingual)

`AssetProfile.schema` is `{ fields: ProfileField[], deviceLinkingConfig? }`.

- Every field carries **both** `label` (English) and `labelAr` (Arabic) — likewise every
  `select`/`multiselect` option is `{value, label, labelAr}`.
  **BREAKING:** `options` was previously `string[]`.
- `group` / `order` drive form layout; `unit`, `placeholder(Ar)`, `helpText(Ar)` are
  presentation hints.
- Field types: `text | number | boolean | select | multiselect | date | floors_array |
  devices_array`. `floors_array` still drives the floor-plan chain (see §4a).
- `AssetsService.create()` and `update()` now **reject** an asset whose `configuration`
  fails the profile schema (`validateAssetConfiguration()` → 400 with bilingual text).
  An unknown/foreign `assetProfileId` is also a 400.
- `deviceLinkingConfig` (`allowMultipleDevices`, `deviceTypeFilter`, `maxDevices`) is
  enforced in `assignDevice()` and `bulkAssignDevices()`.

Note: the older `AssetProfilesService.validateAssetData()` validates the **legacy**
`attributesSchema`/`Asset.attributes` pair and is only reachable via
`POST /profiles/asset/:id/validate`. It is not the create-time path.

## 4d. Tuya Auto-Provisioning

A Tuya integration mirrors a Tuya cloud project into the platform: its devices
become `Device` rows and their datapoints become `Telemetry`. Owned by
`TuyaSyncService` (`src/modules/integrations/tuya-sync.service.ts`) — the
runtime half of the module, alongside `IntegrationDispatchService`.
`IntegrationsService` stays CRUD and delegates.

```
Integration (type=tuya | legacy cloud + clientId/clientSecret, status=active)
     ↓ TuyaAdapter.getDevices()
Device      (protocol=tuya, externalId=<tuyaDeviceId>, deviceKey=tuya_<tuyaDeviceId>)
     ↓
DeviceCredentials (credentialsType=TUYA, credentialsValue=<local_key>)
     ↓
Telemetry   (data = merged snapshot of the device's Tuya datapoints)
     ↓
WebSocket   device:telemetry + telemetry:update  →  room device:<deviceId>
```

### Tuya has no webhook — how events actually reach us

Tuya's message service is **Pulsar-only** (`pulsar+ssl://mqe.tuyaeu.com:7285`).
There is no HTTP callback, and there is **no account-wide message-poll REST
endpoint** either. `GET /v1.0/iot-03/messages` — which looks like the obvious
answer — does not exist:

```
GET /v1.0/iot-03/messages          → {"code":1108,"msg":"uri path invalid"}
GET /v1.0/iot-03/nonexistent-xyz   → {"code":1108,"msg":"uri path invalid"}   # a made-up path
GET /v1.0/token                    → {"code":2009,"msg":"clientId is invalid"} # real route, auth rejected
```

A real-but-unauthenticated route answers **2009**; an unrouted path answers
**1108**. Endpoints that do resolve: `/v1.0/devices/{id}/logs`,
`/v1.0/iot-03/devices/{id}/logs`, `/v2.0/cloud/thing/{id}/report-logs`,
`/v1.0/iot-03/devices/{id}/status`.

So event delivery is **polled**, on a 10s cron:

| Path | Trigger | Notes |
|---|---|---|
| **State poll** (primary) | `@Cron('*/10 * * * * *')` → `pollDeviceState()` | **One** API call returns every device in the project *with full datapoint status*. Diffed and turned into the same `devicePropertyMessage`/`deviceOnline`/`deviceOffline` handling a Pulsar subscriber would do. O(1) in device count — this is what makes 10s affordable. |
| **Event-log poll** (opt-in) | same cron, when `configuration.pollDeviceLogs: true` | `GET /v1.0/devices/{id}/logs?type=1,2,7`, cursored per device. Gives exact event ordering/timestamps and catches datapoints that toggle *and revert* between two state polls. **One call per device per tick** — capped by `configuration.maxLogDevices` (default 25), and the number skipped is logged. |
| **HTTP bridge** | `POST /integrations/tuya/webhook` (`@Public`) | Tuya never calls this. It is the ingress for a sidecar Pulsar consumer that forwards messages as HTTP, and the way to test the pipeline locally. Always answers `200 {success:true}`. |
| **Full sync** | `POST /integrations/:id/tuya/sync`, and automatically on create/update/toggle while active | The only path that **creates** devices. |

All four converge on **`TuyaSyncService.processTuyaMessage(msg, integration)`**,
which takes a transport-neutral `TuyaMessage {bizCode, devId, bizData, ts}`.
Handling for the three bizCodes lives there and nowhere else, so adding a real
Pulsar consumer later means writing a transport and calling that method —
nothing else changes.

Worst-case latency for a datapoint change is one poll interval (10s).

Auto-sync on activation is fire-and-forget (`setImmediate`): a slow or
unreachable Tuya project must not make saving an integration hang or fail.

### Messaging rules to enable in the Tuya console

The rules decide what Tuya puts on the queue, and — because the state poll
reads the same underlying device state — what is worth reacting to:

1. <https://iot.tuya.com> → your cloud project → **Message Service**.
2. Subscribe to: **`devicePropertyMessage`** (telemetry), **`deviceOnline`**,
   **`deviceOffline`**.
3. `bindUser` is also handled — it triggers a full import of the newly linked
   device.

These bizCodes are the canonical spellings `applyMessageToDevice()` switches
on; the older HTTP-era names (`statusReport`, `online`, `offline`) are accepted
as aliases.

### Details that matter

- **Telemetry rows are merged snapshots, not deltas.** A webhook status report
  carries only the datapoints that changed, but the rest of the platform reads
  the newest row as the device's complete current state — so incoming codes are
  merged over the previous reading. Otherwise a `switch_1` event would erase the
  device's temperature.
- **Unchanged readings are not stored.** A 10s poll of an idle device would
  otherwise write ~8,640 identical rows per device per day. Nothing is
  broadcast either. This change-detection is what makes state-diffing
  equivalent to consuming a message stream.
- **Log values are coerced.** The log endpoint returns `"true"` / `"23"` as
  strings where the device-list status returns real booleans and numbers.
  `coerceLogValue()` normalises them, otherwise alternating between the two
  sources would look like a change on every poll and store a row each time.
- **`lastSeenAt` is refreshed on every poll while online**, not only on a
  transition — `DevicesService.checkOfflineDevices()` flips any ACTIVE device
  with a stale `lastSeenAt` to OFFLINE every 5 minutes, so a permanently-online
  Tuya device would otherwise flap forever.
- **Only `batteryLevel` is denormalised.** Tuya scales temperature/humidity per
  product (`va_temperature` is usually ×10) and the factor lives in the device's
  function spec, which the device-list endpoint does not return. Raw codes stay
  in `telemetry.data`.
- `local_key` is a secret: it lives in `device_credentials.credentialsValue`
  (`select: false`), never in `device.metadata`.
- `devices.externalId` is **not** unique — the same physical device can be bound
  to two tenants' projects. Lookups are always `(tenantId, externalId)`.
- Device names edited in this platform are not overwritten by Tuya on re-sync;
  only an empty name is backfilled.
- Access tokens are cached in `TuyaAdapter` (static, keyed by clientId+region,
  Tuya's own `expire_time` minus 60s), and dropped + retried once on a
  token-error code. Without this the 30s poll would re-authenticate ~2,900
  times a day per integration and get throttled.

### The HTTP bridge endpoint

`POST https://api.smart-life.sa/integrations/tuya/webhook` is **not** called by
Tuya (see above — Tuya has no HTTP callback). It exists so that a sidecar
Pulsar consumer can forward messages into the platform over HTTP, and so the
message pipeline can be exercised without a Tuya project at all:

```bash
curl -X POST http://localhost:5000/integrations/tuya/webhook \
  -H 'Content-Type: application/json' -H 'client_id: <configuration.clientId>' \
  -d '{"devId":"<tuyaDeviceId>","bizCode":"devicePropertyMessage",
       "bizData":{"properties":[{"code":"switch_1","value":true}]}}'
```

The `client_id` header (or `clientId` in the body) must match the integration's
`configuration.clientId` — that is how a delivery is mapped to a tenant.

**Security caveat:** the endpoint is unauthenticated, so anyone who learns a
`clientId` can post telemetry for that tenant's devices. Setting
`configuration.webhookSecret` additionally requires a matching
`x-webhook-secret` header. If you are not running a Pulsar bridge, this route
has no production purpose and is safe to delete.

### Not wired up

Tuya-sourced telemetry does **not** currently run device-profile alarm rules or
fan out to other integrations — unlike the MQTT (`TelemetryConsumer`) and HTTP
(`TelemetryService`) paths. Tuya imports are also not gated by the tenant's
device quota (`canTenantPerformAction` returns false for tenants with no
subscription row, which would block imports outright); usage counters are not
incremented for imported devices.

## 4e. Integration Centre

Eighteen integration types, one declarative catalogue, and a real event log.

```
integration-catalogue.ts   (the manifest table — label, category, direction,
     │                      icon, hasAdapter, inboundPath, fields[])
     ├── GET /integrations/catalogue  → the frontend's type gallery AND its
     │                                  generated configuration form
     ├── validateIntegrationConfig()  → create/update return 400 with every
     │                                  missing required field at once
     └── isDispatchableType()         → which rows the telemetry fan-out touches
```

### The catalogue is the single source of truth

`src/modules/integrations/integration-catalogue.ts` holds one
`IntegrationTypeManifest` per `IntegrationType`. Adding a type means adding a
manifest (plus an adapter, and an enum label via migration) — the frontend needs
no change, because both its tile and its form are generated from the manifest.

`npm run check:integrations` validates the table: every enum member has a
manifest, field keys are unique, `select` fields have options, `showIf` targets
exist, the direction helpers agree with the declared direction, and an empty
configuration fails for exactly the required fields.

| Field | Meaning |
|---|---|
| `direction` | `inbound` / `outbound` / `bidirectional`. Governs the TELEMETRY pipeline, not the UI — Tuya is `inbound` even though commands flow the other way, because platform telemetry is never forwarded to it. |
| `hasAdapter` | False means telemetry is not forwarded. The UI labels the tile "Not wired up" rather than accepting a configuration that silently does nothing. |
| `adapterNote` | What to use instead, surfaced in the UI. |
| `inboundPath` | The URL an external source pushes to. `:id` is substituted with the integration id. |
| `fields[]` | What the form renders and what the server validates. |

### Direction decides the fan-out — and that filter is load bearing

`IntegrationDispatchService` selects per-tenant ACTIVE integrations and now
filters them through `isDispatchableType()` (outbound **and** `hasAdapter`).
Before that filter:

- **Tuya was destroyed by ordinary traffic.** `TuyaAdapter.dispatch` is
  command-only, so a telemetry message with no `commands` returned
  `success:false`; ten consecutive failures flip the row to ERROR with
  `enabled=false`, which also stops `TuyaSyncService` (it polls only
  ACTIVE+enabled rows). A working Tuya integration switched itself off after ten
  readings from any other device in the tenant.
- **`notification` / `database`** logged "No adapter for integration type" once
  per reading, per row — ~144k lines a day for one row on a 100-device tenant.

### Outbound adapters

| Type | Transport | Notes |
|---|---|---|
| `webhook`, `api` | HTTPS | |
| `mqtt` | MQTT | One-shot per message: connect → publish → `end(true)`, `reconnectPeriod: 0`, so a dead broker leaves no retry loop. |
| `kafka` | kafkajs | Producers are **pooled** (`static pool`, idle reaper, `unref()`), keyed by broker set — a producer per message would exhaust connections. |
| `aws_iot` | AWS SDK | Dynamically imported; a missing SDK degrades to a failed dispatch rather than a boot failure. |
| `azure_iot` | REST + SAS | A per-device key signs `sr = host/devices/{id}`; a policy key signs `sr = host` and adds `skn`. IoT Hub base64-**decodes** the key before HMAC. |
| `azure_event_hub` | REST + SAS | Same SAS shape, but the key is used as **UTF-8 text**, not base64-decoded. Getting this backwards is the classic Event Hubs 401. |
| `google_cloud` | Pub/Sub REST | Service-account JWT (RS256) exchanged for an OAuth token, cached per account with 60s slack. The probe is a GET on the topic, so it has no side effect. |
| `ibm_watson` | MQTT | Composes `MqttAdapter`. `clientId` must be `a:{orgId}:{appId}` — with the wrong prefix the broker accepts the connection and then silently drops every publish. |
| `coap` | UDP | Dynamically imported. A non-confirmable request resolves on `setImmediate`: success means the datagram left the host, nothing more, and the result message says so. |
| `cloud` | — | Legacy catch-all; the adapter is guessed from the configuration keys (`accessKeyId`/`endpoint` → AWS, `clientId`+`clientSecret` → Tuya). |

`POST /integrations/:id/test` probes through the same adapter dispatch uses, so
a pass means real traffic will work. For publish-style types that means a real
message reaches subscribers — reported in the result's `sideEffect`.

### Inbound

| Route | Serves |
|---|---|
| `POST /integrations/lorawan/chirpstack` | ChirpStack webhook. Auto-creates devices by DevEUI. |
| `POST /integrations/lorawan/ttn` | The Things Stack v3 webhook (snake_case envelope). |
| `POST /integrations/http/:id` | **Generic uplink** — Loriot, Sigfox, a vendor cloud, a gateway script. |
| `POST /integrations/tuya/webhook` | Bridge for a sidecar Pulsar consumer (see §4d — Tuya has no HTTP callback). |
| MQTT subscriptions | `IntegrationMqttInboundService`, below. |

All of them answer **200** with a `success` field rather than a 4xx/5xx, because
a push source that receives an error retries and eventually disables the
destination.

**`POST /integrations/http/:id`** (`IntegrationUplinkService`): the URL names the
INTEGRATION, and the device is dug out of the body using the integration's own
field mapping — unlike `POST /api/v1/ingestion/:deviceKey`, where the URL names
the device. The `routingKey` is **required** and compared with
`crypto.timingSafeEqual`. Unknown devices are rejected, **not** auto-provisioned:
an arbitrary HTTP source can send any string, and creating a device per
unrecognised value would let a misconfigured sender exhaust the tenant's device
quota. (The LoRaWAN paths do auto-provision, because a DevEUI is a globally
unique hardware identity.)

**`IntegrationMqttInboundService`**: persistent MQTT clients, one per MQTT
integration that sets `configuration.inboundTopic`. Opposite lifetime to
`MqttAdapter` — `reconnectPeriod: 15000`, `clean: true` (a persistent session
would reconnect into a flood of stale readings after an outage, each stored with
its original timestamp). Reconciled by `sync()` at boot, on a one-minute cron,
and whenever `IntegrationsService` changes an MQTT row; a config *fingerprint*
means only connection-relevant edits force a reconnect, so changing the publish
topic does not interrupt an inbound stream. Device lookups are cached 60s and
bounded at 5000 entries. `GET /integrations/inbound-status` reports which
subscriptions are live.

Both inbound paths hand off to **`DeviceListenerService.handleTelemetry()`**, so
an uplink gets the same codec decode, Kafka publish, alarm evaluation and
WebSocket broadcast as a first-party reading. Reimplementing persistence is how
the Tuya path ended up bypassing alarms entirely.

### The event log

`integration_events` (migration `IntegrationCentre1787400000000`) is
append-only: one row per dispatch, uplink, probe and lifecycle change.

Before it, "what has this integration been doing?" could only be answered from
`errorHistory` — a jsonb array capped at the last 10 **failures**, so successes
left no trace — or `GET /integrations/recent-activity`, which synthesises one
entry per integration from its current column values and therefore cannot
distinguish two failures an hour apart from one. Neither could answer "did the
14:03 reading reach AWS?".

- `IntegrationEventsService.record()` is **fire-and-forget and never throws**:
  it is on the telemetry hot path, and a log write must not fail the dispatch it
  describes.
- Payloads are **truncated at 2000 characters**. A row per message per
  integration storing full bodies would duplicate the telemetry table at a worse
  write rate.
- `prune()` runs daily, keeping `INTEGRATION_EVENT_RETENTION_DAYS` (default 14).
  Without it the table grows at telemetry rate — one webhook and 100 devices
  reporting each minute is ~144k rows a day.
- Inbound failures deliberately do **not** increment `consecutiveFailures`: the
  quarantine rule exists to stop hammering a dead outbound endpoint, and a run
  of malformed uplinks from one broken sensor must not disable a working
  integration.
- `GET /integrations/:id/events`, `GET /integrations/:id/summary` (counts over a
  window) and `GET /integrations/events` (tenant-wide) read it.
  `recent-activity` is kept unchanged because the dashboard tile consumes its
  shape.

### Scoping and authorization — both were wrong

- **CRUD was scoped by `userId`**, making integrations private to whoever created
  them: two admins of one tenant could not see each other's rows, and nobody
  could fix one left behind by a removed user — while
  `IntegrationDispatchService` selected by **tenant**, so an invisible row was
  still forwarding telemetry. Now tenant-scoped, with `userId` kept as a record
  of who created the row. Name uniqueness is per tenant to match.
- **`IntegrationsController` had no `@Roles` anywhere**, and `RolesGuard`
  returns **true** when a handler carries no `@Roles` metadata. Any
  authenticated user — a CUSTOMER_USER included — could create an integration
  holding a tenant's cloud credentials and read every integration's
  `configuration`, secrets and all. Writes are now TENANT_ADMIN and above;
  `GET /integrations/:id` (which returns `configuration`) likewise; the
  list/statistics/activity routes stay open to CUSTOMER for the dashboard tiles.
- Editing a configuration, or re-enabling a row, **clears `consecutiveFailures`**
  — an operator correcting a quarantined integration is saying it is fixed.
  Without that, it re-quarantined on the next failure.

### Gotchas worth knowing

- `integrations.type` is a **Postgres ENUM**. A new TypeScript member alone is
  not enough: `@IsEnum` accepts it and the INSERT then fails with
  `invalid input value for enum integrations_type_enum`. That is exactly why the
  frontend's "Apache Kafka" tile 400'd — the label did not exist in the database.
  `migration:run` is blocked (see §11), so use
  `npm run migration:integration-centre <database> [up|down]` to apply this one
  in isolation.
- A nullable column whose property is a **union** (`string | null`) needs an
  explicit `type`. TypeORM reflects the union as `Object` and refuses it at
  `DataSource.initialize` — `Data type "Object" in "IntegrationEvent.deviceKey"
  is not supported by "postgres"` — and the **whole application fails to boot**,
  not just that entity.
- An unreachable **Kafka broker stops the application booting**: `KafkaModule`'s
  factory awaits `initProducer()`, and a consumer's failed `connect()` surfaces
  as an unhandled rejection that kills the process. Pre-existing, unchanged here,
  but it makes local work without the full stack impossible.

## 5. Database & ORM Patterns

### BaseEntity
All entities extend `src/common/entities/base.entity.ts`:

```typescript
abstract class BaseEntity extends TypeORMBaseEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;
  @DeleteDateColumn({ name: 'deleted_at', nullable: true }) deletedAt?: Date; // soft-delete
  @Column({ name: 'created_by', nullable: true }) createdBy?: string;
  @Column({ name: 'updated_by', nullable: true }) updatedBy?: string;
  @Column({ name: 'deleted_by', nullable: true }) deletedBy?: string;
}
```

All primary keys are UUID v4. All deletes are soft (TypeORM `softDelete`).

### Multi-tenancy Convention
Every entity has `tenantId: string` column (non-nullable unless the entity is explicitly global, like system roles). Guards inject `request.tenantFilter = { tenantId }` and services scope all queries with this filter.

### Migrations
- `synchronize: false` (never auto-sync in any environment)
- TypeORM CLI via `npm run migration:generate`, `migration:run`, `migration:revert`
- Config: `src/config/migration.config.ts` → `src/database/data-source.ts` (reads `.env` or `.env.${NODE_ENV}`)
- **No migrations have been generated yet** — the `src/database/migrations/` directory is empty. Schema is managed by seeding and `schema:sync` for local dev.

### Seeds
`npm run seed` executes `src/database/seeds/seed.command.ts` via `ts-node`. Each entity has its own seeder class implementing `ISeeder`. The `DatabaseSeederService` orchestrates order. Seeds cover all entities including realistic IoT data.

### JSONB Usage
Heavy use of JSONB columns:
- `Subscription.limits`, `Subscription.usage`, `Subscription.features` — subscription plan data
- `Subscription.metadata` — Moyasar/Stripe external IDs
- `Telemetry.data` — flexible sensor payload
- `Device.configuration`, `Device.metadata` — device-specific settings and devEUI/codecId
- `Alarm.rule` — alarm condition definition
- `Automation` trigger/conditions/actions
- `Tenant.configuration` — timezone, language, theme
- `Customer.allocatedLimits`, `Customer.usageCounters`
- `User.preferences`
- `RefreshToken.deviceInfo`

### Repository Pattern
Services use `@InjectRepository(Entity)` directly — no custom repository layer except where explicitly needed (e.g., `AlarmsRepository`, `TelemetryRepository`). `QueryBuilder` used for complex tenant-scoped queries.

### Indexes
Composite indexes on every table for the most common query patterns:
```typescript
@Index(['tenantId', 'status'])
@Index(['tenantId', 'deviceId', 'timestamp'])  // telemetry
@Index(['deviceKey'], { unique: true })         // devices
```

---

## 6. API Conventions

### URL Structure
- Base URL prefix: `api` (set by `API_PREFIX` env var)
- Routes: `GET /api/auth/login`, `GET /api/devices`, etc.
- Swagger UI: `/api`

### Controller Pattern
```typescript
@ApiTags('devices')
@Controller('devices')
@ApiBearerAuth()
export class DevicesController {
  @Get()
  @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: '...' })
  @ApiResponse({ status: 200, ... })
  findAll(@CurrentUser() user: User, @Query() query: PaginationDto) { ... }
}
```

### DTOs
- Input DTOs use `class-validator` decorators (`@IsString()`, `@IsOptional()`, `@IsEnum()`, `@MinLength()`, `@Matches()`)
- `class-transformer` `@Type(() => Number)` for query param coercion
- `@Exclude()` on sensitive fields (password, tokens) in entity
- Pagination: extend `PaginationDto` with `page`, `limit`, `search`, `sortBy`, `sortOrder`
- Paginated responses: `PaginatedResponseDto<T>` with `data[]` + `meta: PaginationMetaDto`
- Base responses: `BaseResponseDto<T>` with `{ success, data, message, timestamp }`

### Response Wrapping
`TransformInterceptor` wraps all successful responses:
```json
{ "success": true, "data": <payload>, "timestamp": "..." }
```

Error responses from `HttpExceptionFilter`:
```json
{ "success": false, "statusCode": 400, "error": "...", "message": "...", "timestamp": "...", "path": "..." }
```

### Validation
Global `ValidationPipe` with `whitelist: true, forbidNonWhitelisted: true, transform: true`. Configured in `main.ts`.

### Key Decorators

| Decorator | Effect |
|---|---|
| `@Public()` | Skips JWT authentication (sets `IS_PUBLIC_KEY` metadata) |
| `@Roles(...roles)` | Restricts to specific `UserRole` enum values |
| `@RequirePermissions(...perms)` | Requires `resource:action` permission strings |
| `@SubscriptionPlan(plan)` | Requires minimum subscription plan |
| `@CurrentUser()` | Extracts full `User` from `request.user` |
| `@CurrentUser('id')` | Extracts specific User property |
| `@Throttle(...)` | Per-endpoint rate limit override |

---

## 7. Auth & Multi-tenancy

### Authentication Flow
1. `POST /api/auth/login` → `AuthService.login()` → validates credentials → checks 2FA → creates Redis session + DB refresh token → returns `{ accessToken, refreshToken, expiresIn, tokenType, user }`
2. `GET /api/auth/google` → Passport GoogleStrategy → redirect → `GET /api/auth/google/callback` → one-time code stored in Redis (60s TTL) → redirect to `FRONTEND_URL/auth/callback?code=<code>`
3. `POST /api/auth/exchange-code` → client exchanges one-time code for tokens (prevents tokens in URL)
4. Access tokens: JWT (default 15m). Refresh tokens: 64-byte hex in Postgres (default 7d), capped at 5 per user.
5. `POST /api/auth/refresh` → validates refresh token + session → rotates refresh token → returns new pair
6. `POST /api/auth/logout` → revokes refresh token, blacklists access token in DB, deletes Redis session

### JWT Payload
```typescript
interface JwtPayload {
  sub: string;          // userId
  email: string;
  role: UserRole;
  tenantId?: string;    // embedded — guards never hit DB to resolve tenant
  customerId?: string;  // embedded — guards never hit DB to resolve customer
  sessionId: string;    // UUID; validated against Redis on every request
}
```

### Sessions
`SessionService` stores session data in Redis at key `user:{userId}:session` (7-day TTL). Each session tracks associated refresh tokens. One active session per user — new login overwrites existing.

### Token Blacklist
`TokenBlacklist` table stores revoked access tokens until their `expiresAt`. `JwtStrategy.validate()` checks this on every request. Cleaned hourly via `@Cron('0 * * * *')`.

### Guard Execution Order
Guards run globally in this order (registered in `GuardsModule`):

1. **`CustomThrottlerGuard`** — Rate limiting (100 req/min default; per-endpoint overrides via `@Throttle`)
2. **`JwtAuthGuard`** — Validates Bearer token; skips if `@Public()`
3. **`RolesGuard`** — Checks `@Roles()` against `user.role`; skips if no `@Roles()` or `@Public()`
4. **`TenantIsolationGuard`** — Ensures non-super-admin users cannot access other tenants; injects `request.tenantFilter = { tenantId: user.tenantId }`
5. **`CustomerAccessGuard`** — Injects `request.customerFilter` for customer-scoped operations
6. **`SubscriptionGuard`** — Loads subscription from DB (1 DB call), caches at `request.subscription`; validates plan is active; checks `@SubscriptionPlan()` minimum plan requirement
7. **`FeatureLimitGuard`** — Reads `request.subscription.features`; blocks access if feature is disabled for plan
8. **`PermissionGuard`** — Resolves effective permissions (role perms ∪ direct perms) filtered by subscription features and customer grants; enforced only for CUSTOMER and CUSTOMER_USER roles
9. **`SubscriptionLimitGuard`** — Reads `request.subscription.usage` counters; blocks if quota exceeded

### Multi-tenancy Model
```
SUPER_ADMIN          ← no tenantId; accesses all tenants
  └── TENANT_ADMIN   ← has tenantId; owns the tenant
        └── CUSTOMER ← has tenantId + customerId; manages a customer org
              └── CUSTOMER_USER ← has tenantId + customerId; end user
```

- **Tenant** = organization (B2B company or personal workspace created at registration)
- **Customer** = sub-organization under a tenant; has `allocatedLimits` and `grantedPermissions`
- Resources flow: Tenant owns devices/assets → assigns to Customers → Customer admins assign to Users

### 2FA
Supports three methods (`TwoFactorMethod` enum): `authenticator` (TOTP via speakeasy), `sms` (stub — no SMS provider wired), `email` (sends OTP via MailService). When 2FA is enabled, login returns `{ requires2FA: true, userId, method }` instead of tokens. Client must call `POST /api/auth/oauth/verify-2fa` with the code to complete login.

### Invitation Flow
- Admin calls `POST /api/auth/invitations` → creates `Invitation` entity + sends email with token
- Invitee registers at `POST /api/auth/register` with `invitationToken` → user account linked to tenant/customer

---

## 8. Environment & Config

### Key Environment Variables

```bash
# App
NODE_ENV=development|production
PORT=5000
API_PREFIX=api
APP_NAME="Smart Life IoT Platform"
FRONTEND_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=123456
DB_DATABASE=postgres
DB_LOGGING=false

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# JWT
JWT_SECRET=<required>
JWT_EXPIRATION=15m
JWT_REFRESH_SECRET=<required>
JWT_REFRESH_EXPIRATION=7d

# MQTT (EMQX)
MQTT_BROKER_URL=mqtt://localhost:1883
MQTT_USERNAME=admin
MQTT_PASSWORD=public
MQTT_CLIENT_ID=smartlife-platform

# Kafka
KAFKA_BROKERS=localhost:9093

# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:5000/api/auth/github/callback
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=

# Payments
MOYASAR_API_KEY=
MOYASAR_WEBHOOK_SECRET=

# Integrations
INTEGRATION_EVENT_RETENTION_DAYS=14   # How long integration_events rows are kept

# Feature Flags
AUTO_REGISTER_DEVICES=false    # Auto-create device records on first MQTT message
```

### Config Modules
Loaded via `ConfigModule.forRoot({ load: configModules })` where `configModules = [appConfig, databaseConfig, jwtConfig, redisConfig, mqttConfig, migrationConfig]`. Each uses `registerAs(namespace, factory)` — access nested values via `configService.get('jwt.secret')`.

### Path Aliases (tsconfig.json)
```
@/*          → src/*
@common/*    → src/common/*
@config/*    → src/config/*
@modules/*   → src/modules/*
@lib/*       → src/lib/*
@database/*  → src/database/*
@decorators/* → src/common/decorators/*
@guards/*    → src/common/guards/*
@interceptors/* → src/common/interceptors/*
@filters/*   → src/common/filters/*
@transformers/* → src/common/transformers/*
```

---

## 9. Docker & Deployment

### Production Stack (`docker-compose.prod.yml`)

| Service | Image | Port(s) |
|---|---|---|
| `app` | `msufyanabbas10/smartlife-iot-platform:latest` | 5000 |
| `postgres` | `postgres:15-alpine` | 5432 |
| `redis` | `redis:7-alpine` | 6379 |
| `redis-commander` | `rediscommander/redis-commander:latest` | 8091→8081 |
| `zookeeper` | `confluentinc/cp-zookeeper:7.5.0` | 2181 |
| `kafka` | `confluentinc/cp-kafka:7.5.0` | 9092 (internal), 9093 (external) |
| `kafka-ui` | `provectuslabs/kafka-ui:latest` | 8090→8080 |
| `emqx` | `emqx/emqx:5.3.0` | 1883 (MQTT), 8083 (WS), 18083 (dashboard) |
| `prometheus` | `prom/prometheus:latest` | 9090 (profile: monitoring) |
| `cadvisor` | `gcr.io/cadvisor/cadvisor:latest` | 8080 (profile: monitoring) |
| `node-exporter` | `prom/node-exporter:latest` | 9100 (profile: monitoring) |
| `grafana` | `grafana/grafana:latest` | 3001→3000 (profile: monitoring) |

Monitoring services are gated behind `--profile monitoring`.

### Dockerfile
Multi-stage build on `node:25-bookworm-slim`:
1. **base** — installs system deps + compiles `libredwg 0.12.5` from source (for DXF/floor plan support)
2. **dependencies** — `npm ci`
3. **builder** — `npm run build` → compiles TypeScript
4. **production** — copies only runtime libs + `dist/` + source (for ts-node seeds) + `node_modules`

Runs as non-root user `nodejs:1001`. Entrypoint: `dumb-init node dist/main.js`.

### CI/CD (`.github/workflows/deploy-production.yml`)
Triggers on push to `main`/`master` or manual dispatch.

1. **build job**: checkout → `npm ci` → lint + unit tests (parallel) → Docker Buildx → push to DockerHub
2. **deploy job**: SSH to VPS → async DB backup → `docker pull` new image → start infra if not running → `docker compose up -d app --force-recreate` → health check poll → `npm run migration:run`
3. **notify job**: reports success/failure

Required GitHub secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`.

### NPM Scripts Reference
```bash
npm run start:dev          # Watch mode (local)
npm run build              # Compile TypeScript
npm run start:prod         # node dist/main.js
npm run migration:generate # Generate migration from entity diff
npm run migration:run      # Apply pending migrations
npm run migration:revert   # Revert last migration
npm run seed               # Run all seeders
npm run db:reset           # revert + run + seed
npm run docker:local       # docker-compose.local.yml up
npm run docker:up          # docker-compose.prod.yml up -d
npm run test:unit          # Jest unit tests
```

---

## 10. Coding Conventions

### File & Directory Naming
- Directories: `kebab-case` (e.g., `device-commands/`, `floor-plans/`)
- Files: `kebab-case.type.ts` (e.g., `telemetry.service.ts`, `create-device.dto.ts`, `device.entity.ts`)
- Enum files: `thing.enum.ts`
- Interface files: `thing.interface.ts`
- All enums barrel-exported from `src/common/enums/index.enum.ts`
- All entities barrel-exported from `src/modules/index.entities.ts`
- All feature modules barrel-exported from `src/modules/index.module.ts`

### Module Structure (every feature)
```
modules/thing/
├── thing.module.ts
├── thing.service.ts
├── thing.controller.ts
├── dto/
│   ├── create-thing.dto.ts
│   ├── update-thing.dto.ts
│   └── thing-response.dto.ts   (optional)
└── entities/
    └── thing.entity.ts
```

### Entity Conventions
- Extend `BaseEntity` (UUID PK, soft-delete, audit columns)
- Always include `@Column() tenantId: string` + `@ManyToOne(() => Tenant)` relation
- Optional customer scoping: `@Column({ nullable: true }) customerId?: string`
- Declare composite indexes at class level for tenant-scoped queries
- Put business logic as instance methods directly on the entity (e.g., `isActive()`, `isLimitReached()`, `updateLastSeen()`)
- Use `@BeforeInsert()` / `@BeforeUpdate()` hooks for password hashing, token generation, etc.
- `select: false` on columns that should never be returned by default (passwords, secret tokens)

### Service Conventions
- `private readonly logger = new Logger(ClassName.name)` in every service
- Inject repositories with `@InjectRepository(Entity)`
- Pass `tenantId` explicitly from JWT payload (never trust request body for tenant scoping)
- Services receive pre-extracted IDs from `@CurrentUser()` — do not reload caller from DB
- Use `QueryBuilder` with explicit `.where('entity.tenantId = :tenantId', { tenantId })` for complex queries
- Throw NestJS HTTP exceptions (`NotFoundException`, `ForbiddenException`, etc.) — not generic `Error`

### Guards & Decorators
- `@Public()` + `@Throttle(...)` together = public but rate-limited
- OAuth guards MUST use `@UseGuards(GoogleAuthGuard)` locally — they are NOT registered globally
- `request.tenantFilter` is set by `TenantIsolationGuard` — all services should use it for filtering
- `request.subscription` is set by `SubscriptionGuard` — downstream guards read it (no extra DB calls)

### Barrel Exports
Prefer importing from barrel files over direct module paths in cross-module code:
```typescript
import { Device, Tenant } from '@modules/index.entities';
import { DevicesService } from '@modules/index.service';
```

### IoT-Specific Patterns
- **StandardTelemetry** interface is the canonical format all protocol adapters produce
- Codec selection priority: `metadata.codecId` → `device.metadata.codecId` → auto-detect by `manufacturer` + `model`
- LoRaWAN detection by payload shape (`devEUI` + `data` base64 fields), NOT by MQTT topic
- Device keys (`deviceKey`) are unique across the platform and used as the primary lookup key for MQTT topics
- MQTT topic patterns: `devices/{deviceKey}/telemetry`, `devices/{deviceKey}/attributes`, `application/{appId}/device/{devEUI}/rx`

### CoAP Ingestion (`CoAPAdapter`)
- CoAP server runs on **port 5683/UDP** (`COAP_PORT`), started automatically at boot by `CoAPAdapter.onModuleInit()`. Disable with `COAP_ENABLED=false`. Docker: `docker-compose.local.yml` maps `5683:5683/udp` on the `app` service.
- **ThingsBoard-compatible routes** (device token embedded in the path — the token IS the `deviceKey`):
  - `POST /api/v1/{deviceToken}/telemetry` → ingest telemetry (routed through `DeviceListenerService.handleTelemetry()`, the same unified path as MQTT/HTTP)
  - `POST /api/v1/{deviceToken}/attributes` → set client-scope attributes (`AttributesService.saveAttributes`)
  - `GET  /api/v1/{deviceToken}/attributes` → read client + shared attributes
  - `POST /api/v1/{deviceToken}/rpc` → device-initiated RPC (currently acknowledges receipt; two-way command dispatch is a TODO)
- **Response codes**: `2.05` success · `4.00` bad/malformed JSON · `4.04` unknown device token or resource · `4.05` wrong method · `5.00` internal error.
- Device authentication is by `deviceKey` lookup in the `devices` table; unknown token → `4.04`. No JWT/global guards apply (raw UDP server, not an HTTP controller).
- `coap` npm package has no `@types/coap` (404 on npm); types are provided by the ambient `src/types/coap.d.ts` declaration.
- Test end-to-end with `npx ts-node scripts/test-coap.ts`.

---

## 11. Known TODOs / WIP

### Incomplete Implementations

| Location | Issue |
|---|---|
| `src/database/migrations/` | Run migrations against **`dist`** (`npx typeorm migration:run -d dist/database/data-source.js`) — `data-source.ts` globs `*.js` only, so `npm run migration:run` reports "No migrations are pending" from source. |
| **`migration:run` is currently blocked** | `PreExistingSchemaDrift1786345964232` and `SchemaDriftFix1786348092217` are in the source but have never been applied, and the first one *fails*: `ALTER TABLE solution_templates ALTER COLUMN category TYPE …` → `invalid input value for enum solution_templates_category_enum: "agriculture"`. Because they sort ahead of every later migration, the whole transaction aborts and nothing after them can run. Until they are fixed, a new migration has to be applied with those two temporarily moved out of `dist/database/migrations/`. |
| Entity/DB drift | `migration:generate` currently also wants to create 8 assignment junction tables, narrow `solution_templates_category_enum` (**destructive** — removes 6 in-use values), rebuild the firmware indexes and rewrite several jsonb defaults. This is pre-existing drift left out of `DeviceAssetProfileEnhancements`; it needs its own reviewed migration. |
| `src/modules/attributes/attributes.service.ts` line 253 | `getTimeseries()` is a stub — needs to query telemetry table |
| `src/modules/api-monitoring/api-monitoring.service.ts` line 465 | Health check details not fully implemented |
| `src/modules/images/images.service.ts` line 77 | File storage delete is TODO — files not actually deleted from disk/S3 |
| `src/modules/images/images.controller.ts` line 46 | File upload to persistent storage (S3/local) is TODO |
| `src/modules/alarms/alarms.consumer.ts` line 359 | SMS notification integration (Twilio/AWS SNS) is a TODO stub |
| `src/modules/payments/payments.service.ts` | Stripe is installed as a dependency but Moyasar is the active provider; Stripe integration is not wired |
| `src/modules/protocols/adapters/ble.adapter.ts` | BLE adapter has placeholder implementation |
| `src/modules/protocols/adapters/coap.adapter.ts` | Implemented (ThingsBoard-style telemetry/attributes/rpc over UDP 5683). Remaining TODO: two-way server-side RPC dispatch (currently only acknowledges device-initiated RPC). |
| `src/modules/devices/codecs/milesight/ds/ds3604.codec.ts` | Binary image payload decode not implemented |
| `src/modules/rules/rule-engine.service.ts` | File exists but is essentially empty (1 line) |
| `KafkaModule` / the Kafka consumers | An unreachable broker stops the app booting: the module factory awaits `initProducer()`, and a consumer's failed `connect()` becomes an unhandled rejection that kills the process. Running locally therefore needs the full Docker stack. |
| `src/modules/integrations/` — `notification` and `database` types | Declared in the catalogue with `hasAdapter: false`; they are skipped by the dispatcher rather than forwarding anything. Use a webhook or Kafka instead. |
| `src/modules/integrations/` — converters | The frontend has seven converter pages under `/integrations/*` and there is **no backend converter module at all**. Payload decoding is done by `CodecRegistryService` in DevicesModule. |

### Structural Notes
- The `src/migrations/` directory (at `src/` root, separate from `src/database/migrations/`) exists but is also empty
- `__pycache__/` and `extract_api*.py` files exist at project root — likely leftover from a Python API extraction script; not part of the application
- `assignment-safety-triggers.sql` at project root — SQL triggers for assignment safety checks; status of application to DB is unknown
- `src/modules/gateway/` is a thin HTTP wrapper; the main ingestion path is via `ProtocolsModule/HTTPAdapter`
- `dist/modules/alarms/index.html` and `dist/modules/dashboards/smartlife-dashboard.html` are static HTML files in the dist directory — unclear if these are intentionally served or build artifacts
