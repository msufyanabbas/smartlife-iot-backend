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
| `ReportsModule` | Report templates and real generation (CSV / JSON / PDF / **XLSX**, via `exceljs`) as a declarative query over `TelemetryService`, `AnalyticsService`, alarms, devices and the audit log, plus a cron scheduler that emails a summary **and attaches the generated file** while it fits under `MAIL_MAX_ATTACHMENT_BYTES` (default 10 MB), falling back to the download link above that. `ReportFormat` is a `varchar` column on both entities, so adding a format needs no migration |
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
- `type` (varchar): `building | vehicle | shop | farm | warehouse | hospital | hotel | factory | custom`
  (`AssetProfileType`). Varchar rather than a PG enum so new types need no DB migration.
  **This is the only source of an asset's type** — see "An asset's type is its
  profile's type" below.
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

### An asset's type is its profile's type

There used to be two answers. `assets.type` is a PG enum
(`building | floor | room | office | vehicle | equipment | infrastructure | zone | other`,
`AssetType`) and `asset_profiles.type` is a varchar (`AssetProfileType`); the two share
only `building` and `vehicle`, and nothing said which won. So a warehouse asset was
`infrastructure` or `other` to its own column and `warehouse` to its profile, and
`assetSceneFamily.ts` in the frontend picked the 3D context scene from the profile when
there was one and **keyword-matched the free text when there wasn't** — same asset, two
types, scene depending on which read ran.

`AssetProfile.type` is now the single source. The rules:

- **Read it as `assetType`.** `Asset.resolveAssetType()` returns
  `assetProfile?.type ?? null`, and `AssetsService.withAssetType()` materialises it onto
  the non-column `Asset.assetType` on every read path (`findOne`, `findAll`,
  `getRootAssets`, `getChildren`). `GET /assets/:id/floors` carries `assetType` (and
  `assetProfileType`, the same value under its old name).
- **`null` is a real answer.** No profile, or a profile whose own `type` is NULL, means
  the asset has no type. Nothing defaults it to `custom` — a guessed `custom` would be
  indistinguishable from a profile that really is custom.
- **Floor plans inherit.** `FloorPlansService.projectAsset()` is the single projection
  used by `findOneEnriched`, `getAssetFloorPlansOverview` and `get3DSimulationData`;
  `findOne`, `findByAsset` and `assertAsset` all load `asset.assetProfile` for it. The
  free-text `type` is **gone from the floor-plan asset projection** — a plan reports
  `assetType`, `assetProfileType`, `assetProfileId`. A plan whose asset has no profile
  reports `assetType: null` and otherwise behaves identically (lists, parses, exports);
  the viewer resolves `null` to its pre-existing `ground` scene.
- **`?type=` and `?sortBy=type` resolve through the profile**, so the query vocabulary is
  `AssetProfileType`, not `AssetType`. `?untyped=true` lists the assets with no
  resolvable type. `GET /assets/statistics`'s `byType` is keyed by `AssetProfileType`
  plus an `unassigned` bucket.
- **`Asset.type` is deprecated, not dropped.** Live rows hold the only record of the
  original operator classification, `AnalyticsService.getAssetPerformance()` still groups
  by it, and the vocabularies cannot be mapped — so a "synced" column would be a third
  source of truth. The column is marked with a `COMMENT ON COLUMN`, writes to it are
  **ignored with a warning** (`AssetsService.stripDeprecatedType()`, kept on the DTO
  because `forbidNonWhitelisted: true` would 400 every older client), and its values
  never change again. The `@Index(['tenantId','type'])` on it is now dead weight; it is
  left in place because dropping it is a separate, non-urgent migration.
- `AssetTypeFromProfile1788700000000` backfills the other side — making sure assets HAVE
  a profile. Eight branches, two of which write; it never retypes an asset whose profile
  already answers, and leaves ambiguous cases alone and reported rather than guessing.
  `npm run migration:asset-type-inheritance <db> plan` prints the per-branch counts and
  the unresolved rows; `up`/`down` apply and revert it (`down()` restores
  `assetProfileId` from `additionalInfo._assetTypeBackfill`). Asserted by
  `npm run verify:asset-type-inheritance <db>`.
- A trap fixed on the way: **`PATCH /assets/:id` with a new `assetProfileId` never moved
  an asset that already had a profile.** `findOne()` joins `assetProfile`, and
  `repository.save()` gives the loaded relation object precedence over a changed FK — so
  `Object.assign` set the column and the UPDATE wrote the old id straight back.
  `update()` now `delete`s the stale relation when the FK changes. Without that fix an
  asset's type could never be corrected.

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

Note the ordering against the **asset** profile's calculated fields, which run at
`TelemetryConsumer` **step 0** and merge their results into `payload.data` before
persistence (§11). Both alarm engines read `payload.data` at step 2, so an alarm rule
can name a calculated field as its `key` — and both normalise the ThingsBoard
`{ts, values:{…}}` envelope the same way, deliberately, so "the same key" means the
same thing to both features.

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
| `POST /integrations/lorawan/ttn` | The Things Stack v3 webhook (snake_case envelope). Also records `metadata.lorawanDeviceId` from `end_device_ids.device_id`, which is what the DOWNLINK path addresses — see below. |
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

### LoRaWAN downlink (ChirpStack and TTN)

`LorawanDownlinkService` queues a downlink through the network server's own
REST API, with the credentials on that integration's `configuration`. Reached
from `GatewayService.sendCommand()` — so the queued command path
(`DeviceCommandsConsumer`) and `POST /gateway/devices/:deviceKey/command` both
work on a LoRaWAN device — via `ModuleRef.get('LorawanDownlinkService')`, not an
import: `GatewayModule` ← `ProtocolsModule` ← `IntegrationsModule` already
closes a loop, and a module load cycle here crashes `bootstrap()`.

| | ChirpStack | The Things Stack |
|---|---|---|
| Endpoint | `POST {serverUrl}/api/devices/{devEUI}/queue` | `POST {base}/api/v3/as/applications/{appId}/devices/{deviceId}/down/{push\|replace}` |
| Auth header | **`Grpc-Metadata-Authorization`** — a token in plain `Authorization` is ignored and answers 401, because the REST surface is a grpc-gateway transcoding | `Authorization: Bearer` |
| Body | v4 `{queueItem:{devEui,…}}`, v3 `{deviceQueueItem:{devEUI,…}}` — the key *and* the EUI casing changed between majors, so `apiVersion` is declared, not sniffed | `{downlinks:[{frm_payload,f_port,confirmed,priority}]}` |
| Addressed by | DevEUI | the console **`device_id`**, captured from the uplink into `metadata.lorawanDeviceId`. There is no API mapping one to the other, so a device that has never reported cannot be reached |

Four things worth knowing:

- **A downlink is QUEUED, not sent.** A Class A device — almost every battery
  LoRaWAN sensor — can only receive in the two windows after an uplink it chose
  to send, so the network server holds the frame until then. HTTP 200 means
  "accepted into the queue", which may be seconds or most of a day before
  transmission. Nothing in this platform claims otherwise.
- **`hasAdapter: true`, `direction: inbound`** on both manifests, exactly like
  Tuya. `hasAdapter` records that an adapter exists; the telemetry fan-out reads
  `isDispatchableType()` = outbound AND hasAdapter, and platform telemetry must
  never be POSTed at a network server's queue endpoint — that would fail ten
  times and quarantine the row, which is how working Tuya integrations used to
  switch themselves off (above).
- **Before this, both protocols published to `milesight/downlink/<devEUI>` on
  this platform's own broker**, which no ChirpStack or TTN deployment
  subscribes to. The publish succeeded, the command row went DELIVERED, and
  nothing reached the device.
- **Not implemented:** ChirpStack's `ack` event and TTN's
  `downlink_ack`/`downlink_failed` are not consumed, so a queued downlink's
  terminal fate is not recorded; and neither queue is read or flushed, so a
  device offline for a week accumulates stale downlinks at its network server.

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
- An unreachable **Kafka broker used to stop the application booting**:
  `KafkaModule`'s factory awaited `initProducer()`, and a consumer's failed
  `connect()` surfaced as an unhandled rejection that killed the process. **Fixed
  — see §11a.** The connect is now a background retry loop, so the app boots
  without a broker and attaches when one appears; `KAFKA_ENABLED=false` skips it
  entirely. The `kafka` outbound adapter above is unaffected either way: it
  pools its own producers per broker set and does not use `KafkaService`.

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

### Coverage, and the tenant-admin bypass

Coverage is now **~89% of handlers**, up from 25.6%, via three codemod passes
(`scripts/add-require-permissions.py`, re-runnable and idempotent) plus 37
newly seeded permission strings across five new resources: `telemetry`,
`audit`, `edge`, `notifications`, `profiles`, later joined by `integrations`
and `groups`.

What remains undecorated is `@Public` (auth, health, OTA, the EMQX webhooks)
or self-service 2FA, where a permission grant is not the right gate.

**Two guard defects were fixed at the same time, and both mattered more than
coverage:**

1. **Class-level metadata was ignored.** The guard read
   `reflector.get(PERMISSIONS_KEY, context.getHandler())` — handler only — so
   a class-level `@RequirePermissions()`, the natural way to protect a whole
   controller in one line, silently did nothing. It now uses
   `getAllAndOverride([handler, class])`, matching `RolesGuard`.

2. **`TENANT_ADMIN` returned true unconditionally.** Permissions assigned to a
   tenant admin were discarded with no indication anywhere: the grant saved,
   the UI showed it, the guard never asked. Restricting an admin to
   `devices:read` produced an admin who could still delete every tenant.

   `users.enforcePermissions` (migration `1788200000000`) is the per-user
   opt-in that makes such a grant real. It defaults to **false**, so enabling
   the feature cannot retroactively lock out existing administrators;
   switching it on routes the account through exactly the same resolution as
   a customer user. **SUPER_ADMIN ignores it** — an account that can revoke
   its own access to the platform it administers has no way back in.

### A trap when changing this guard

`scripts/verify-permissions.ts` builds a fake `Reflector`. It used to stub
`getAllAndOverride = () => false`, which was correct while only `@Public` went
through that method. Routing permissions through it too turned the stub into a
mock answering "nothing required" for every route, so the guard allowed
everything and all four denial assertions failed — a failure that looks exactly
like a broken guard and is actually a stale test double. The mock is now
key-aware and honours handler-over-class precedence.

Run it against a real database; it is the only check that proves grants decide
access:

```bash
createdb permcheck && npm run verify:permissions permcheck   # 15 checks
npm run check:permissions                                    # no database
```

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

## 4m. The CAD drawing standard, and what it does to the 3D model

Transcribed from two reference DXFs the client supplied —
`CAD_Standards_Master_Template.dxf` (sections 1-11: line weights, linetypes,
text heights, sheet sizes, scales, layer naming, numbering, symbol legend,
practice rules) and `CAD_Standards_Drawing_Library.dxf` (LIB-01..05: wall
types, materials, columns, doors, windows, lifts, ramps, stairs in plan,
stair design rules, 3D modelling rules).

`src/modules/cad-standards/` holds it as a declarative catalogue, the same
shape as `integration-catalogue.ts` and `rule-node-catalogue.ts`. The
importer, the mesh builder, the compliance report and the frontend legend
all read that one table.

### The rule that drives everything

Every layer declares a `solid` behaviour:

| | meaning |
|---|---|
| `build` | becomes geometry |
| `void` | becomes an **opening cut into the host wall** — doors, windows |
| `ignore` | contributes nothing; **the space stays empty** |

That is the generalisation of "if the standard says X is empty space, the 3D
model must show empty space there". A plan is full of geometry that is DRAWN
but is not THERE, and every bit of it extrudes perfectly happily:

