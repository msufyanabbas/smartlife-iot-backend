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
| `ConvertersModule` | Data converters: uplink/downlink payload transformation driven by a declarative catalogue — `json` field mapping, sandboxed `script`, and `codec` which delegates to `CodecRegistryService` so the 127 registered codecs are reachable from a converter. Includes `POST /converters/:id/test` with a per-step trace |
| `ReportsModule` | Report templates and real generation (CSV / JSON / PDF) as a declarative query over `TelemetryService`, `AnalyticsService`, alarms, devices and the audit log, plus a cron scheduler that emails a summary |
| `GroupsModule` | Named sets of entities of one kind (devices, assets, customers, users) with bulk membership, used for assignment and filtering |
| `QueuesModule` | Queue definitions a rule chain can be assigned to. `GET /queues/capabilities` reports which fields are honoured and which are stored-only — see §4h |
| `DefaultRuleChainsModule` | Maps (originator type, message type, device profile) → rule chain, consulted by `RuleEngineConsumer` before the fan-out fallback |
| `RulesModule` | The rule engine: 8 node types from a declarative catalogue, a complete traversal engine with per-node tracing, atomic whole-graph save for the visual editor, dry-run testing, static graph validation, index-based import/export, and reusable chain templates (built-in plus tenant-saved) that instantiate into real chains. See §4f |

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
- **All three items this note used to list as missing are now implemented.**

  - **`DURATION` / `REPEATING`** are evaluated properly. Per-device, per-rule
    progress lives in **`alarms.metadata.conditionState`** — on the
    materialised row that already exists one-per-(device, rule), so it costs no
    extra round trip and, crucially, **survives a restart**. In-process state
    would silently reset every in-flight 10-minute window on deploy; this
    deployment's Redis is a cache shared with Bull, so an eviction would do the
    same. A sample that breaks the condition resets progress, a `clearRule`
    clears and resets in one write, and progress accumulated under a different
    `spec.type` is discarded. Note the real field names are `spec.unit` +
    `spec.value`, not `spec.predicate`; ThingsBoard's
    `spec.predicate.defaultValue` is read as a tolerated alias.
  - **`predicate.value.dynamicValue`** resolves against the `attributes` table.
    `numberValue` is a DECIMAL and comes back as a string, so it is coerced —
    otherwise `EQUAL` compares `"30.000000"` to `"30"`. An absent attribute
    skips the rule rather than comparing against a stale literal.
  - **The propagation flags** drive `AlarmPropagationService`: a recursive CTE
    up `assets.parentAssetId` with **both** a cycle guard
    (`NOT id = ANY(path)`) and a depth bound (`ALARM_PROPAGATION_MAX_DEPTH`,
    default 10), every row pinned to the tenant.

    A propagated alarm is a **real row** with `assetId` (or `customerId`) set
    and `deviceId` NULL. `alarms.assetId` had existed with an FK since the
    entity was written and was simply never populated, so using it means
    `GET /alarms`, `/active`, `/critical`, `/counts` and `/statistics` pick the
    copies up with **no query changes**, while `GET /alarms/device/:id` still
    shows only the device's own. Copies carry
    `metadata.propagation.isMirror`, emit no `alarm.*` events and get no
    escalation jobs — one physical fire must trigger automation once, not once
    per hierarchy level. `?originOnly=true` excludes them from counts;
    `?assetId=` is how a building view finds a room's alarm. Clear and
    acknowledge travel in both directions, idempotently.

- **Still not implemented:** there is no periodic sweep, so continuity is
  judged across *samples*. A DURATION alarm fires on the first matching sample
  after its window has elapsed, not while the device is silent. ThingsBoard's
  on-sample path behaves the same way.

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

## 4f. Rule Engine

Eight node types, a server-driven palette, and a graph saved atomically.

```
rule-node-catalogue.ts     (manifest per NodeType — label, category, icon,
     │                      the OUTPUT ROUTES it emits, config fields)
     ├── GET  /rule-chains/catalogue      → editor palette AND node config form
     ├── validateNodeConfig()             → 400 listing every missing field
     └── resolveNodeOutputs()             → which ports to draw; SWITCH reads
                                            its own cases

RuleChain (configuration, rootNodeId, counters)
     ↓ ruleChainId
Node      (type, configuration, position {x,y}, connections[])
     ↓ connections[].connectionType === the route the engine follows
RuleEngineService.traverseNodes()  →  per-node trace
```

### The engine already worked; the surface did not

`rule-engine.service.ts` is a complete traversal engine (**not** the 1-line stub
§11 claimed) and `modules/nodes/` has a processor for all eight types. What was
missing was any way to build or inspect a chain: no graph read/write, no test
run, no palette, and — on the frontend — an empty `RuleChainsPage.tsx`, three
0-byte components, and 25 hooks nothing imported, pointed at `/rules-chains`
when the controller is `rule-chains`.

| Route | Purpose |
|---|---|
| `GET /rule-chains/catalogue` | Node palette + per-type config fields. |
| `GET /rule-chains/:id/metadata` | `{ ruleChain, nodes, resolvedRootNodeId, issues }`. |
| `PUT /rule-chains/:id/metadata` | Replace the whole graph in one transaction. |
| `POST /rule-chains/:id/test` | Run a sample message; returns the per-node trace. |
| `POST /rule-chains/:id/root` | Make this the tenant's entry chain. |
| `GET /rule-chains/:id/export` · `POST /rule-chains/import` · `POST /rule-chains/:id/duplicate` | Portability. |

### Three things the metadata save has to get right

1. **Temporary ids.** A node just dropped on the canvas has no server id, but
   its edges reference it already. The payload may carry client ids (`tmp-*`);
   the server maps them to real ones after insert and rewrites every
   connection. Without this the editor would have to save nodes, read back
   their ids, then save edges — three round trips and a window where the graph
   is wrong.