- `G-GRID` — setting-out lines spanning the whole plan
- `G-ANNO-DIMS` — dimension strings and witness lines
- `A-AREA-IDEN` — room tags (letterforms are closed polylines, so the word
  "OFFICE" becomes a solid object)
- `A-WALL-PATT` / `A-COLS-PATT` — the hatch *inside* an element drawn on
  another layer, which would duplicate it as a second solid
- `A-WALL-DEMO` — a wall being torn out
- `A-FLOR-STRS-ABOV`, `S-BEAM`, `A-CLNG` — above the 1200 cut plane
- `Defpoints`, `G-ANNO-NPLT` — never plot at all

`scripts/verify-cad-standards.ts` proves the end-to-end effect: a plan of 11
line segments — 4 real walls plus a grid line, a dimension string, a wall
hatch, a demolished partition, a beam, a hidden line and an undocumented
layer — builds **4 walls**, not 11. With `enforceCadStandard: false` it
builds all 11, which is what the importer did before.

### Layer names carry the answer

NCS / ISO 13567 is `Discipline-Major-Minor-Status`, e.g. `E-LITE-CIRC-NEWW`.
`ncs-layer.ts` parses it, and two details bite:

- **`FA` must be tried before `F`**, or `FA-DEVC` parses as fire *protection*
  discipline `F` with major `A`.
- **A trailing status is not a minor group.** `A-WALL-DEMO` is a wall with
  status DEMO, not a wall of type DEMO.

Status overrides the catalogue: `-DEMO` and `-FUTR` are excluded even on a
layer that normally builds, because each models a building that is never
real at any single moment. `-EXST` still builds — it is staying.

Linetype is a secondary signal: the standard reserves dashed for "hidden /
ABOVE cut", so a dashed line on a solid layer is excluded.

### Classification is a cascade, and unknown means excluded

`exact` → `major-group` (so `A-WALL-ANYTHING` is still a wall) → `discipline`
(an unrecognised `T-`/`E-`/`M-` layer is some service, and services are never
building fabric) → `unknown`. An unknown layer is **excluded, not guessed**:
a wrong solid is harder to notice than a missing one. `keepUnrecognisedLayers`
overrides it.

### What it fixed in the existing importer

`DxfFloorPlanParser` matched layers with loose regexes. `/^a-flor/i` sat in
`ROOM_LAYERS`, so **`A-FLOR-STRS` (a stair) and `A-FLOR-HRAL` (a handrail)
were both being read as rooms**, while `STAIR_LAYERS`' `/^a-str/i` never
matched either. The standard is now consulted first and the regexes remain
as the fallback for drawings that follow no standard — the Arabic and
European layer names in particular.

### Routes

| Route | Purpose |
|---|---|
| `GET /cad-standards` | The whole standard (`@Public` — a published convention, not tenant data) |
| `GET /cad-standards/classify?layer=&linetype=` | One layer's verdict |
| `POST /cad-standards/validate` | Compliance report for a drawing's layer list |
| `POST /cad-standards/check-stair` | Riser/going/2R+G/pitch against LIB-04 |

The compliance report scores by **entity count, not layer count** — a drawing
with one unrecognised layer holding 90% of the geometry is not 95%
compliant — and every unrecognised layer comes back with a suggested
standard replacement.

### Gotchas

- `CadStandardsService` is instantiated directly in two places
  (`parsers/cad-standard.bridge.ts`, `mesh/cad-standard.filter.ts`) rather
  than injected. `DxfFloorPlanParser` is a static class with no DI and the
  mesh factory is a pure function; the service is a pure function over a
  constant table with no repositories and no state, so this duplicates
  nothing. Re-implementing the matching in either place is how two copies
  drift apart.
- The `void` behaviour must NOT be dropped by the mesh pre-filter — the
  factory is what turns a door into an opening. `CATEGORY_ACCEPTS` is what
  keeps voids alive through the filter.
- `VIEWPORTS` is not an NCS name but both reference drawings use it; it is
  AutoCAD's own layout-viewport layer and is catalogued so it does not show
  up as non-compliant in every single import.

```bash
npm run verify:cad-standards [library.dxf] [master.dxf]
```

---

## 4n. SCADA mimic diagrams

A symbol library, bindings from a symbol property to a live value, animation
driven by that value, an editor, and write-back. Before this, the word "SCADA"
appeared nowhere in either repo.

```
scada-symbol.catalogue.ts   (36 symbols: inline SVG body + named STATES +
     │                       which data-part each state drives + which
     │                       properties are bindable + connection PORTS)
     ├── GET  /scada/symbols             → editor palette AND runtime renderer
     ├── validateScadaBinding()          → refuses a binding the symbol cannot honour
     └── applyScadaTransform()           → raw value → state / number / string

ScadaDiagram   (elements jsonb, connections jsonb, published, revision)
     ↓ element.bindings[]
{ property, source, deviceId, key, transform }
     ↓ mirrored on save
ScadaElementBinding  (flat rows, real FK to devices — the index jsonb cannot be)
```

### What makes it a mimic diagram and not a drawing

The floor-plan viewer colours device markers by online/offline. That is a map
with status dots. A mimic diagram is a schematic of the PROCESS whose symbols
are a FUNCTION of a live measurement: a pump impeller turns while its run
feedback is true, a tank's fill tracks a level transmitter, a trip blinks red,
flow animates along a pipe, and clicking an element can actuate plant.

Every one of those is declared in the catalogue, not coded per symbol:

| Field | What it buys |
|---|---|
| `svg` with `data-part="…"` | The parts a state may restyle, by id. |
| `states[].parts[part]` | `fill`, `stroke`, `opacity`, `spin` (deg/sec), `blink` (ms), `flow` (dash speed), `rotation`. |
| `level` / `levelSweep` | A 0–100 value either fills a rect or sweeps a needle. |
| `ports` | Connection anchors in SYMBOL space, so an endpoint follows its element's rotation and scale. |
| `bindable` | Which properties the editor may offer. |

`npm run check:scada` fails when a state names a `data-part` the SVG does not
contain, when `stateParts` and the states disagree, when a `level` band points
at a missing rect, or when a transform's arithmetic regresses. All of those are
symbols that save cleanly and then **sit still**, which on screen is
indistinguishable from a device that never reports — `tsc` sees only strings.

### Three things the diagram save has to get right

1. **It is one atomic write.** `elements` and `connections` are jsonb, and
   `PATCH /scada/diagrams/:id` REPLACES whichever of them it is sent (and
   leaves out the one it is not). Element and connection tables would turn one
   `UPDATE` into a transaction across three, where a partial failure leaves
   runs pointing at elements that were never inserted. Same choice, same
   reason, as `PUT /rule-chains/:id/metadata`.
2. **Device scoping has no foreign key to lean on.** A binding's `deviceId`
   lives inside jsonb, so nothing in the database stops a crafted payload
   pointing an element at another tenant's device and reading its telemetry
   through the runtime. `assertDevicesInTenant()` resolves the whole id set
   once and fails the save on a single unknown id. This is the load-bearing
   check in the module.
3. **`revision` is optimistic concurrency.** The editor holds the canvas in
   local state; `expectedRevision` turns a concurrent save into a 409 instead
   of a silent overwrite. On the frontend, `useScadaDiagram` must keep
   `refetchOnWindowFocus: false` and seed on `id + revision`, or tabbing away
   and back replaces unsaved work — the trap `useRuleChainMetadata` documents.

### Publishing refuses a diagram with errors

`validateDiagram()` is returned with every read and save, and `published: true`
is rejected while `errors` is non-empty. That is what the flag is for: an
element whose binding cannot resolve renders its DEFAULT state, and a pump
drawn stopped while it is running is the precise failure a mimic exists to
prevent. Warnings ("has 3 states and nothing bound to drive them") do not
block.

### Write-back, and the interlock

`POST /scada/diagrams/:id/elements/:elementId/action` names the DIAGRAM and the
ELEMENT, never the command. Method, params and target device are read from the
stored diagram, so the route cannot be used to send an arbitrary command to an
arbitrary device — a body of `{ deviceId, method }` would have made it a
general-purpose control endpoint wearing a diagram's name.

`action.enabledStates` is enforced **on the server**: `resolveLiveState()`
reads the element's own state binding against the latest telemetry and refuses
with 409 when it does not match. A greyed-out button is a hint, and a direct
request ignores hints. An unknown state counts as NOT enabled — an interlock
that fails open is not an interlock.

`CUSTOMER_USER` can reach this route on purpose: an operator is the person who
presses Start. What protects the plant is that the command is fixed by the
diagram, not that operators are locked out of their own HMI.

### Stale is not the same as stopped

Every binding may carry `staleAfterSeconds` and `staleState`. A reading older
than the threshold resolves to the stale state and the element is flagged in
the viewer. The transform returns `null` rather than a fallback for an
unresolvable value, specifically so a dead transmitter never leaves a pump
drawn green.

### The evaluator exists twice, deliberately

`applyScadaTransform()` (backend) and `applyTransform()` in
`features/scada/lib/resolveBindings.ts` are the same function. The runtime has
to resolve a value the instant a telemetry frame lands — a round trip per frame
per element is a request storm — and the server needs the same answer for the
interlock check. `POST /scada/symbols/evaluate` exposes the server's copy so
the two can be diffed rather than assumed equal, and both sides pin the cases
that are easy to get wrong: the STRINGS `'0'` and `'false'` are falsy, a
missing value yields `null`, and a zero-width linear range yields `outMin`.

### Frontend

`features/scada/` — `ScadaDiagramsPage` (list), `ScadaEditorPage`
(palette + canvas + properties + live preview), `ScadaViewerPage` (runtime),
and a canvas built from **plain SVG** rather than a flow library, for the same
reasons as the rule-chain canvas. The canvas is ONE component with
`mode="edit" | "run"`: the whole value of a mimic editor is that what you draw
is exactly what operators see, and a second renderer is a second set of
transform and ordering decisions whose differences only surface in production.

Animation is CSS, not React state. Spin, blink and dash-flow are continuous and
must keep running between frames; driving them from state would be a re-render
per element per frame. `transform-box: fill-box` is the load-bearing line —
without it every rotation is about the SVG origin and an impeller swings around
the corner of the sheet.

Canvas colours are literal hex. `styles/globals.css` defines its tokens as bare
HSL triplets with no `hsl()` wrapper, so `fill-background` emits
`fill: 0 0% 100%`, the browser discards it, and SVG falls back to BLACK.

### Routes

| Route | Purpose |
|---|---|
| `GET /scada/symbols` | The library. Readable by `CUSTOMER_USER` — the runtime needs it to render at all. |
| `POST /scada/symbols/evaluate` | Resolve a value through a transform. No write. |
| `GET /scada/diagrams` · `:id` | Summaries (no geometry) · full read with `issues` and the server-derived `subscriptions` set. |
| `POST` · `PATCH` · `DELETE /scada/diagrams[/:id]` | CRUD. |
| `POST /scada/diagrams/:id/duplicate` · `/publish` | Copy (always lands unpublished) · publish gate. |
| `GET /scada/diagrams/by-device/:deviceId` | Which diagrams reference a device — from the mirror table. Check before deleting a device. |
| `POST /scada/diagrams/:id/elements/:elementId/action` | Write-back, interlocked. |

```bash
npm run check:scada                      # catalogue consistency + evaluator
npm run migration:scada <database> [up|down]
```

The migration is `ScadaMimicDiagrams1788100000000`, applied with the standalone
runner because `migration:run` is blocked (§11). `up()` is idempotent.

---

## 4o. Device authentication — modelled for a year, enforced since today

`device_credentials` has supported ACCESS_TOKEN, MQTT_BASIC and
X509_CERTIFICATE since the schema was written, and `credentialsId` carries a
unique index the entity itself describes as "used for fast auth lookup".

**Nothing ever looked anything up.** Every ingest path resolved the device
with `findOne({ where: { deviceKey } })`. `DeviceCredentialsService.verify
Credentials()` existed, was correct, and had no caller anywhere in the
repository. The HTTP adapter stated the consequence in its own comment:
"Anyone who learns a deviceKey can post telemetry as that device."

A deviceKey is an IDENTIFIER. It is in URLs, MQTT topics, logs, the UI and
support tickets. Treating it as a secret meant the platform had no device
authentication at all while appearing to offer three kinds.

### The rule

> **Resolve the device FROM the credential. Never from the path, the topic or
> the body.**

That ordering is the whole defence. A valid token for device A must not become
a way to write as device B by editing a URL segment.

### Where it is enforced

| Path | Credential |
|---|---|
| `POST /v1/ingestion/:deviceKey` | `Authorization: Bearer`, `x-device-token`, or the path segment as a token (ThingsBoard's convention) |
| `POST /v1/ingestion/batch` | the CALLER authenticates; each entry carries its own token, or is bounded to the caller's tenant |
| CoAP `/api/v1/{token}/…` | the path segment is a real access token, not a deviceKey |
| MQTT | EMQX delegates authn **and** authz over HTTP — see below |
| LwM2M registration | endpoint name resolved as a token; `deviceId` pinned on the row |

`DeviceAuthService` (`src/modules/device-auth/`) is the single verifier. It
depends on **no other feature module** — it registers the `Device` and
`DeviceCredentials` repositories directly — because `DevicesModule` imports
`ProtocolsModule`, so the adapters could not import `DevicesModule` back.

Properties that are load bearing, each asserted by `npm run check:device-auth`:

- **Constant-time comparison.** The old code used `!==`, which returns on the
  first differing byte and leaks the matching prefix length. Both sides are
  SHA-256'd first so lengths cannot leak either.
- **Negative caching.** Telemetry is the highest-volume path here. Without
  caching failures, a flood of bad tokens becomes a flood of queries and
  authentication turns into an amplification vector.
- **Fails closed.** Any error denies.
- **Types are not interchangeable.** A valid MQTT_BASIC username is not a
  valid bearer token.

### MQTT: the delegation that pointed at nothing

The codebase said "MQTT auth lives in EMQX" and shipped an EMQX configured
with `EMQX_ALLOW_ANONYMOUS=false` and `EMQX_LOADED_PLUGINS=…`. **Both are
EMQX 4.x variables and are no-ops on 5.3**, and EMQX 5 with no authentication
chain allows everything. The variable read as a lockdown and set nothing.

`docker/emqx/emqx.conf` now delegates both decisions to
`/device-auth/mqtt/authn` and `/device-auth/mqtt/authz`, with
`no_match = deny`. **Authorization matters as much as authentication**: without
it, any device holding valid credentials could publish on every other device's
topic — the same forgery one level up.

One trap: `lib/mqtt/MQTTService` is the platform's own broker client. It is
not a device and has no credentials row, so enabling authn would deny the
platform its own connection and stop all MQTT ingestion. It is allowed
explicitly in `mqttAuthn()` as a superuser, and a blank `MQTT_PASSWORD` does
not become a bypass.

### Route order is load bearing

`@Post('batch')` MUST be declared before `@Post(':deviceId')`. Nest matches in
declaration order, so with the parameterised route first every batch request
was captured by the single-device handler with `deviceId: 'batch'` — the batch
endpoint was unreachable dead code and the authorization on it was decorative.
The guard asserts the ordering.

### Rolling it out

Enforcement defaults **ON** (`DEVICE_AUTH_ENFORCED`), which rejects any device
with no credentials row — on an existing deployment, all of them.

```bash
npm run backfill:device-credentials <db>            # dry run
npm run backfill:device-credentials <db> --apply    # issues + prints tokens ONCE
npm run check:device-auth                           # 33 checks, no database
```

The backfill never rotates an existing credential. `DEVICE_AUTH_ENFORCED=false`
is a documented migration aid that logs an error at boot and warns on every
bypass; it is not a supported running state.

### Still open

No DTLS for CoAP or LwM2M, so those tokens travel in clear over UDP and are
replayable by anyone on the path. That port belongs on a private APN or behind
a DTLS terminator. `POST /v1/ingestion/batch` still falls back to a same-tenant bound when an
entry carries no token of its own.

### The edge gateway path

Enforcing per-device authentication **broke the edge agent**, and the break is
worth recording because the instinct it provokes is the wrong one. The agent
forwards for many devices and holds none of their tokens — it was sending only
the platform-wide `x-api-key`, which identifies no one, so every forwarded
reading was rejected.

The answer is not to weaken device auth. It is to give the gateway an identity
and bound what that identity may speak for:

```
x-edge-key: <edgeKey>        the same pair the agent registers with
x-edge-secret: <edgeSecret>  stored server-side as SHA-256, select: false
```

`authenticateEdgeForDevice()` authorises the edge for a device only when
**`device.edgeId` is that edge AND the tenants match**. Both predicates are
required; either alone is bypassable. A presented-but-refused edge credential
returns null rather than falling through to the device-token paths, because in
edge mode the path segment is a deviceKey and trying it as a token is noise.

This is the gateway-to-child-device model the platform lacked.

---

## 4p. The audit log — comprehensive-looking, and recording nothing

The audit module had an entity with six composite indexes, a 526-line
controller with fourteen routes, role-based read scoping, CSV export,
statistics, eighteen `@OnEvent` handlers and a 533-line Kafka consumer. It
recorded **almost nothing**, and `tsc` could not see any of it, because the
absence of a decorator is silence rather than an error.

### Four independent defects, any one of which was sufficient

| Defect | Measured |
|---|---|
| **`@Audit()` on 3 of 56 controllers** | users, devices, customers — one handler each, out of ~700 routes. `AuditInterceptor` is a global `APP_INTERCEPTOR` that returns `next.handle()` untouched when a handler has no `AUDIT_KEY` metadata (the §4g/§4k default-open shape, a third time). So there was no CRUD audit for tenants, dashboards, rule chains, automations, integrations, subscriptions, payments, roles, permissions, groups, firmware, relations or SCADA diagrams. |
| **10 of 18 `@OnEvent` handlers had no emitter** | `grep "emit('<name>'"` returned 0 for `user.login`, `user.login.failed`, `user.logout`, `user.role.changed`, `device.created`, `device.updated`, `device.deleted`, `device.disconnected`, `device.command.sent`. **Authentication was not recorded at all.** |
| **The 8 handlers that DID fire wrote nothing either** | Worse than the above and not visible from a grep. `UsersService` emits `{ user }`, `AlarmsService` emits `{ alarm }`; every handler read `payload.tenantId`, got `undefined`, and `audit_logs.tenantId` is NOT NULL — so the INSERT threw. `EventEmitter2.emit()` discards the listener's promise, so it surfaced as an unhandled rejection, not an error anyone saw. |
| **No retention** | The only purge was the manual `DELETE /audit/cleanup/:daysOld`. The table grew at request rate, forever. |

Plus `src/database/seeds/audit-log/audit-log.seeder.ts`, which wrote
**fabricated** audit rows — logins that never happened, attributed to real
seeded users with real timestamps and IPs. In any other table demo data is a
convenience; in an audit log a row that did not happen destroys the table's
only property, and a reviewer cannot tell a seeded row from a real one.

### What it looks like now

- **~298 of 375 auditable write routes carry `@Audit()` (79.5%)**, across 46
  controllers, applied by `scripts/add-audit-decorators.py` — re-runnable and
  idempotent, same shape as `add-require-permissions.py`.
- **All 18 event handlers have an emitter.** Login, failed login (all three
  failure branches: bad password, inactive account, bad 2FA code), logout and
  role change come from `AuthService` / `UsersService`; the device events from
  `DevicesService` and `GatewayService.sendCommand()`. Self-registration emits
  `user.created` too — it writes its user row through its own repository, so it
  never went through `UsersService.create()`.
- **One guarded write path.** `AuditEventsService.record()` resolves `tenantId`
  from the entity when the emitter did not send one, drops (with a warning)
  rather than throws when there is no tenant, and swallows repository errors.
  An audit write must never fail the operation it describes.
- **`AUDIT_RETENTION_DAYS`** (default 365, `0` disables) with a daily
  03:30 cron in `AuditRetentionService`. It is a single idempotent
  `DELETE … WHERE timestamp < cutoff`, so it is **safe unlocked on N
  replicas** and needs no entry on the distributed-lock allow-list; the class
  comment says so, and says what would change that.
- **The seeder is gated** behind `SEED_DEMO_AUDIT_LOGS=true` and off by
  default.
- **`npm run check:audit-coverage`** (`scripts/check-audit-coverage.ts`)
  asserts all of it. The check that would have caught the original bug is
  "every `@OnEvent` audit handler has at least one emitter", and it searches
  every file in `src` **except** `audit-events.service.ts`, so a handler
  quoting its own event name in a comment cannot satisfy it.

### Rules worth knowing before you touch this

- **Reads are deliberately not audited.** Decorating GETs would grow
  `audit_logs` at full request rate — every dashboard poll, every telemetry
  page. Who read what is in `api_logs`, which has its own retention.
- **Telemetry ingest routes are excluded** for the same reason:
  `POST /telemetry/devices/:key` and `POST /gateway/devices/:key/telemetry`
  are hit once per sample per device.
- **One row per action.** Where an event covers an action, the HTTP route is
  **not** decorated — device and user single-entity CRUD, alarm
  create/acknowledge/clear/resolve, `POST /gateway/.../command`. The event is
  the one to keep because it also fires for the origins with no request behind
  them (a Tuya import, a telemetry-raised alarm, a queued downlink). Bulk
  routes keep their decorator: "an admin ran a bulk delete on 40 users" and 40
  per-user rows are different facts. Removing the pre-existing `@Audit()` from
  `POST /users` and `POST /devices` was part of this — they would now write two
  rows each.
- **`AuditEntityType` is a Postgres enum.** A new TypeScript member alone is
  not enough (§4e's `integrations.type` trap) and `migration:run` is blocked
  (§11), so the codemod emits only existing members. A resource with no
  dedicated member maps onto the closest one plus an explicit `description`
  naming the real resource — `SETTINGS` is the catch-all for roles,
  permissions, groups, templates and edge instances, and the description is
  what keeps the rows readable.
- **`GET /audit/modules/:module`** is a generic route backed by
  `AUDIT_MODULE_ENTITY_TYPES`, declared **after** the seven literal
  `modules/*` routes — Nest matches in declaration order, so a parameterised
  segment above them would capture `modules/users` (the §4o route-order trap).
  An unknown module answers **400 with the valid list**, never an empty page:
  an empty page is indistinguishable from "nothing happened".
- **`src/modules/audit/audit.consumer.ts` is deleted.** 533 lines, in no
  module's `providers`, subscribing to 25 `audit.*` topics — none of which is
  one of the two `KafkaService.createTopics()` creates, and nothing produced to
  any of them. It also wrote through a raw `pg.Pool`, bypassing TypeORM.
  Registering it would have made boot depend on a reachable broker (§11) for a
  path that would receive nothing.

### Still not covered

- `POST /auth/register` and the other `@Public` auth routes have no
  authenticated actor, so the interceptor skips them; registration is covered
  by the `user.created` emit instead, and password reset/email verification
  are not covered at all.
- `PATCH /auth/profile` has neither a decorator nor an event.
- `assets/`, `profiles/`, `floor-plans/`, `reports/` and `analytics/` were
  being edited in parallel and were left out of the codemod — ~40 write routes.
  Re-running `scripts/add-audit-decorators.py` with those paths added is the
  whole change.
- A failed login against an email matching **no account** has no tenant to
  scope a row to, so it is logged to the application log and dropped. It is
  still in `api_logs`. Attempts against real accounts — the credential-stuffing
  case — always resolve.

---

## 4q. Socket subscriptions — authenticated is not authorized

`WsJwtGuard` proves **who** is connected. Nothing proved **what** they were
allowed to watch. Every `@SubscribeMessage` handler in all three gateways took
an id off the wire and called `client.join('device:' + id)`:

| Gateway | Handlers |
|---|---|
| `/ws` | `device:subscribe`, `dashboard:subscribe`, `widget:subscribe`, `device:command` |
| `/alarms` | `subscribe:device`, `subscribe:customer` |
| `/telemetry` | `subscribe` |

So any authenticated account — including a customer user of another tenant —
could stream any tenant's live telemetry and alarms by naming a device uuid,
and the server logged it as an ordinary subscription. `dashboard:subscribe` and
`widget:subscribe` were worse: they took a whole `deviceIds[]` **array** from
the browser.

The check now lives in one place, `WsSubscriptionAuthorizer`
(`src/common/websocket/`), reached through `WsAuthorizationModule`. That module
holds **only** the Device repository: `WebsocketModule`, `AlarmsModule` and
`TelemetryModule` already import one another behind `forwardRef()`, and a
shared provider that pulled in `DevicesModule` would tighten that knot until
Nest could not resolve it.

Scoping rules, in order:
1. `SUPER_ADMIN` is cross-tenant by definition → allowed.
2. **Anyone else with no `tenantId` on their token → refused.** A missing claim
   is not a wildcard. This is the direction that fails closed, and it is the
   one that matters: the naive version builds `where: { tenantId: undefined }`,
   which TypeORM **drops from the query** — turning "scope me to nothing" into
   "return everything".
3. Otherwise the device must belong to the caller's tenant.
4. If the token carries a `customerId`, the device must also be assigned to
   that customer. Tenant isolation alone is not enough inside a tenant that
   has several customers.

Things that are load-bearing and easy to undo by accident:
- **A refusal answers "not found", never "not yours".** Confirming that another
  tenant's device exists is itself a leak.
- **Malformed ids are refused before the query.** `In(['not-a-uuid'])` reaches
  Postgres as a uuid comparison and raises `invalid input syntax for type
  uuid` — a 500 from a subscribe payload, and a crash loop if the widget
  retries.
- **A database error denies.** An authorizer that cannot answer must not answer
  "yes".
- **`subscribe-dashboard` scopes the devices it derives from the dashboard**,
  even though the dashboard read is already tenant-scoped. Widget configuration
  is arbitrary JSON written by tenant users, so a widget can name any uuid it
  likes; deriving the room list from the dashboard moves the forgery one level
  down rather than preventing it.
- **The claims it scopes by must actually arrive.** `WsJwtGuard` has to copy
  `customerId` onto `client.data`, and the signed access token has to carry it.
  If either stops, the customer narrowing does not fail — it silently stops
  applying, and every customer user regains tenant-wide visibility.
  `check:ws-authorization` pins both links.

Two further leaks found in the same files:
- `device:command` used `this.server.emit(...)`, which is a broadcast to
  **every** socket in the namespace — one tenant's `userId`, `tenantId`,
  `deviceId` and command delivered to every other tenant's browser. Nothing
  anywhere listened for `device:command:request`, so the broadcast was its only
  effect and the command reached no device.
- `/telemetry` had `cors: origin: '*'` and `get:subscriptions` had no guard at
  all.

`verify:ws-delivery` is the one to keep. It boots the real gateway on a real
HTTP server, connects two real socket.io clients with signed JWTs for two
tenants, and asserts that a push **arrives** at the subscriber, does **not**
arrive at the other tenant, **and still arrives at the first** — that third
assertion is there because scoping subscriptions is exactly the kind of fix
that makes a stream secure by making it dead.

---

## 4r. The verification suite was itself unverified

`scripts/` had never been typechecked. `tsconfig.json` included only
`src/**/*`, and most `verify:*` scripts run under `ts-node -T`
(transpile-only), so nothing checked them at build time or at run time.

The first `typecheck:scripts` run found **12 constructor arity mismatches
across 8 scripts**. The mechanism is always the same: a service gains a
dependency, every call site in `src` is corrected because `tsc` demands it, and
the script that constructs the same class by hand is not, because nothing was
looking.

Worth knowing exactly how bad one of them was. `verify-permissions.ts` built
`PermissionGuard` with 3 of 4 arguments, so `this.permissionCache` was
`undefined` and `canActivate()` threw on its first call. The script caught the
throw and returned `false`. The result was **asymmetric**:

- every *"is allowed"* assertion failed loudly — 3 of them
- every *"is denied"* assertion **passed, for the wrong reason**

A revoke test whose baseline is already "denied" proves nothing. The suite
reported 12 passes while testing nothing at all. **A guard that fails is noisy
and gets fixed; a guard that passes vacuously is worse than no guard, because
it is counted as evidence.**

Rules that follow from this:
- `typecheck:scripts` must be clean. It is the only thing standing between the
  suite and this recurring back into it.
- **Never cast the class away when hand-constructing a service.**
  `new (TelemetryService as any)(...)` is what let a *positional* shift through
  — `TelemetryLatestCacheService` was inserted as parameter 4 and pushed every
  later stub by one, so `rollupStub` landed in the AutomationService slot. Put
  the `any` on the stubs, not on the constructor.
- **A test double that always misses tests nothing.** Prefer
  `scripts/support/in-memory-redis.ts` — a real in-memory implementation with
  working TTLs and a monotonic `increment`, because the permission cache's
  correctness rests on its epoch scheme — over a Proxy that answers
  `undefined`.
- **Fixtures must survive a crashed run.** `tenants.name` is UNIQUE, and
  several scripts used fixed literals (`'Perm tenant'`, `'AI tenant 0'`). One
  run that died before cleanup left the row behind and made the script
  permanently unrunnable with a duplicate-key error that says nothing about
  what it verifies. Names now carry the run's uuid, and residue is swept first.
- **A cron body wrapped in `@DistributedCron` will not run in a script** unless
  a `DistributedLockService` has been constructed (it populates a static
  holder) — set `CLUSTER_LOCKS_ENABLED=false` so `withLock` runs the work
  inline and returns its real result. Otherwise the body is skipped and the
  assertions report the business logic as broken when it was never invoked.
- **Assert the negative control.** The watchdog check in
  `verify-cluster-locks.ts` originally used a 2s TTL with a 2.5s body, but
  `withLock` clamps the TTL up to `MIN_TTL_SECONDS` (5) — so the lock would
  have survived with no renewal whatsoever and the assertion proved nothing.
  Only the paired `renew: false` case revealed it.

---

## 4s. Nothing ran the application until something had broken it

The app would not boot, and every guard was green.

`TelemetryGateway` had been dead code: present in no module's `providers`, so
Nest never instantiated it, the `/telemetry` namespace did not exist, and its
`@OnEvent` handlers never ran. Registering it in `TelemetryModule` made it
real — and made its `@UseGuards(WsJwtGuard)` resolvable only in a module that
provides `JwtService`, which `TelemetryModule` did not:

```
Nest can't resolve dependencies of the WsJwtGuard (?, ConfigService).
Please make sure that the argument JwtService at index [0] is available
in the TelemetryModule context.
```

Why nothing caught it:
- `tsc` cannot see a DI graph. Both typecheck configs were clean.
- `npm run build` uses **SWC**, which does not typecheck — and this was not a
  type error in any case.
- `check:swagger` builds a `ProbeModule`, not the real `AppModule`.
- Every other guard reads source text or hand-constructs a service.

`npm run check:boot` closes it: build, start `node dist/main.js` against a
synchronised scratch schema, and wait for `GET /health` to answer 200. It has
been negative-tested — removing the fix reproduces the failure and the guard
names it.

Two things worth knowing if you run the app locally:

- **`DB_SYNCHRONIZE=true` is not enough to create the schema.** It is gated on
  `NODE_ENV === 'development'` *and* the flag, and a fresh database still came
  up empty. Booting against an empty database dies on an unhandled
  `relation "schedules" does not exist` from a startup query, which is a raw
  TypeORM error rather than anything that names the cause. `check:boot`
  synchronises the entity graph itself first.
- **The resolution order of fail-fast checks is a list of what a deployment
  cannot start without**, and it is longer than it looks: `JWT_REFRESH_SECRET`,
  `KAFKA_BROKERS` (**required by `env.validation` even when
  `KAFKA_ENABLED=false`** — worth fixing, since the point of that flag is
  running without Kafka), `OTA_PUBLIC_URL`/`BACKEND_URL`, `FRONTEND_URL` (must
  be an absolute URL), `MOYASAR_API_KEY`, and a clientID/secret for **each** of
  the Google, GitHub and Apple passport strategies, which construct eagerly and
  throw without one. `bootEnv()` in `scripts/check-boot.ts` is the executable
  record of that set, and it fails the moment the set grows.

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
Supports three methods (`TwoFactorMethod` enum): `authenticator` (TOTP via speakeasy), `sms` (delivered through `SmsChannel` — Twilio or AWS SNS, selected by `SMS_PROVIDER`; it previously `logger.warn()`ed the OTP to the server log and reported success, so every second factor the platform issued was recoverable from logs and no message was ever sent), `email` (sends OTP via MailService). When 2FA is enabled, login returns `{ requires2FA: true, userId, method }` instead of tokens. Client must call `POST /api/auth/oauth/verify-2fa` with the code to complete login.

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
# REDIS_HOST is REQUIRED — a localhost default meant a deploy with the variable
# missing would start, fail every cache read, and look like a Redis outage
# rather than a config mistake. Redis being DOWN, by contrast, no longer stops
# the boot: the connect is fire-and-forget and ioredis retries (see §11).
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0                            # RedisService + the cache-manager store
REDIS_QUEUE_DB=1                      # Bull. A SEPARATE logical database, or a
                                      #   cache flush drops queued jobs
REDIS_KEY_PREFIX=smartlife:           # RedisService's ioredis keyPrefix. The
                                      #   cache-manager store appends `cache:`
                                      #   to it, so the two cannot collide on
                                      #   db 0 — see §11
REDIS_TTL=3600                        # default cache-manager TTL, SECONDS
REDIS_CONNECT_TIMEOUT=10000
REDIS_COMMAND_TIMEOUT=5000
REDIS_RETRY_DELAY=1000                # ceiling on the reconnect backoff
REDIS_MAX_RETRIES=3
REDIS_READY_CHECK=true
REDIS_OFFLINE_QUEUE=true              # queue commands during a reconnect, so a
                                      #   blip does not surface as an error

# Caches (all Redis-backed; each states what invalidates it in its own class).
# Lower a TTL to narrow a staleness window; 0 disables that cache entirely and
# sends every request to Postgres.
PERMISSION_CACHE_ENABLED=true         # PermissionGuard's effective-permission
                                      #   set. Invalidated by a per-tenant
                                      #   epoch (one INCR) plus a global epoch
                                      #   for system roles — NOT by TTL alone
PERMISSION_CACHE_TTL_SECONDS=60
SUBSCRIPTION_CACHE_TTL_SECONDS=30     # SubscriptionGuard's row. BYPASSED on any
                                      #   route with @RequireSubscriptionLimit()
                                      #   — the row carries live quota counters
TELEMETRY_LATEST_CACHE_TTL=300        # GET /telemetry/:id/latest. Write-through
                                      #   from BOTH ingest paths

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
# ON by default — only an explicit false disables it, so a production deploy
# that forgets the variable still gets the ingestion pipeline. An unreachable
# broker no longer stops the boot (see §11); KAFKA_ENABLED=false is the
# supported way to work without the Docker stack at all.
KAFKA_ENABLED=true                    # false => no client is constructed, no
                                      #   consumer runs, every produce is a
                                      #   logged no-op (NOT a throw)
KAFKA_BROKERS=localhost:9093          # comma-separated; split properly
KAFKA_CLIENT_ID=smartlife-iot-platform
KAFKA_SSL=false
KAFKA_SASL_USERNAME=                  # SASL is configured only when BOTH
KAFKA_SASL_PASSWORD=                  #   halves are set
KAFKA_CONNECTION_TIMEOUT=10000
KAFKA_REQUEST_TIMEOUT=30000
KAFKA_INITIAL_RETRY_TIME=100
KAFKA_RETRIES=8
KAFKA_SESSION_TIMEOUT=30000
KAFKA_HEARTBEAT_INTERVAL=3000
KAFKA_TOPIC_PARTITIONS=3
KAFKA_TOPIC_REPLICATION_FACTOR=1      # a CLUSTER property — 1 means no replicas
KAFKA_BOOTSTRAP_MAX_BACKOFF_MS=60000  # ceiling on the background reconnect
KAFKA_CONSUMER_MAX_ATTEMPTS=3         # in-process retries per message before
                                      #   it is dead-lettered
KAFKA_CONSUMER_RETRY_BACKOFF_MS=250   # doubled each attempt
KAFKA_DLQ_SUFFIX=.dlq                 # fallback only; TOPIC_REGISTRY names
                                      #   each stream's DLQ explicitly
KAFKA_LAG_CACHE_SECONDS=15            # /health polling must not amplify into
                                      #   admin round trips
KAFKA_LAG_UNHEALTHY_THRESHOLD=10000   # total lag per group above which
                                      #   /health/messaging fails

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

# Audit
AUDIT_RETENTION_DAYS=365   # How long audit_logs rows are kept; 0 disables the
                           # sweep entirely (for a deployment shipping rows to
                           # an external SIEM). Much longer than the
                           # integration-event window on purpose — see §4p.
SEED_DEMO_AUDIT_LOGS=false # `npm run seed` writes NO audit rows unless this is
                           # exactly "true". Fabricated audit entries are worse
                           # than an empty table.

# SMS (NotificationChannel.SMS and `sms` 2FA both go through SmsChannel).
# Nothing is sent unless SMS_ENABLED is true, and a disabled or misconfigured
# channel THROWS — it never resolves successfully, which is what used to mark a
# notification delivered while nothing left the host.
SMS_ENABLED=false
SMS_PROVIDER=twilio                   # twilio | aws_sns
SMS_DEFAULT_REGION=SA                 # for libphonenumber-js; 0501234567 → +966501234567
SMS_TIMEOUT_MS=10000
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=                  # or TWILIO_MESSAGING_SERVICE_SID (preferred when both are set)
TWILIO_MESSAGING_SERVICE_SID=
AWS_SNS_REGION=                       # falls back to AWS_REGION
AWS_SNS_SENDER_ID=                    # omit in countries that reject sender IDs (the US)
AWS_SNS_SMS_TYPE=Transactional        # SNS defaults to Promotional, which carriers drop for OTPs

# Push (FCM for Android/iOS, Web Push for browsers). There is NO direct APNs
# transport — the `apn` package is not installed; iOS is relayed to APNs by
# Firebase. Device tokens live in `push_subscriptions`.
PUSH_ENABLED=false
PUSH_TTL_SECONDS=3600
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=                 # literal \n sequences are unescaped before PEM parsing
VAPID_PUBLIC_KEY=                     # npx web-push generate-vapid-keys
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=                        # mailto:… or https://… — browsers reject a JWT without it

# Modbus TCP/RTU polling. ON by default; only an explicit false disables it.
# Devices come from the `modbus_devices` table (Integrations → Modbus devices);
# MODBUS_DEVICES is a compatibility fallback read only when that table has no
# enabled rows. Polling is a per-process setInterval, so EVERY replica polls
# every device — set MODBUS_ENABLED=false on all but one.
MODBUS_ENABLED=true
MODBUS_DEVICES=                       # legacy JSON blob; see modbus.adapter.ts

# LwM2M registration lifetime tracking. Registrations are rows in
# `lwm2m_registrations` and are rehydrated on boot.
LWM2M_LIFETIME_GRACE_SECONDS=30
LWM2M_EXPIRY_SWEEP_SECONDS=15

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
REPORT_SCHEDULER_ENABLED=true         # blunt per-instance off switch. No longer
                                      # needed for correctness: the tick holds a
                                      # distributed lock (see §12)

# Transports (see §4i)
SNMP_ENABLED=true                     # false => no poller, no timer, no sockets
SNMP_REFRESH_SECONDS=60
SNMP_MAX_DEVICES=500
LWM2M_LIFETIME_GRACE_SECONDS=30
LWM2M_EXPIRY_SWEEP_SECONDS=15
GATEWAY_RPC_LISTENER_ENABLED=true     # false => every two-way RPC times out

# ── Running more than one replica (see §12) ────────────────────────────────
# Every one of these DEFAULTS to the multi-replica-safe value, so a scaled
# deploy needs no new configuration to be correct. They exist to be turned OFF
# for a broker or deployment that cannot support them.

# One replica runs each @Cron tick, claimed through a Redis lock.
# false => EVERY replica runs EVERY cron: duplicate report emails, N copies of
# each scheduled notification, scheduled automations firing device commands N
# times, billing sweeps racing. Only correct on a single process.
CLUSTER_LOCKS_ENABLED=true

# MQTT shared subscriptions: `$share/<group>/<topic>`, so the broker delivers
# each uplink to ONE replica instead of all of them.
# false => every replica persists every reading: the telemetry table, Kafka
# throughput and alarm evaluation all multiply by the replica count. EMQX 5
# supports this; a broker that does not will refuse the subscription.
MQTT_SHARED_SUBSCRIPTION=true
MQTT_SHARED_GROUP=smartlife-platform   # the consumer-pool identity. TWO
                                       # deployments on one broker MUST use
                                       # different groups or they steal each
                                       # other's uplinks

# Socket.IO Redis adapter, so `server.to(room).emit()` crosses replicas.
# false => a browser on replica A never receives a push produced on replica B.
WS_REDIS_ADAPTER_ENABLED=true
WS_REDIS_ADAPTER_KEY=smartlife-ws      # pub/sub channel prefix; two
                                       # deployments sharing one Redis MUST
                                       # differ or they cross-deliver emits

# Uploads. `local` is the current behaviour: bytes on the handling replica's
# disk. `s3` is a STUB and fails at boot (see §11).
STORAGE_DRIVER=local                   # local | s3 (stub)
STORAGE_LOCAL_SHARED=false             # set true ONLY if UPLOAD_PATH is on
                                       # genuinely shared storage (NFS/EFS, or
                                       # one Docker volume on one host). It
                                       # only silences the startup warning —
                                       # a wrong `true` turns a visible 404
                                       # into silent data loss

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
                                  #   — builds dist first. NOTE: it assembles a
                                  #     ProbeModule, NOT the real AppModule, so
                                  #     it does NOT resolve most feature
                                  #     modules' DI. It used to claim to cover
                                  #     bootstrap(); it does not. check:boot
                                  #     does.
npm run check:boot      [db]      # starts the REAL `node dist/main.js` against a
                                  #   synchronised scratch schema and waits for
                                  #   GET /health to answer 200. The only guard
                                  #   that resolves the whole DI graph.
                                  #   Catches: a gateway or guard whose module
                                  #   lacks a provider (see §4s), a module
                                  #   missing from an import graph, and a boot
                                  #   that Kafka or MQTT being down would block
                                  #   (§11a). Needs Postgres.
npm run check:permissions         # every @RequirePermissions string is seeded,
                                  #   and reports decorator coverage (§4k)
npm run check:ai-wiring           # the AI DI graph resolves; catches the
                                  #   string-token and recursion traps (§4l)
npm run check:cluster-safety      # every @Cron is locked or explicitly
                                  #   allow-listed as idempotent, MQTT uses
                                  #   $share/, the Socket.IO Redis adapter is
                                  #   wired, and the compose stack can scale
                                  #   (§12). THIS IS THE REGRESSION GATE: a new
                                  #   unlocked @Cron fails the build — as does
                                  #   an fs.writeFile reappearing in either
                                  #   floor-plan service (§11b)
npm run check:infra-wiring        # Kafka and Redis DEGRADE instead of failing
                                  #   the boot, every declared topic has a
                                  #   consumer or a written reason, every
                                  #   consumer rethrows so its DLQ is real, and
                                  #   every cache has an invalidation path
                                  #   (§11a)
npm run check:ws-authorization    # no @SubscribeMessage handler joins a
                                  #   device:/customer: room without asking
                                  #   the authorizer; the claims it scopes by
                                  #   are actually populated (§4q)
node scripts/check-exception-filter.js   # field-level errors reach the client

# ── Typechecking: three configs, and all three must be clean ───────────────
# tsconfig.json is the BUILD config and no longer includes tests, so
# `tsc --noEmit` is meaningful again. It previously reported ~98 permanent
# errors (`Cannot find name 'describe'`) that had to be filtered by eye, which
# is how a real error hides.
#
# tsconfig.scripts.json is the important one: scripts/ had NEVER been
# typechecked, and most verify scripts run under `ts-node -T`. The first run
# found 12 constructor arity mismatches across 8 scripts — see §4r.
npm run typecheck                 # src only — must be 0
npm run typecheck:tests           # adds jest globals — must be 0
npm run typecheck:scripts         # scripts/ + src — must be 0

# ── One command for the whole suite ────────────────────────────────────────
# Creates the scratch databases if missing (a fresh `verify:*` otherwise fails
# with `database "..." does not exist`, which reads as a broken guard rather
# than a missing database), runs every check:* and verify:*, and reports
# pass/fail/skip. An unavailable dependency is a SKIP, never a pass.
npm run verify:all                # everything
npm run verify:all -- --checks    # static guards only, no database needed
npm run verify:all -- --filter ws # only scripts matching "ws"

# ── Verification: each needs its own empty database (createdb first, or let
#    `verify:all` create them) ───────────────────────────────────────────────
# These exercise real repositories, real SQL and real transactions. The app
# now boots without Kafka (§11a), but these still wire the services by hand
# inside each script so they need no HTTP server or broker at all.
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
npm run verify:floor-plan-storage  <db>   # a real DXF through upload → parse →
                                          #   preview → generate → download,
                                          #   comparing BYTES; all four legacy
                                          #   reference shapes; the backfill (§11b)
npm run verify:ws-authorization    <db>   # a socket of tenant A cannot subscribe
                                          #   to tenant B's device; a customer
                                          #   user cannot reach a sibling
                                          #   customer; fails closed (§4q)
npm run verify:ws-delivery         <db>   # boots the REAL gateway on a real HTTP
                                          #   server and connects a real
                                          #   socket.io-client: a telemetry push
                                          #   ARRIVES at its own tenant and does
                                          #   not arrive anywhere else (§4q)
npm run verify:audit-write         <db>   # an emitted event becomes a ROW, with
                                          #   the nested `{ user: { tenantId } }`
                                          #   payload shape that wrote nothing
                                          #   for all 18 handlers (§4p)
npm run verify:cluster-locks              # needs REDIS, not Postgres. Mutual
                                          #   exclusion, release on throw, TTL
                                          #   expiry after a simulated crash,
                                          #   compare-and-delete, watchdog
                                          #   renewal, and that an unreachable
                                          #   Redis is counted and surfaced (§12)

# ── Migrations: `migration:run` is blocked by the drift in §11, so each new
#    migration ships with a standalone runner that applies it in isolation ───
npm run migration:integration-centre     <db> [up|down]
npm run migration:rule-chain-templates   <db> [up|down]
npm run migration:data-converters        <db> [up|down]
npm run migration:telemetry-rollups      <db> [up|down]
npm run migration:reports-groups-queues  <db> [up|down]
npm run migration:ai-models              <db> [up|down]
npm run migration:floor-plan-storage-keys <db> [up|down]
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
| ~~Six `@Cron` jobs fired on every replica~~ | **RESOLVED** — `RedisService.acquireLock()` existed with **zero callers** while the report scheduler, scheduled notifications, the scheduled-automation tick, the Tuya poll and two subscription sweeps all ran on every instance. `@DistributedCron` (`src/lib/cluster/`) now claims a Redis lock per tick; `DevicesService.checkOfflineDevices()` was locked too, because its bulk UPDATE is idempotent but the `device.offline` events it emits are not. See §12. |
| ~~MQTT had no shared subscription~~ | **RESOLVED** — `$share/<group>/` on every uplink filter, in both `MQTTService` and `IntegrationMqttInboundService`. This was the worst of the set: it duplicated the primary ingestion path. See §12. |
| ~~No Socket.IO Redis adapter~~ | **RESOLVED** — `@socket.io/redis-adapter` was a dependency and was never wired, so `server.to(room).emit()` reached only the emitting replica. `RedisIoAdapter` is registered in `main.ts`. See §12. |
| ~~`RpcCorrelatorService.pending` was per-process~~ | **RESOLVED** — a device reply landing on a different replica than the one holding the promise always timed out, which is (N-1)/N of every two-way RPC. Responses an instance does not own are relayed over the Redis channel `cluster:rpc:response` and settled by the owner. |
| `src/modules/analytics/analytics.service.ts` — `generateDailyAnalytics()` | **Not replica-safe.** Writes one `analytics` row per tenant per day with no uniqueness constraint, so N replicas write N rows and every historical series is multiplied by the replica count. Left untouched because `src/modules/analytics/` was owned by another work stream in the same round. It is the one `known-gap` entry in `scripts/check-cluster-safety.ts`, which prints it on every run. Fix: `@DistributedCron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'analytics-daily-rollup', lockTtl: 1800 })`. Until then, run it on one replica. |
| Uploads are still local-disk only | `src/lib/storage/` introduces the seam — a `StorageDriver` interface, a `local` driver that reproduces the previous behaviour exactly (including the `UPLOAD_PATH_IMAGES` / `FIRMWARE_STORAGE_DIR` / `UPLOAD_PATH_TEMPLATES` root overrides), and an `s3` driver that is an explicit stub throwing at construction. **Five of six call sites moved** (`images`, `firmware`, `solution-templates`, and now both floor-plan services — see §11b); only `reports/reports.service.ts` still calls `fs.writeFile` directly, because that directory is owned by another work stream. The `images` and `firmware` **read** paths (`FirmwareService` OTA download, `ImagesService.getPublicImageFile`) still stream from an absolute local path, so a remote driver needs those routed through `storage.get()` as well; the floor-plan read paths are done. `npm run check:cluster-safety` asserts the converted files and prints the remaining one on every run. |
| ~~`src/modules/alarms/alarms.consumer.ts` line 359~~ | **RESOLVED** — it already routed SMS through `NotificationsService`; the gap was `SmsChannel`, every provider call in which was commented out and which then returned success, so the notification row was marked **sent and delivered** while nothing left the host. Twilio and AWS SNS are now both wired (`SMS_PROVIDER=twilio\|aws_sns`), numbers are normalised to E.164 with `libphonenumber-js`, and every failure path throws so `markAsFailed()` runs. |
| ~~`src/modules/notifications/channels/push.channel.ts`~~ | **RESOLVED** — same silent-false-success shape (`sendToMultipleDevices()` set `success = deviceTokens.length` with no network call). FCM via `firebase-admin` (modular subpath imports; iOS is relayed to APNs by Firebase, as there is no `apn` package here) and Web Push via `web-push`. Device tokens live in the new `push_subscriptions` table, registered through `POST /push-subscriptions`; `NotificationsService.sendPush()` fans out to a user's devices when no token is given. |
| ~~`MODBUS_ENABLED` / `MODBUS_DEVICES`~~ | **RESOLVED** — `ModbusAdapter` defaults to **ON** (`MODBUS_ENABLED=false` disables) and reads `modbus_devices` rather than an environment JSON blob. CRUD at `/modbus/devices` with a register-map editor at `/modbus` in the frontend. The env blob is still read, but only when the table has no enabled rows. **Polling is still a per-process `setInterval`, so every replica polls every device** — run it on one replica until leader election exists; `GET /modbus/devices/status` reports that caveat. |
| ~~LwM2M registrations in memory~~ | **RESOLVED** — `lwm2m_registrations` is authoritative, rehydrated on boot, with the in-process maps kept only as a cache. `expireStaleRegistrations()` sweeps the table, so a registration made by another replica is expired too. Registration is also credential-checked through `DeviceAuthService`; there is still no DTLS, so the credential travels in clear over UDP. |
| `src/modules/payments/payments.service.ts` | Stripe is installed as a dependency but Moyasar is the active provider; Stripe integration is not wired |
| `src/modules/protocols/adapters/ble.adapter.ts` | BLE adapter has placeholder implementation |
| `src/modules/protocols/adapters/coap.adapter.ts` | Implemented (ThingsBoard-style telemetry/attributes/rpc over UDP 5683). Remaining TODO: two-way server-side RPC dispatch (currently only acknowledges device-initiated RPC). |
| `src/modules/devices/codecs/milesight/ds/ds3604.codec.ts` | Binary image payload decode not implemented |
| ~~`src/modules/rules/rule-engine.service.ts`~~ | **RESOLVED** — 258 lines, a complete traversal engine. See §4f. |
| ~~`KafkaModule` / the Kafka consumers~~ | **RESOLVED** — an unreachable broker no longer stops the boot, and the same shape of bug is fixed in `RedisModule`. See §11a. |
| `src/modules/audit/audit.consumer.ts` | Dead code: no `@Injectable()`, registered in no module, takes a raw `pg.Pool` with no DI token. It would read `audit.user.actions` / `audit.api.requests` / `audit.security.*` — and **nothing produces to any of them**; `AuditInterceptor` writes `audit_logs` rows directly and `ApiLoggingMiddleware` writes `api_logs`. The two declared topics are kept in `TOPIC_REGISTRY` with that reason recorded rather than deleted, because the decision is whether to finish the consumer or drop the topics. It also produces to `alarms.security`, which is declared nowhere. |
| `telemetry.device.processed`, `device.lifecycle.*`, `device.connectivity.*`, `alarms.*`, `rules.output`, `notifications.*` | Declared topics with **no producer and no consumer** — the platform carries all of these over EventEmitter2, Bull or in-process calls instead. Each carries its `reason` in `TOPIC_REGISTRY`, so `npm run check:infra-wiring` passes; they cost an empty topic on the broker and nothing else. Deleting them is safe but is a decision about whether Kafka is intended to carry these streams later. |
| `src/modules/profiles/profile-alarm.service.ts` | `evaluateProfileAlarmRules()` loads the device **with `relations: ['deviceProfile']` on every telemetry frame** — the strongest remaining caching candidate on the ingest path (a profile changes by hand, perhaps monthly). Not done here: `src/modules/profiles/` is owned elsewhere. The invalidation is a device-profile update and a device's `deviceProfileId` changing. |
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
| ~~`src/services/api/analytics.api.ts` (frontend)~~ | **RESOLVED** — it declared six routes `AnalyticsController` did not have. Two were re-pointed at the existing routes that already served the data (`/analytics/telemetry`, `/analytics/data-consumption`). The other four are now implemented: `POST /analytics/timeseries`, `GET /analytics/aggregate`, `POST /analytics/export` and `GET /analytics/realtime`. `timeseries` was the one that mattered — `dashboardService.loadTimeSeriesData()` and `useTimeSeries` both call it, so every timeseries dashboard widget was fetching a 404. The first three read through `TelemetryService.getMultiKeySeries()`, which keeps `resolveDeviceForUser()` as the single tenancy gate (§4g) and stays rollup-aware for raw reads; `AnalyticsService` reaches it with `ModuleRef.get('TelemetryService')` rather than importing `TelemetryModule`, so `AnalyticsModule` still imports no sibling feature module. The client's `exportData` also offered an `'EXCEL'` format no backend has ever produced; it is `'XLSX'` now, the spelling `ReportFormat` uses. A seventh method, `getAlarmAnalytics`, hit a route that *does* exist with `startTime`/`endTime` query keys it does not accept — a flat 400 under `forbidNonWhitelisted` — and now sends `?timeRange=`. |
| ~~`src/services/api/devices.api.ts` — `sendCommand` (frontend)~~ | **RESOLVED** — posted to `/devices/:id/command`, which does not exist (the control routes moved to `GatewayController` to break a DevicesModule ↔ GatewayModule cycle). TWO things were wrong: the path AND the body — the DTO field is `method`, so `{ command }` would have been stripped by the global `ValidationPipe` and 400'd even once the path was right. Now `POST /gateway/devices/:deviceKey/command`, with `sendCommandByDeviceId()` resolving the key for the many call sites that hold only a uuid. Every dashboard Switch, Slider and action button 404'd behind a "Failed to send command" toast; the Slider and the action panel never called the API at all and only toasted success. |
| ~~Two-way RPC had no UI caller~~ | **RESOLVED** — `POST /gateway/devices/:deviceKey/rpc` was complete server-side (correlator, MQTT reply listener, timeout, history row) and `devicesApi.sendRpc()` existed with **nothing calling it**. There is now an **RPC tab** on the device detail page: `features/device-commands/components/SendRpcPanel.tsx` (method, JSON params, timeout, wait/no-wait) plus `useSendDeviceRpc`, showing the device's response or the timeout and the `durationMs`. Its own tab next to Control, not inside the queued-command panel, because the two downlink paths mean different things — the queue can only ever report "published to broker", while an RPC reports what the device answered. The panel renders `responseListenerConnected: false` as a banner: with no gateway subscription on the response topic every RPC times out regardless of the device, and without saying so the reader blames the device. |
| ~~Calculated fields never saw telemetry~~ | **RESOLVED** — `AssetProfilesService.calculateFields()` was a real sandboxed evaluator whose only caller was `POST /profiles/asset/:id/calculate`, which takes the inputs **in the request body** and stores nothing: a calculator you typed numbers into, not a derived series. `CalculatedFieldsService` (`src/modules/telemetry/`) now evaluates a device's asset profile's calculated fields against each arriving reading plus the device's and asset's attributes, and `TelemetryConsumer` merges the results into `payload.data` at **step 0, before persistence** — so a derived value charts (`data->>key`), alarms (both engines run on `payload.data` at step 2), triggers automations and reaches integrations with no change to any of those paths. It calls into `AssetProfilesService` rather than copying the sandbox; the only change there is a `computeCalculatedFields(profile, …)` entry point so a cached profile can be passed in. A field whose name collides with a key the device reported is **discarded, not applied** — a formula must never overwrite a measurement. Two bounded TTL caches (plan 60s, attributes 30s, 5,000 entries each) keep this off the per-message query path. Limits: a device with no `assetId` has nothing to compute, fields cannot reference each other, and a `null` (failed expression) is not stored. |
| ~~`src/services/websocket/wsClient.ts` (frontend)~~ | **RESOLVED** — the socket was broken end to end. It called `io(SOCKET_URL)` with **no namespace**, joining the Socket.IO default `/`, where none of the three gateways is registered (`/ws`, `/alarms`, `telemetry`); Socket.IO does not fall back, so every emit was dropped and no server event could arrive. The event names were wrong independently: it emitted `subscribe-telemetry` / `get-device-telemetry` / `subscribe-alarms` (no handler exists for any of them) and listened for `telemetry:update` / `alarm:update` (nothing emits either). Fixing one without the other would still have produced silence. Now `/ws` with `device:subscribe` / `device:telemetry`, plus a second socket on `/alarms` for the seven real lifecycle events — that namespace is also the only one that joins a `tenant:` room, which is why `WebsocketGateway`'s own `alarm:new` broadcast reaches nobody. `useLiveTelemetry` had been hiding all of it behind REST polling. |

### 11a. Kafka and Redis degradation — the properties, and the guard

`npm run check:infra-wiring` (106 checks, `scripts/check-infra-wiring.ts`)
asserts everything below. It is a source-reading guard like
`check-device-auth`, because `tsc` cannot see any of it and a test would need
a broker, Redis and a database.

**Neither Kafka nor Redis can stop the boot.** Both module factories used to
`await` a connect. A rejected provider factory makes Nest abort the whole DI
graph and exit — before `app.listen()`, so there was no HTTP server, no
`/health`, and nothing in the logs naming the cause. `DeviceCommandsConsumer`
had a second route to the same outcome: its `onModuleInit` awaited
`createConsumer()` with no try/catch, so a failed `connect()` was an unhandled
rejection. Now:

- `KafkaService.bootstrap()` returns `void` and the connect, `createTopics()`
  and every consumer attach run in a background loop with capped exponential
  backoff (`KAFKA_BOOTSTRAP_MAX_BACKOFF_MS`). A broker that comes up ten
  minutes later needs no restart; a consumer registered while it was down
  attaches by itself.
- `RedisService.connect()` returns `void` and ioredis owns the reconnect.

**A produce that cannot be queued fails loudly, per message.**
`sendMessage()` throws `KafkaUnavailableError` rather than buffering into a
producer that will never flush. `DeviceListenerService` catches it, logs
`TELEMETRY DROPPED` naming the device, and **does not rethrow** —
`handleTelemetry()` has ~20 callers, several of them polled adapters on bare
timers where a rejection becomes an unhandled rejection. Refused produces are
counted and surfaced as `kafka.refusedProduces` on `GET /health/messaging`,
because "telemetry stopped arriving" and "telemetry is arriving and being
thrown away" look identical on a dashboard and need different responses.

**`KAFKA_ENABLED=false` is a real mode.** No client is constructed, no
consumer runs, every produce is a logged no-op (not a throw — "there is no
broker here" is a different statement from "the broker is down"), and the
health indicator reports healthy, so an orchestrator does not restart the pod
forever.

**Topics are a registry, not a list.** `TOPIC_REGISTRY` in
`kafka.service.ts` pairs each of the 23 topics with the consumer group that
reads it, its dead-letter topic, or a written reason why nothing consumes it.
The guard fails on an unconsumed topic with no reason, on a consumed topic with
no DLQ, on a group named in the registry that is never created, and on a group
created that the registry does not name. `firmware.update` and
`firmware.status` were produced to without ever being declared, so they existed
only by broker auto-creation — which uses the *broker's* partition count and
replication factor, meaning `KAFKA_TOPIC_REPLICATION_FACTOR` silently did not
apply to them.

**Message failure is bounded and replayable.** `KafkaService.runHandler()`
retries `KAFKA_CONSUMER_MAX_ATTEMPTS` times with growing backoff, then
dead-letters to the registry's DLQ for that topic (`telemetry.device.raw` →
`telemetry.device.invalid`, keeping the name operators already use). The DLQ
entry carries the original value verbatim and the original key. It never
rethrows: the offset must advance or one poison message blocks its partition
forever. **All five consumers now rethrow from their handlers** — a handler
that catches its own errors is invisible to the retry and the DLQ, which is
what the previous code did everywhere.

**Ordering-sensitive topics are keyed.** `device.commands` and
`device.commands.retry` are now keyed by `deviceKey`. Unkeyed, two commands for
one device land on different partitions, which are consumed concurrently and in
no defined order relative to each other — so "close the valve" then "open the
valve" could reach the device reversed. Kafka orders within a partition only.

**Consumer lag is visible.** `getConsumerLag()` reports committed offset vs
log end offset per partition, cached for `KAFKA_LAG_CACHE_SECONDS`.
`KafkaHealthIndicator` reads it through `KafkaService` instead of building its
own `Kafka` client and doing `connect` → `describeCluster` → `disconnect` on
every probe — which also bypassed the `kafka` config namespace, so a secured
cluster reported down from a probe that could never have connected. A
never-committed partition reports lag 0, not the whole log, or a new group
looks catastrophically behind on every empty partition.

**Redis fails closed where it is authoritative, open where it caches.**
Sessions (`session:*`) and the token blacklist exist only in Redis, so Redis
down means no new logins and no session refresh — deliberate, because failing
open would stop enforcing a logout or a token revocation exactly when the
infrastructure is least observable. Everything else Redis holds is a cache, and
every read is wrapped so a failure falls through to Postgres.

**Namespaces.** Three clients share one deployment: `RedisService` on db 0 with
`REDIS_KEY_PREFIX` (`smartlife:`), the cache-manager store on db 0 with that
prefix **plus `cache:`**, and Bull on `REDIS_QUEUE_DB` (db 1). Bull is split by
database so a cache flush cannot drop queued jobs. The other two shared
`smartlife:` until now — nothing collided only because nothing injects
`CACHE_MANAGER` today, but the first route to add `CacheInterceptor` on a path
whose key happened to match would have overwritten live sessions with cached
response bodies.

**`RedisService.keys()` and `scan()` were wrong in both directions.** ioredis
applies `keyPrefix` to arguments Redis reports as keys; `KEYS` and `SCAN` take a
*pattern*, which Redis does not report as a key, so the pattern was **not**
prefixed — while the keys in the reply came back **with** the prefix attached.
So `keys('session:*')` asked the server for literal `session:*` and matched
nothing, and had it matched, feeding the results to `del()` would have prefixed
them a second time (`DEL smartlife:smartlife:session:abc`). `invalidateCache()`
was built on this and therefore never invalidated anything while reporting
success. Both halves are fixed, and `invalidateCache()` now uses `SCAN` rather
than `KEYS`, which is O(keyspace) and blocks the single-threaded server.

#### What is cached, and what invalidates it

| Cache | Key | Invalidated by | Why it is worth it |
|---|---|---|---|
| Effective permissions (`PermissionGuard`) | `perm:{tenant}:{global}.{tenant epoch}:{user}` | A **per-tenant epoch** (`INCR`) bumped by `RolesService` create/update/remove/assignPermissions/removePermissions and `UsersService` update/bulkAssignRole/bulkRemoveRole/bulkUpdatePermissions, plus a **global epoch** for system roles (`tenantId IS NULL`, held across every tenant). TTL 60s is only a backstop. | Two multi-join queries (user→roles→permissions, plus customer→grantedPermissions) on **every** request carrying `@RequirePermissions` |
| Subscription row (`SubscriptionGuard`) | `subscription:tenant:{id}` | `SubscriptionCacheSubscriber`, a TypeORM entity subscriber — covers all 14 `save()` sites and any future one by construction, and re-invalidates on `afterTransactionCommit`. The three paths that bypass the ORM (`incrementTenantUsage`, `decrementTenantUsage`, `syncUsageFromDB`) invalidate by hand. | One SELECT on every request |
| Latest reading (`GET /telemetry/:id/latest`) | `telemetry:latest:{deviceId}` | Write-through from **both** ingest paths; TTL 300s bounds the retention sweep orphaning the row | The hottest read on the platform — every dashboard tile polls it |
| Device credentials (`DeviceAuthService`) | pre-existing | `invalidate()` on revocation; negatives cached too | The ingestion hot path |

Three things about that table are load bearing:

1. **The permission epoch, not a TTL.** A cached permission set that outlives a
   revocation is a security bug. The dangerous mutation is a change to a
   *role*, which affects every holder — and finding the holders needs the query
   the cache exists to avoid. One `INCR` orphans every entry in the tenant with
   no `SCAN` and no chance of missing a user. It deliberately invalidates more
   than necessary; the cost is one rebuilt query per active user.

2. **Quota routes bypass the subscription cache.** The row carries live `usage`
   counters that `SubscriptionLimitGuard` enforces against. Served from a cache
   with TTL *T*, a tenant on a 5-device plan can create as many devices as it
   can push through in *T* seconds, per replica — a hard limit silently becomes
   a function of request rate. `SubscriptionGuard` therefore checks the route
   for `@RequireSubscriptionLimit()` and goes to Postgres when it is present.
   It reads the **handler only**, matching `SubscriptionLimitGuard`; reading the
   class too would disable the cache for whole controllers.

3. **The latest-telemetry cache had two producers and only one of them.** It
   was written by `TelemetryService.create()` — the HTTP path — while MQTT,
   CoAP, Modbus, SNMP, BACnet, OPC UA and LwM2M all persist through
   `TelemetryConsumer`, which never wrote it. Its read was commented out, which
   is the only reason that never surfaced: switching it on as written would
   have served most devices a stale reading or none, and the commented-out code
   reconstructed a `Telemetry` with no `id`, no `deviceKey` and no `data`, so a
   cache hit would have returned a different shape from a miss. The key now has
   one owner (`TelemetryLatestCacheService`), both paths call it, the stored
   value is the saved row, and there is a TTL — the old hash had none, so it
   was one permanent key per device on a Redis shared with Bull. The
   `telemetry:{id}:recent` list was removed outright: nothing read it, and no
   100-item Redis list can serve the time-range, key-filter and tenant-scoped
   queries the history endpoints run.

Also deliberately **not** cached: `GET /cad-standards`, because
`CadStandardsService` touches no repository at all — it reads frozen
module-level constants, and a Redis round trip would be slower than the array
it already holds. And the access check inside `getLatest()`:
`resolveDeviceForUser()` runs unconditionally before the cache is consulted,
because a cached authorization decision that outlives an unassignment is a
cross-tenant read (§4g).

### 11b. Floor-plan files on the storage seam

Both floor-plan services are off direct `fs`. What that actually required, and
the two traps in it:

```
POST /floor-plans/:id/dwg-upload
   └─ storage.put('floor-plans/dwg/<uuid>.dwg')   → dwgStorageKey + dwgFileUrl
         └─ (async) storage.get(key)              → bytes, not a path
               └─ withScratchFile(bytes, '.dwg')  → os.tmpdir(), rm in finally
                     └─ dwg2dxf / ODAFileConverter   ← the one local-only step
               └─ renderThumbnail() → PNG bytes
                     └─ storage.put('floor-plans/previews/<id>.png')
GET  /floor-plans/:id/dwg | /preview | /model      → storage.get(key)
```

- **The row stores a key, not a path.** `dwgStorageKey`,
  `thumbnailStorageKey`, `modelStorageKey` and `storageProvider`
  (`FloorPlanStorageKeys1788800000000`, applied with
  `npm run migration:floor-plan-storage-keys <db> [up|down]` because
  `migration:run` is blocked). The `*Url` columns keep their old meaning —
  where a browser fetches it — because they are returned to clients and an
  object-store URL may be signed or on another host, so the key cannot be
  recovered from it.
- **The reads mattered as much as the writes.** `getModelFile()` ignored
  `modelFileUrl` entirely and rebuilt `<modelDir>/<id>.<type>`, which only the
  uploading replica has; the controller then `createReadStream`'d it. There was
  no route at all for the DWG source or the preview — they were reachable only
  through the static `/uploads/**` mount, i.e. only on the local driver and only
  on that one replica. `GET /:id/dwg` and `GET /:id/preview` are new, and all
  three now return bytes from `storage.get()`. A converted write with an
  unconverted read is worse than no conversion: it looks finished and 404s
  (N-1)/N of the time.
- **Legacy values still resolve.** `resolveRef()` classifies what a row holds
  by shape — a key, a `/uploads/...` URL, an absolute path, or an external
  `https://` URL — and `/uploads/x/y` yields exactly the key `x/y` that the
  local driver would have produced for those bytes. So pre-seam rows read
  through the seam with no migration; the key columns are the fast path, not a
  prerequisite. The legacy absolute path is kept as a second attempt for the
  one case the derived key cannot cover: a deployment whose `UPLOAD_PATH` moved
  after the rows were written. An external URL is never read or deleted — the
  seeder writes `https://example.com/floorplans/...` into `thumbnailUrl`, and
  treating that as a key would point `delete()` at a path built from someone
  else's hostname.
- **The DWG converter still needs a real local file**, and that is not
  negotiable: `dwg2dxf` and `ODAFileConverter` take a path. `withScratchFile()`
  (`src/lib/storage/scratch-file.ts`) stages the bytes in a `mkdtemp`
  directory, runs the work and removes the directory in a `finally`. It lives
  in `lib/` and not in the service on purpose: `check:cluster-safety` now
  **fails** on an `fs.writeFile` in either floor-plan file, and a legitimate
  exception written into that assertion is a hole the next real regression
  hides in. `mkdtemp` rather than a fixed name because the converter writes its
  DXF beside its input — two concurrent parses of one plan would delete each
  other's output.
- **Verified by running it**: `npm run verify:floor-plan-storage <db>` (63
  checks) pushes a real DXF through upload → parse → preview → generate →
  download and compares bytes, exercises all four legacy shapes including the
  moved-`UPLOAD_PATH` fallback, and asserts the backfill. The backfill's own
  bug was found that way: `substring(col FROM $1)` with an untyped parameter
  resolves to the **regex** overload, so `FROM 10` matched the pattern `'10'`,
  found nothing, and wrote NULL into every row — a migration that ran, reported
  success and populated nothing. It is `substr(col, $1::integer)`.

### Structural Notes
- The `src/migrations/` directory (at `src/` root, separate from `src/database/migrations/`) exists but is also empty
- `__pycache__/` and `extract_api*.py` files exist at project root — likely leftover from a Python API extraction script; not part of the application
- `assignment-safety-triggers.sql` at project root — SQL triggers for assignment safety checks; status of application to DB is unknown
- `src/modules/gateway/` is a thin HTTP wrapper; the main ingestion path is via `ProtocolsModule/HTTPAdapter`
- `dist/modules/alarms/index.html` and `dist/modules/dashboards/smartlife-dashboard.html` are static HTML files in the dist directory — unclear if these are intentionally served or build artifacts

---

## 12. Running more than one replica

`docker compose --scale app=2` used to corrupt data silently. Nothing failed,
nothing logged, and the symptoms looked like unrelated bugs: telemetry rows
appearing in triplicate, two identical report emails, a dashboard that showed
nothing while REST polling worked, a device command executed three times. Every
cause was the same shape — **per-process state in a process that is no longer
alone.**

```
            ┌──────────── one Redis, three coordination roles ────────────┐
            │                                                             │
 @DistributedCron ──▶ cluster:lock:<name>     one replica runs each tick
 Socket.IO       ──▶ smartlife-ws:*           room emits cross replicas
 RpcCorrelator   ──▶ cluster:rpc:response     a reply finds its promise
            │                                                             │
            └─────────────────────────────────────────────────────────────┘

 EMQX ──▶ $share/smartlife-platform/devices/+/telemetry
          one replica per uplink, instead of all of them
```

### The four mechanisms

| Concern | Mechanism | Where |
|---|---|---|
| `@Cron` fires N times | Redis `SET NX EX` lock per tick, released in `finally` via compare-and-delete, TTL renewed by a watchdog while the body runs | `src/lib/cluster/` |
| Every replica receives every MQTT uplink | `$share/<group>/<filter>` shared subscriptions | `src/lib/mqtt/mqtt.service.ts`, `integration-mqtt-inbound.service.ts` |
| `server.to(room).emit()` is replica-local | `@socket.io/redis-adapter` behind a custom `IoAdapter` | `src/lib/websocket/redis-io.adapter.ts`, registered in `main.ts` |
| An RPC reply lands on the wrong replica | Redis pub/sub relay, settled local-only by the owner | `src/modules/protocols/rpc-correlator.service.ts` |

`npm run check:cluster-safety` asserts all four and fails the build on a new
unlocked `@Cron`. `npm run verify:cluster-locks` proves the lock actually
behaves against a **real Redis** — mutual exclusion between two live service
instances, release on throw, TTL expiry after a simulated crash,
compare-and-delete so an overran holder cannot unlock its successor, and
watchdog renewal.

### When Redis is unreachable, the crons stop — and that has to be visible

This is the part to understand before trusting the table above.

When `withLock` cannot reach Redis it returns `{ran: false}` and the body does
not run. That is the right call — a lock that cannot be claimed might be held
by another replica, and a duplicated billing sweep is worse than a deferred
one. But say the consequence out loud: **nine crons are locked**, so report
delivery, scheduled notifications, automation schedules, Tuya polling,
subscription expiry, usage sync, the monthly usage reset, scheduled downgrades
and the device-offline sweep **all stop happening anywhere** while Redis is
down.

Nothing throws. No request fails. No other health probe turns red. The only
trace was one error line per tick, in a log nobody reads during an incident —
so "reports stopped going out three days ago" would have been diagnosed from
scratch.

`GET /health/cluster` is the probe that shows it:

```jsonc
{
  "status": "degraded",        // or "ok"
  "nodeId": "app-1-7",
  "locksEnabled": true,
  "degraded": true,            // ← alert on this field
  "crons": [
    { "name": "report-schedule-tick",
      "skippedNoRedis": 42,    // work did not happen ANYWHERE
      "skippedNotAcquired": 0, // another replica won — healthy
      "lastNoRedisAt": "2026-10-21T08:12:04.000Z" }
  ]
}
```

`skippedNotAcquired` is **normal** on more than one replica: exactly one winner
per tick means the losers count a skip. `skippedNoRedis` above zero is not.
The route is deliberately **not** a `@HealthCheck()` — a replica losing lock
races is perfectly healthy, and reporting it as "down" would make an
orchestrator restart the replicas that are behaving correctly.

Counters are per-process and reset on restart. That is the honest scope: this
is "what has this replica skipped", not a cluster-wide total.

On a deliberately single-process deployment set `CLUSTER_LOCKS_ENABLED=false`,
and ticks run with no lock and no Redis dependency at all.

### `@DistributedCron` — what to know before adding a cron

```typescript
@DistributedCron(CronExpression.EVERY_MINUTE, {
  name: 'report-schedule-tick',   // REQUIRED — it is the lock key
  lockTtl: 300,                   // seconds; a FLOOR, not a cap
})
async tick(): Promise<void> { … }
```

- **`name` is required**, unlike `@Cron`'s optional one. Two unnamed jobs would
  share a lock and starve each other; the guard script refuses an unnamed one
  and refuses two that collide.
- **`lockTtl` is a floor.** The holder re-arms the TTL every `ttl/3` while the
  body runs, so it only has to exceed the renewal interval. A TTL *shorter*
  than the run without renewal is the classic failure: the key expires
  mid-flight, a second replica acquires it, and both execute — the lock costs a
  round trip and buys nothing.
- **It fails closed.** No Redis means the tick is skipped, not run. Running it
  would reintroduce the duplication on every replica at once, and
  `RedisModule` awaits a connection at boot anyway, so "Redis is down" already
  means "the application is down".
- **Not every cron needs one.** A bounded, repeatable statement with no side
  effects outside the database does not: `DELETE WHERE timestamp < cutoff` run
  three times is one effective delete. Those are listed in `ALLOW_LIST` in
  `scripts/check-cluster-safety.ts` **with a reason**, and an entry for a cron
  that no longer exists is itself a failure.
- **`UPDATE … RETURNING` is its own lock.** `EdgeService.detectOfflineEdges()`
  flips `status = 'active'` rows and acts only on what came back, so Postgres
  picks the winner and the loser gets zero rows. Prefer this shape where it
  fits.
- **The trap is read-then-act.** `DevicesService.checkOfflineDevices()` looks
  idempotent — one bulk UPDATE to a terminal value — but it SELECTs first and
  then emits `device.offline` per row, which fires DEVICE_STATUS automations.
  Both replicas SELECT before either UPDATEs. It is locked.
- **`TelemetryMaintenanceService` is the other correct pattern:** a
  deterministic Bull `jobId` (`agg:<tenant>:<15-min slot>`) collapses N ticks
  into one run. Where the work belongs on a queue, prefer that over a lock —
  it also gets retries and backpressure.

### MQTT shared subscriptions

`$share/` wraps the filter at **subscribe** time only; the broker delivers the
message under its original topic, so nothing downstream changes — do not strip
a prefix in `handleMessage`. Two deployments pointed at one broker must use
different `MQTT_SHARED_GROUP` values or they will steal each other's uplinks
instead of each receiving them.

### What is still single-instance-only

| Thing | Why | Workaround |
|---|---|---|
| **Uploads** | Still local disk, because the only driver that exists is `local`. The *seam* is in place everywhere but `reports` (§11, §11b), so this is now one driver away rather than an audit of six services — the floor-plan write **and read** paths both go through `storage.get()`/`put()`, so they need no further change. Worst case remains OTA: the firmware URL goes to a *device*, and `FirmwareService`'s download route still streams from an absolute path. | Mount `UPLOAD_PATH` on shared storage and set `STORAGE_LOCAL_SHARED=true`, or finish the `s3` driver (§11). |
| **Modbus poller** | Per-process `setInterval`, no leader election. | `MODBUS_ENABLED=false` on all but one. |
| **SNMP poller** | Same shape. | `SNMP_ENABLED=false` on all but one. |
| **`generateDailyAnalytics()`** | Unlocked; writes N rows per tenant per day (§11). | Run on one replica until it is locked. |
| **`WebsocketGateway.getStats()`** | Per-process counts, labelled `scope: 'replica'`. | Not a correctness issue; read it per replica. |

### Compose

`docker-compose.prod.yml` is unchanged and is still the single-node stack — it
pins `container_name: smartlife-app` and publishes `5000:5000`, both of which
are fatal to `--scale`. `docker-compose.scale.yml` is a **separate project**
(Compose can replace a scalar in an override but cannot unset one) that
declares a scalable `app` plus an nginx load balancer, attaching to the
production stack's external network and volumes:

```bash
docker compose -f docker-compose.prod.yml up -d postgres redis kafka zookeeper emqx
docker compose -f docker-compose.scale.yml up -d --scale app=3
```

`docker/nginx/nginx.conf` needs **both** halves of the Socket.IO fix:
`ip_hash`, because an HTTP long-polling session is a sequence of requests that
must reach the same replica, and the `Upgrade`/`Connection` headers, because
without them the handshake silently falls back to that polling. Neither
replaces the Redis adapter — they get the client to *a* replica; the adapter
gets a message produced on another one to it.