2. **It is a REPLACE.** Nodes of the chain absent from `nodes` are soft-removed.
   That is what makes a visual editor safe to save from; the alternative is a
   dozen `POST /nodes` calls where any one can fail and leave edges pointing at
   nodes that were never created.
3. **Tenant scoping on update.** An existing node is only touched when it
   belongs to this tenant AND this chain, so a crafted payload cannot re-parent
   another tenant's node by id.

### Output routes are not success/failure everywhere

This is the detail that makes or breaks a chain, and the catalogue is the only
place it is written down:

| Node | Routes |
|---|---|
| `filter` | **`true` / `false`** — not success/failure. A filter's "no" branch is `false`. |
| `switch` | Whatever its `cases[].outputRoute` name, plus `defaultRoute`. Hence `dynamicOutputs: true`. |
| everything else | `success` / `failure` |

`RuleEngineService.resolveNextNode()` matches `connection.connectionType`
against the route the processor returned, so an edge labelled `success` out of a
FILTER is never followed. `validateGraph()` reports exactly that as a warning
rather than leaving it to be discovered at runtime.

### validateGraph() — static analysis, returned with every read and save

Each of these is a chain that saves cleanly and then silently does nothing:

- **No entry node** (error) — every node is the target of an edge, so the engine
  cannot pick a start.
- **Edge to a deleted node** (error) — drawn on the canvas as a dashed stub so
  it can be found and removed.
- **Route the node cannot emit** (warning) — see the table above.
- **Unreachable node** (warning) — not reachable from the entry point, so it
  never runs.
- **Missing required config** (error) and **disabled node** (warning).

`resolvedRootNodeId` repeats the engine's own fallback — the node no edge
targets — so the editor shows the entry point the engine will actually use
rather than guessing differently. Keep `RulesService.resolveRootNodeId()` in
step with `RuleEngineService.resolveStartNode()`.

### Testing a chain does not touch its counters — but does perform its actions

`POST /:id/test` goes through `RuleEngineService.testChain()`, which traverses
with `persistStats = false`. A few sample payloads should not make a chain's
health look worse than its real traffic did, and `isHealthy()` drives the UI.

The node processors still do their real work: a test through a `create_alarm` or
`rest_api_call` action **will** create the alarm and make the call. There is no
way to verify an action node's configuration without performing it, so the route
documents it and the UI says so rather than implying a sandbox.

### Export is index-based on purpose

Ids, counters and tenant columns are stripped, and edges are re-expressed
against each node's **index** in the array. An export therefore imports into
another tenant instead of colliding on ids or re-pointing at rows it does not
own. Imports land **disabled**: the nodes may reference device, script or
integration ids from the source tenant, so going live should be a decision.

### Frontend

`features/rules/` — `RuleChainsPage` (list, stats, root chain, import/export),
`RuleChainEditorPage` (palette + canvas + config + test), and a canvas built
from **plain SVG** rather than a flow library: the graph model is already fixed
by the backend, and the edge semantics (a route from a server-declared set) would
need mapping onto a library's model anyway.

The editor holds the graph in **local state** and writes it back in one request.
`useRuleChainMetadata` therefore sets `refetchOnWindowFocus: false` and infinite
`staleTime`, and the seed is keyed on chain id + `updatedAt` — otherwise tabbing
away and back replaces the user's unsaved canvas with the server's copy. On save,
the response is written into the cache (`setQueryData`, not invalidate) so the
canvas adopts the real node ids; without that the second save would send `tmp-*`
ids for nodes that already exist and create duplicates.

Sidebar: **Rule Engine** is its own top-level section. The old
`/automation/rule-chain-templates` route still resolves.

### Templates — `/rule-chain-templates`

A template is a saved chain definition you stamp out into a real chain. The
definition format **is** the export format (§ "Export is index-based on
purpose"), so saving a chain as a template, instantiating one, and importing an
exported chain are all the same code path: `instantiate()` is a wrapper over
`RulesService.importChain()`.

Two kinds of row share one table, `rule_chain_templates`:

| | `tenantId` | `isBuiltIn` | `slug` | Writable |
|---|---|---|---|---|
| Platform template | NULL | true | set | No — 403 |
| Saved by a tenant | the tenant | false | NULL | Yes |

Every read is `tenantId = :tenantId OR isBuiltIn = true`.

**Built-ins live in code**, in `rule-chain-template-catalogue.ts`, and
`syncBuiltIns()` upserts them on `onModuleInit` keyed by `slug`. So the
definitions stay in version control and a deploy can correct one, while still
being real rows — which is what lets `usageCount` be counted, categories be a
single `DISTINCT`, and listing be one paginated query instead of a merge of two
sources. The sync is **non-fatal**: the application must still boot against a
database where the migration has not been applied.

`npm run check:rule-templates` asserts every built-in is instantiable **as
shipped** — config complete, every edge on a route its source node can actually
emit, every node reachable. A built-in that ships broken is worse than none at
all, because the user assumes the platform's own starting point works and
debugs their data instead.

| Route | Purpose |
|---|---|
| `GET /rule-chain-templates` | `?scope=mine\|builtin`, `?category=`, search, sort. |
| `GET /rule-chain-templates/categories` | Built-in categories ∪ this tenant's. |
| `GET /rule-chain-templates/:id` | Definition + the same static analysis the editor shows. |
| `POST /rule-chain-templates` | `definition` **or** `fromRuleChainId` — not both. |
| `POST /rule-chain-templates/:id/instantiate` | **The "Use" button.** |
| `PUT` · `DELETE` · `GET /:id/export` | 403 on a built-in for the first two. |

Details that matter:

- **A new chain lands disabled** unless `instantiate` is passed
  `enabled: true`. A template can carry a placeholder endpoint or an id from
  whoever authored it. `importChain()` gained an `options.enabled` parameter
  for this; its own default is still off.
- **`setupNotes`** on a definition lists what the template could not guess — an
  endpoint URL, an email recipient. `instantiate` returns them and the editor
  shows them on the new chain. Without that, a template-built chain looks
  finished and quietly does nothing.
- **`fromRuleChainId` goes through `exportChain()`**, which is tenant-scoped, so
  a crafted id cannot capture another tenant's graph.
- **`tenantId` is `uuid` with an FK to `tenants(id)`**, because the entity
  declares `@ManyToOne('Tenant')` against it — a join column takes the
  referenced key's type and gets a real constraint whether a hand-written
  migration says so or not. Contrast `integration_events.tenantId`, which is
  correctly `character varying` *because it has no relation*. Getting this
  backwards leaves the migration permanently at odds with the schema
  `synchronize` builds. `userId` here is deliberately varchar with no FK: a
  template outlives whoever saved it.
- `migration:run` is blocked (§11), so apply this one with
  `npm run migration:rule-chain-templates <database> [up|down]`.
- `npm run verify:rule-templates <database>` exercises the whole flow against a
  real PostgreSQL — scoping, instantiate, edge rewriting, usage counting, the
  403s, capture-and-round-trip, and a real engine traversal proving a
  template-built switch routes down the branch it names.

### Still missing

`/queues` and `/default-rule-chains` have **no backend controller at all** — not
a wrong path, no module. The 13 frontend client methods for them were removed
rather than left looking available. Rule chains also have no authoring surface
for node-level debug output, and `rules.controller.ts` has no per-node test
route (only whole-chain). Templates have no preview of the graph as a canvas —
the editor lists the nodes and their routes instead.

## 4g. Multi-tenancy holes that were fixed (read this before touching a controller)

This section exists because the same bug was found **eight times** in one pass,
always in the same shape, and it will be written a ninth time by anyone who
does not know the rule.

### The rule

> **`RolesGuard` returns `true` when a handler has no `@Roles` metadata.**

An undecorated route is not "default deny" and it is not "inherit from the
class". It is open to every authenticated account on the platform, including a
`CUSTOMER_USER` belonging to someone else's organisation. Combine that with a
service that resolves a row by id alone, and one tenant reads or destroys
another's data.

Every handler needs `@Roles(...)` or a composed decorator
(`@TenantOrCustomerAdmin()`, `@TenantAdminOnly()`), **and** the service beneath
it needs a tenant predicate. Neither alone is sufficient: the guard does not
know which row is being touched, and the service does not know who is asking
unless it is told.

Two further details, both of which bit:

- **`SUPER_ADMIN` has no bypass in `RolesGuard`**, despite what
  `access-control.decorator.ts` says. List it explicitly on every route it
  should reach.
- **A falsy `tenantId` must deny, not skip.** The pattern
  `if (user.tenantId) qb.andWhere('tenantId = :tenantId')` leaves the query
  *unscoped* for a non-super-admin whose `tenantId` is missing. Only
  `SUPER_ADMIN` is legitimately tenant-less, and that case returns earlier.

Answer **404, not 403**, for a row outside the caller's scope. A 403 confirms
the id exists, which turns any detail route into an enumeration oracle.

### What was actually found, and where

| Where | What it meant |
|---|---|
| `TelemetryService` — every read | **The worst one.** `getTimeSeries`, `getAggregated`, `getStatistics`, `findByDevice`, `getLatest`, `getCountByDevice`, `exportToCSV` and `deleteByDevice` all resolved the device with `findOne({ where: { id } })` and accepted a `userId` they ignored — one even carried a comment claiming it used the tenant id. Any authenticated user could read, export or **delete** any tenant's telemetry given a device id. Fixed by `resolveDeviceForUser()`; asserted by `npm run verify:telemetry-scoping`. |
| `TenantsController` | `@Roles` on one route out of nine. List, create, update, activate, suspend and **delete** were open to everyone — a customer user could delete every organisation on the platform. |
| `EmailTemplatesService` | The entity had `tenantId` and a `UNIQUE (tenantId, type)` index from the start; the service used neither. The first tenant to save a `password_reset` template owned the password-reset email **every other tenant** sent — and the uniqueness check then refused everyone else a template of their own. Now resolves a tenant override first, falling back to the system template (`tenantId IS NULL`). |
| `NotificationsController` | `bulk/tenant/:tenantId` and `bulk/customer/:customerId` took the target from the URL unchecked, with no `@Roles`. Any user could notify every user of any tenant — a phishing channel wearing this platform's branding. |
| `CustomersController` | `@Delete(':id')` and `@Post()` undecorated. Any authenticated user could delete a customer and its users. (`remove()` is still a **hard** delete of both — see §11.) |
| `UsersService.findOne` + `GET /users/:id` | Unscoped lookup, undecorated handler: any user readable by id, across tenants. `findOneScoped()` is now the controller-facing method; the unscoped one is documented as internal-only. |
| `DevicesService.applyAccessFilter` | Skipped the tenant predicate entirely when `user.tenantId` was falsy. |
| `SubscriptionsController` / `PaymentsController` | No `@Roles` anywhere: cancellation and plan changes open to `CUSTOMER_USER`, invoice history readable by anyone, and the two routes commented "TODO: Add AdminGuard" open across all tenants. |

### Related: three remote code execution holes

User-authored JavaScript was being run through bare **`new Function()`**, which
compiles into the **host realm** — so the script saw this process's globals and
`process.mainModule.require('child_process')` was two hops away. All three
sources are rows a TENANT_ADMIN can write through the API, so "edit an asset
profile" and "edit a rule chain" were both equivalent to "run code as the
server".

| File | Now |
|---|---|
| `profiles/asset-profiles.service.ts` | Calculated-field formulas: identifier denylist + `vm.runInNewContext` + 50 ms budget + JSON-cloned primitives. A formula is arithmetic, not a program, so it is held to the stricter rule. `npm run check:expression-sandbox` |
| `nodes/filter-node.ts` | `@common/utils/script-sandbox` (vm2, matching `ScriptsService.runInSandbox`). `npm run check:node-sandbox` |
| `nodes/transformation-node.ts` | Same helper. |

**`@common/utils/script-sandbox.ts` is the only place user JS should ever be
executed.** Everything funnels through `runUserScript()` so the configuration
cannot drift between call sites — and so the eventual move off vm2 is a change
to one function.

Be honest about what that buys: **vm2 is a JavaScript-level sandbox with a
history of critical escape CVEs**, not a security boundary. It is enormously
better than `new Function`, and it is what `ScriptsService` already used
correctly. The durable answer for untrusted code is a separate V8 isolate
(`isolated-vm`) or an out-of-process worker with hard CPU and memory caps.

---

## 4h. Swagger, SWC, and the boot crash that only happens in the container

`SwaggerModule.createDocument()` is the last thing `bootstrap()` does. When it
throws, every module logs "dependencies initialized" and the process then exits
**1** — so a container crash-loops with a stack trace that points into
`@nestjs/swagger` and names a property but never the DTO it belongs to.

### The rule

> An enum on a **`@Query()` or `@Param()`** needs `enumName`, always.

```ts
@ApiParam({ name: 'entityType', enum: GroupEntityType, enumName: 'GroupEntityType' })
@ApiPropertyOptional({ enum: ConverterDirection, enumName: 'ConverterDirection' })
```

Without `enumName`, `SchemaObjectFactory.createFromModel()` skips its
`createEnumParam()` branch, falls through to `createQueryOrParamSchema()`, finds
`param.type` holding the enum **object**, and — since a TypeScript enum is a
plain object — `isObjectLiteral()` is true, so Swagger walks the enum's members
as if they were DTO properties. The message you get is:

```
A circular dependency has been detected (property key: "DEVICE")
```

There is no circular dependency. "DEVICE" is the first member of the enum.

### Why it reproduces only in the image

**`dist` is built by SWC, and SWC emits different `design:type` metadata than
tsc**: for `entityType: GroupEntityType`, tsc reduces a string enum to `String`
while SWC keeps a reference to the enum object. So the same code builds a
Swagger document perfectly under `ts-node` and crashes in the container.

`npm run check:swagger` therefore builds `dist` first and probes **that** — it
registers all 53 controllers into one bare module with stubbed dependencies
(no database, no Kafka) and calls `createDocument`, in about a second. Pass
`src` as an argument to compare the two compilers.

Two things that make this easy to get wrong a second time:

- **Describing controllers one at a time is not equivalent.** `createDocument`
  accumulates one `schemas` map across the whole app, so the check builds a
  single document, exactly as `bootstrap()` does.
- **`enumName` means something completely different on a TypeORM column.**
  `@Column({ type: 'enum', enum: X, enumName: 'X' })` names the **Postgres enum
  type**, so adding it there is a schema change that makes every generated
  migration want to rename a type. Only `@Api*` decorators take it.

Immediate mitigation if this ever fires in production again: `ENABLE_SWAGGER=false`
starts the app without building the document (it already defaults off when
`NODE_ENV=production`).

---

## 4i. Resource assignment — the reads, and the two-tier rule

`AssignmentModule` shipped with `assignResourceToCustomer`,
`assignResourceToUser` and their two unassign counterparts — permission gates,
quota gates and counter maintenance across ten junction tables — and **no GET
route at all**. So a tenant admin could grant a device to a customer and then
had no way to see or revoke what they had granted, and the frontend had no
screen because there was nothing to render.

Three reads were added:

| Route | Role | Returns |
|---|---|---|
| `GET /assignments/customer/:customerId` | `@TenantAdminOnly()` | Everything the customer holds, grouped by resource type |
| `GET /assignments/user/:userId` | `@CustomerAdminOnly()` | Everything that user holds, same shape |
| `GET /assignments/assignable/:resourceType?customerId=&userId=&search=` | `@CustomerAdminOnly()` | What could still be granted |

### Assignment is two-tier, and the picker has to know it

A resource reaches a USER only through their CUSTOMER:
`assignResourceToUser` refuses anything the customer does not already hold. So
`listAssignableResources(..., { userId })` is bounded by that user's customer,
not by the tenant. Offering the whole tenant would be a picker full of options
the server rejects, which teaches operators to distrust the UI. The panel says
this in words on both screens, because a picker that silently offers less than
the tenant owns looks broken unless you explain why.

### Details worth keeping

- **Table and column names come only from the constant maps**
  (`RESOURCE_SOURCES`, `CUSTOMER_JUNCTIONS`, `USER_JUNCTIONS`), never from the
  request. `resourceType` arrives from a URL segment; interpolating it into SQL
  would be an injection point with ten tables behind it.
- **`loadCustomerForRead` is separate from `loadAndVerifyCustomer`.** The
  latter refuses an *inactive* customer — correct when granting, wrong when
  reading or revoking: suspending a customer must not strip the admin's ability
  to see or take back what it holds.
- **Reads join to the resource table**, so names come back rather than bare
  uuids, and soft-deleted rows drop out of both lists.
- **Scoped to the caller's tenant in both directions**; an id from another
  tenant answers 404 (§4g).
- The picker is capped at 100 rows; `search` is how you reach the rest.
- `npm run verify:resource-assignments <db>` — 20 checks against real
  PostgreSQL, including the two-tier bound and both isolation directions.

### Both directions, and which one the UI uses

The customer-first routes above answer "what does this customer hold?". The
question people actually ask is the reverse — "who holds THIS device?" —
because you are looking at a device list and want to hand one over. Three
more routes serve that direction:

| Route | Role | Purpose |
|---|---|---|
| `GET /assignments/resource/:resourceType/:resourceId` | `@TenantOrCustomerAdmin()` | Who holds one resource |
| `POST /assignments/holders/:resourceType` | `@TenantOrCustomerAdmin()` | Holders for a page of rows — **two queries, not 2N** |
| `POST /assignments/{customer,user}/bulk[-unassign]` | admin per level | Many resources, one target |

- **`holders/:resourceType` is a POST** because a page of 50 uuids does not
  belong in a query string. The alternative — a GET per row — is what makes
  an "Assigned to" column get removed again a week later.
- **Bulk is sequential and NOT transactional.** Every grant runs the
  permission gate, the quota gate and two counter updates, so in a selection
  of 40 the 31st can legitimately be the one that exceeds the allocation.
  Rolling back the 30 that worked would be worse than reporting them:
  `{requested, succeeded[], failed[{resourceId, reason}]}` is both the truth
  and the answer that says what to change. Sequential because each grant
  read-modify-writes the same customer's `usageCounters` and the tenant's
  subscription `usage`; running them concurrently races those pairs and
  leaves the counters under the real number, which then lets the next
  assignment past a quota it should have failed.
- `assertKnownResourceType()` guards every route that interpolates
  `resourceType` into a table name. The constant maps are the only source of
  those names, but an unknown key yields `undefined` and a SQL syntax error
  rather than a clean 400.

### Frontend

`src/features/assignments/` holds both directions.

**Customer-first** — `ResourceAssignmentPanel` takes either `customerId` or
`userId`, mounted as an **"Assigned resources"** tab on `CustomerDetailsPage`
and `CustomerUserDetailsPage`. It is **read-only by default**
(`allowAssign={false}`): granting happens on the resource, and five Assign
buttons on a customer page were both redundant and the wrong way round.
Revoking stays, because a list you cannot correct is a dead end.

**Resource-first** — `useResourceAssignmentColumn(type, ids)` is the whole kit
in one hook: the "Assigned to" column, the per-row action, the bulk-toolbar
action and the dialog. Wiring a list page is four guarded insertions; see
`DevicesPage.tsx` as the reference. Wired into devices, dashboards, assets,
floor plans and automations.

- `useAssignmentCapability()` is the single place the role rule lives:
  tenant admin → assigns to **customers**; customer admin → assigns to
  **users under their own customer**; customer_user → nothing, and the column
  and action do not render. Hiding them is cosmetic; `@Roles` is the
  enforcement.
- The dialog passes `enabled` to `useCustomers` rather than ignoring the
  result, because `GET /customers` is tenant-admin-only and a customer admin
  would otherwise take a 403 on every mount.
- Single-row assignment goes through the **bulk** route too, so one row and
  forty rows report failures with the same reason string.
- Mutations invalidate the whole `assignments` query key rather than a
  surgical subset: granting to a customer changes what their *users* may be
  given, and the holder columns on every open list are now stale too.
- `BulkSelectionToolbar` / `BulkActions` gained an `extraActions` slot so
  assignment could plug into the shared bulk bar instead of forking it.

---

## 4j. Sidebar information architecture and role gating

Two facts about `src/components/layout/Sidebar.tsx` that are easy to get wrong:

1. **Hiding a nav item is cosmetic.** The route guard and the server's
   `@Roles` are the enforcement. An entry absent from the sidebar is still
   reachable by typing the URL; that is fine, because the API refuses. But an
   operator-only screen in every user's sidebar is still a bug.
2. **Two independent filters run**, and both must pass: `item.feature` against
   the subscription's feature flags, and `item.roles` against `user.role`.
   Before this round only three items had `roles`, so all four roles saw
   essentially the same menu and only the backend differentiated.

The role matrix now applied (verified by rendering each role against a mocked
API rather than by reading the source):

| Role | Top-level entries |
|---|---|
| `super_admin` | **Tenants** + all 23 others |
| `tenant_admin` | The same 23, no Tenants |
| `customer` | Overview, Solution Dashboards, Objects, Reports, Floor Plans, Alerts, Analytics, Users & Roles, Automation, Schedule Management, Notifications, Sharing Center, Settings |
| `customer_user` | Overview, Solution Dashboards, Objects, Floor Plans, Alerts, Analytics, Notifications, Settings |

`SUPER_ADMIN` must be listed explicitly everywhere — the frontend filter has no
bypass for it, matching `RolesGuard` (§4g).

### What moved, and why

- **Integrations** lost six entries: `MQTT Integration` and `Decoder Config`
  (features of an integration, not sections), `API Logs` and `API Statistics`
  (they belong to API Monitoring, which already has both), and `Add Converter`
  and `Test Data Converter` (screens *within* the converter flow). Four of the
  six used a raw English string as their `titleKey`, so they had never been
  translated in either language — a reliable sign an entry was added without
  being thought about.
- **Payload codecs** moved from Rule Engine to Integrations. A codec decodes a
  device payload on ingestion; it is not a rule-engine node and no rule chain
  references one.
- **Reports** moved to immediately below Firmware & OTA.
- **Settings** became a parent: *General settings* (`/settings`) and *Email
  templates* (`/settings/email-templates`, admin-only). Email templates had a
  working tenant-scoped backend (§4g) and no way in from the menu.

---

## 4k. `@RequirePermissions` coverage — why grants used to do nothing

The reported symptom was "permissions I assign to a customer or user don't
apply". The cause is the §4g shape again, one guard along:

> **`PermissionGuard` returns `true` when a handler has no `@RequirePermissions`
> metadata**, and the metadata is read from the **handler only** —
> `reflector.get(PERMISSIONS_KEY, context.getHandler())`. A class-level
> decorator is silently ignored.

Measured before the fix: **24 of 676 handlers** carried the decorator, in
**2 of 50 controllers** (firmware and roles). So granting a customer
`devices:read` changed nothing — no route ever asked. The permission table,
the seeded roles, the customer-grant junction and the whole resolution
pipeline were all correct and all unreachable.

`scripts/add-require-permissions.py` added 150 decorators across the eight
resource controllers a CUSTOMER or CUSTOMER_USER actually touches: devices,
dashboards, assets, alarms (`alerts`), automation, floor-plans, reports,
analytics. Re-runnable and idempotent — it skips a handler that already has
one.

Things the classifier has to get right, each of which was wrong on the first
pass and visible only by reading the printed plan:

| Route | Wrong | Right | Why |
|---|---|---|---|
| `GET /dashboards/shared` | `dashboards:share` | `dashboards:list` | `share` is the right to GRANT access; this is a list of what others shared with you |
| `DELETE /:id/widgets/:widgetId` | `dashboards:delete` | `dashboards:update` | removing a widget edits the dashboard, it does not delete it |
| `DELETE /assets/:id/devices/:deviceId` | `assets:delete` | `assets:update` | same shape |
| `POST /devices/bulk/status` | `devices:create` | `devices:update` | a bulk state change creates nothing |

Device actuation maps to **`devices:control`**, not `devices:update`: a viewer
may legitimately read a device without being allowed to switch it on.

Only strings the permission seeder actually creates are used. A permission
string that is never seeded can never be granted, so it would be a permanent
403 that looks like a bug in the guard. The seeded vocabulary is
`devices {control,create,delete,list,read,update}`,
`dashboards {…,share}`, `assets`, `alerts`, `automations`, `floor_plans`,
`reports {create,export,list,read,schedule}`,
`analytics {configure,create,export,read}`.

**Effective permissions = (role ∪ direct) ∩ customer grants, minus anything
the subscription plan disables.** It is an intersection, so a customer grant
cannot widen a user's role and a role cannot exceed what the customer holds.
`npm run verify:permissions <db>` asserts all three directions plus the
admin bypasses.

**Watch for this when enabling it on a fresh deployment:** TENANT_ADMIN and
SUPER_ADMIN return early and are unaffected, but a CUSTOMER_USER whose
customer has **no** `grantedPermissions` rows now gets 403 where they
previously got everything. That is the intended behaviour and also a visible
change — grant the customer its permissions before turning this loose on a
live tenant.

**A permission string that is not seeded is a permanent 403.** It can never
be granted to anyone, and the failure looks like a bug in the guard rather
than a typo in a decorator — `tsc` sees only a string literal.
`npm run check:permissions` reads both sides from source and fails on any
mismatch. It caught `analytics:create` on three routes within a minute of
being written: `analytics` seeds only `read`, `export` and `configure`.

Note `reports` has **no `update` action** in the seeder, so editing a report
template is gated on `reports:create`. That is the codemod refusing to emit
an unseeded string rather than a classification error — adding the action
means a seeder change plus a backfill for existing databases.

Coverage today is **174 of 680 handlers (25.6%)**, reported by the same
script. The remaining controllers are undecorated and therefore still open to
any authenticated account. That is the remaining work, and it is the reason
this section exists rather than a line in §11.

---

## 4l. AI integration

A registered-model registry plus an `ai_request` rule node, modelled on
ThingsBoard 4.2's design because the mental model transfers.

```
ai_provider.catalogue.ts   (manifest per provider: label, fields[],
     │                      supportsSchemalessJson)
     ├── GET /ai/catalogue       → the settings form is GENERATED from this
     └── assertRequiredFields()  → 400 naming every missing field at once

AiModel (tenantId, provider, modelId, apiKeyEncrypted, generation params)
     ↓ modelId (a uuid, NOT a credential)
ai_request node  ──→ AiService.complete()  ──→ callProvider()
AiInsightsService ──┘
```

### The credential never lives in the rule node

A rule chain is exportable, importable into another tenant, and shareable as
a template (§4f). An API key in the node's `configuration` jsonb would travel
with every one of those. The node stores a uuid; `AiService` resolves it
tenant-scoped at call time, so an exported chain carries a dangling reference
rather than a live key. **The tenant comes from the message, never from the
node configuration**, so a crafted chain cannot name another tenant's model.

### Credentials at rest

`@common/utils/secret-box.ts` — AES-256-**GCM**, format `v1:iv:tag:ciphertext`,
version-prefixed so the scheme can rotate. GCM because it is authenticated: a
tampered row fails to decrypt instead of yielding plausible garbage that gets
sent to a provider as a key. Key from `CREDENTIALS_ENCRYPTION_KEY` (32 bytes
hex/base64, or any passphrase, which is SHA-256'd).

With **no key set** it degrades to a reversible marker and warns once, rather
than refusing to boot — and `isEncrypted()` returns false for those values so
a UI can be honest about it. Set the variable in production.

This is the pattern `integrations.configuration` should adopt: that column
holds cloud credentials in **plaintext jsonb** with only `select: false` in
front of them.

### Two traps this hit, both invisible to `tsc`

1. **A value import of `TelemetryService` in `AiInsightsService` closed a
   module-load cycle** back through `NotificationsService` — a TDZ error at
   import time, which in a container is a crash-loop. `check:swagger` caught
   it as "Cannot access 'NotificationsService' before initialization". Fixed
   with a **type-only** import plus `ModuleRef` resolution in `onModuleInit`,
   and `AiModule` does **not** import `TelemetryModule`. Reimplementing the
   telemetry reads instead would have lost `resolveDeviceForUser`'s tenant
   scoping — the mistake the Tuya path already made once (§4d).
2. **`ModuleRef.get('TelemetryService')` needs that string token to exist.**
   Providers are registered under the *class* by default, so the lookup
   typechecks perfectly and throws at `onModuleInit`. `TelemetryModule` now
   also registers `{ provide: 'TelemetryService', useExisting: TelemetryService }`
   and exports it. `npm run check:ai-wiring` builds the real DI graph and
   calls `init()` — this is the only guard that would have caught it.

### Behaviour worth knowing

- **No retries, deliberately.** A chain that silently retries an LLM call
  three times is three times the bill for a message the operator believes
  failed once. Timeout (1–600s) and every provider error route to `failure`;
  put a retry on that edge if you want one.
- **Response normalisation** follows ThingsBoard: a JSON **object** becomes
  the message data; anything else — prose, or a valid non-object JSON value
  such as an array — is wrapped as `{ response: … }`. Markdown fences are
  stripped first, because models emit them even when told not to.
  `outputKey` is an addition: replacing the data throws away the reading that
  prompted the call, which is usually what the next node needs.
- **Templating**: `$[*]` all data, `$[key]` one field, `${*}` all metadata,
  `${key}` one metadata field. A **missing key renders empty**, never the
  literal `$[foo]` — a placeholder that reaches a model as text is read as an
  instruction, and models will invent a value for it.
- **Anthropic has no schemaless JSON mode.** The catalogue flags it and the
  service refuses `responseFormat: 'JSON'` for those providers up front
  rather than letting it fail as apparent model misbehaviour.
- `provider` is **varchar, not a PG enum** — see the integrations lesson in
  §4e. Providers appear faster than migrations ship.

### AI insights (`POST /ai/insights/device/:deviceId`)

Descriptive statistics are computed **in code** — min/max/mean/stdDev/change,
plus a 3σ outlier count — and the model is asked to interpret them. Handing an
LLM 10,000 raw readings and asking for the mean is slow, expensive and wrong.

**It does not forecast, on purpose.** Trendz does Prophet/ARIMA with models
persisted and retrained per profile; this has none of that, and an LLM asked
to predict a number will produce a confident one with nothing behind it. The
system prompt forbids it and the response schema has no forecast field —
giving it nowhere to put one is the reliable half of that.

### Scripts

```bash
npm run verify:permissions  <db>   # grants actually decide access (§4k)
npm run verify:ai           <db>   # crypto, templating, normalisation, scoping
npm run check:ai-wiring            # the DI graph resolves — no database
npm run migration:ai-models <db> [up|down]
```

---

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

# Telemetry lifecycle (see §4h). The defaults are deliberately conservative:
# nothing is deleted for a tenant whose plan does not state a retention.
TELEMETRY_RETENTION_ENABLED=true
TELEMETRY_RETENTION_FALLBACK_DAYS=0   # 0 = SKIP a tenant whose plan says nothing
TELEMETRY_RETENTION_MIN_DAYS=1        # floor; below it a tenant is refused, not swept
TELEMETRY_RETENTION_BATCH_SIZE=5000
TELEMETRY_RETENTION_MAX_BATCHES=200   # per tenant per run
TELEMETRY_ROLLUP_ENABLED=true
TELEMETRY_ROLLUP_RETENTION_FACTOR=12  # day/week/month kept retentionDays × this
TELEMETRY_ROLLUP_MAX_BUCKETS=168
TELEMETRY_ROLLUP_BACKFILL_DAYS=7
TELEMETRY_ROLLUP_KEY_LIMIT=50
TELEMETRY_ROLLUP_READ_MIN_RANGE_DAYS=2
TELEMETRY_ROLLUP_ACTIVE_LOOKBACK_HOURS=48

# Alarms
ALARM_PROPAGATION_MAX_DEPTH=10        # ceiling on the asset-tree walk

# Subscriptions
SUBSCRIPTION_GRACE_PERIOD_DAYS=3      # paid plan survives a failed renewal this long

# Reports
REPORT_SCHEDULER_ENABLED=true         # set false on all but ONE instance:
                                      # the tick has no distributed lock

# Transports (see §4i)
SNMP_ENABLED=true                     # false => no poller, no timer, no sockets
SNMP_REFRESH_SECONDS=60
SNMP_MAX_DEVICES=500
LWM2M_LIFETIME_GRACE_SECONDS=30
LWM2M_EXPIRY_SWEEP_SECONDS=15
GATEWAY_RPC_LISTENER_ENABLED=true     # false => every two-way RPC times out

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

# ── Guard scripts: no database needed, each asserts something tsc cannot ────
npm run check:integrations        # the integration catalogue is self-consistent
npm run check:rule-nodes          # every node type has a manifest and sane routes
npm run check:rule-templates      # every built-in template is instantiable as shipped
npm run check:expression-sandbox  # calculated-field formulas cannot reach the host
npm run check:node-sandbox        # rule-node scripts cannot reach the host
npm run check:swagger             # the Swagger document builds from dist (see §4h)
                                  #   — builds dist first; this is the only check
                                  #     that covers bootstrap()
npm run check:permissions         # every @RequirePermissions string is seeded,
                                  #   and reports decorator coverage (§4k)
npm run check:ai-wiring           # the AI DI graph resolves; catches the
                                  #   string-token and recursion traps (§4l)
node scripts/check-exception-filter.js   # field-level errors reach the client

# ── Verification: each needs its own empty database (createdb first) ────────
# These exercise real repositories, real SQL and real transactions. The app
# itself cannot be booted without Kafka (§11), so the services are wired by
# hand inside each script.
npm run verify:rule-templates      <db>
npm run verify:data-converters     <db>
npm run verify:telemetry-retention <db>
npm run verify:telemetry-scoping   <db>   # cross-tenant telemetry access — see §4g
npm run verify:profile-alarms      <db>
npm run verify:bulk-operations     <db>
npm run verify:subscriptions       <db>
npm run verify:reports-groups-queues <db>
npm run verify:snmp                <db>
npm run verify:lwm2m               <db>
npm run verify:rpc                 <db>
npm run verify:resource-assignments <db>  # assignment reads — scoping + the
                                          #   two-tier customer→user bound (§4i)
npm run verify:permissions         <db>   # grants/revocations decide access (§4k)
npm run verify:ai                  <db>   # credential crypto, prompt templating,
                                          #   response normalisation, scoping (§4l)

# ── Migrations: `migration:run` is blocked by the drift in §11, so each new
#    migration ships with a standalone runner that applies it in isolation ───
npm run migration:integration-centre     <db> [up|down]
npm run migration:rule-chain-templates   <db> [up|down]
npm run migration:data-converters        <db> [up|down]
npm run migration:telemetry-rollups      <db> [up|down]
npm run migration:reports-groups-queues  <db> [up|down]
npm run migration:ai-models              <db> [up|down]
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
| ~~`src/modules/attributes/attributes.service.ts`~~ | **RESOLVED** — `getTimeseries()` is implemented. |
| ~~`src/modules/api-monitoring/api-monitoring.service.ts`~~ | **RESOLVED** — real health probes. |
| ~~`src/modules/images/images.service.ts`~~ | **RESOLVED** — local-disk storage and delete are implemented. |
| `src/modules/images/images.controller.ts` line 46 | File upload to persistent storage (S3/local) is TODO |
| `src/modules/alarms/alarms.consumer.ts` line 359 | SMS notification integration (Twilio/AWS SNS) is a TODO stub |
| `src/modules/payments/payments.service.ts` | Stripe is installed as a dependency but Moyasar is the active provider; Stripe integration is not wired |
| `src/modules/protocols/adapters/ble.adapter.ts` | BLE adapter has placeholder implementation |
| `src/modules/protocols/adapters/coap.adapter.ts` | Implemented (ThingsBoard-style telemetry/attributes/rpc over UDP 5683). Remaining TODO: two-way server-side RPC dispatch (currently only acknowledges device-initiated RPC). |
| `src/modules/devices/codecs/milesight/ds/ds3604.codec.ts` | Binary image payload decode not implemented |
| ~~`src/modules/rules/rule-engine.service.ts`~~ | **RESOLVED** — 258 lines, a complete traversal engine. See §4f. |
| `KafkaModule` / the Kafka consumers | An unreachable broker stops the app booting: the module factory awaits `initProducer()`, and a consumer's failed `connect()` becomes an unhandled rejection that kills the process. Running locally therefore needs the full Docker stack. |
| `src/modules/integrations/` — `notification` and `database` types | Declared in the catalogue with `hasAdapter: false`; they are skipped by the dispatcher rather than forwarding anything. Use a webhook or Kafka instead. |
| ~~`src/modules/integrations/` — converters~~ | **RESOLVED** — `ConvertersModule` exists; the `codec` converter type delegates to `CodecRegistryService` rather than reimplementing decoding. See §4. |
| Frontend: groups and default rule chains | The backend modules, API clients and hooks are complete and verified, but **no screen was built** for either (`src/features/groups/` and `src/features/default-rule-chains/` contain services, hooks and — for default rule chains — a `ResolvePanel`, with no page). They are therefore unrouted. Everything else in this round is reachable from the sidebar. |
| Frontend: bulk operations | The shared machinery (`src/features/bulk/`) is complete and wired into the **devices** and **users** list pages. **Customers and notifications are not wired yet**, though their backend routes exist and are verified. |
| Frontend: subscription lifecycle | `GET /subscriptions/lifecycle`, `trial`, `renew` and `auto-renew` exist and are verified; the billing screens have **not** been updated to use them. |
| `payments.paymentIntentId` | Holds the **invoice** id while Moyasar's refund endpoint is `/payments/{payment_id}/refund`. `metadata.moyasarPaymentId` is now captured off the paid invoice and preferred, but the fallback to the invoice id cannot be verified without live credentials. |
| `auth.service.ts:789` | Calls `getOrCreateFreeSubscription(user.id)` with a **user id** where a tenant id is expected — `subscriptions.tenantId` has an FK to `tenants(id)`, so this 500s. The same bug was fixed in `payments.service.ts`; this call site was outside that change. |
| `CustomersService.remove()` | **Hard**-deletes the customer *and* its user accounts (`repository.remove`, with the `softRemove` line commented out) — irreversible data loss from one API call. The authorization hole in front of it is fixed (§4g); the delete semantics are not, because switching to a soft delete makes the unique `name`/`email` permanently unavailable for re-creation, which is a product decision rather than a bug fix. |
| `TelemetryService.exportToCSV()` | Does not quote fields, so a device named `Lobby, North` shifts every later column on that row. |
| `WidgetRenderer.tsx` (frontend) | Calls `useState` **inside** a conditional branch after early returns — a hooks-order violation that throws when a widget's classification changes. |
| `src/services/api/analytics.api.ts` (frontend) | Declares six routes that do not exist on `AnalyticsController`; all 404 at runtime. |

### Structural Notes
- The `src/migrations/` directory (at `src/` root, separate from `src/database/migrations/`) exists but is also empty
- `__pycache__/` and `extract_api*.py` files exist at project root — likely leftover from a Python API extraction script; not part of the application
- `assignment-safety-triggers.sql` at project root — SQL triggers for assignment safety checks; status of application to DB is unknown
- `src/modules/gateway/` is a thin HTTP wrapper; the main ingestion path is via `ProtocolsModule/HTTPAdapter`
- `dist/modules/alarms/index.html` and `dist/modules/dashboards/smartlife-dashboard.html` are static HTML files in the dist directory — unclear if these are intentionally served or build artifacts
