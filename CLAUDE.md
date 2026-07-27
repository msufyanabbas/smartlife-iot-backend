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
| `AutomationModule` | Trigger-condition-action automations; Kafka consumer processes telemetry, Bull queue for action execution |
| `SchedulesModule` | Cron-expression-based schedules for automations |
| `ScriptsModule` | User-defined JavaScript scripts with execution context |
| `IntegrationsModule` | Third-party integration configs (webhooks, Slack, HTTP push) |
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
APP_NAME="Smart Life IoT Platform API"
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
| `src/database/migrations/` | **Empty** — no migration files generated. Schema driven by seeds + `schema:sync` for now. Must generate migrations before production schema changes. |
| `src/modules/automation/automation.processor.ts` lines ~23, 193, 213 | `DeviceCommandService`, `MQTTService`, and `NotificationService` injections are TODOs — automation actions do not yet publish MQTT commands or send notifications |
| `src/modules/automation/automation.service.ts` lines ~187, 269 | `AutomationLog` entity not created; direct automation execution is a stub |
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

### Structural Notes
- The `src/migrations/` directory (at `src/` root, separate from `src/database/migrations/`) exists but is also empty
- `__pycache__/` and `extract_api*.py` files exist at project root — likely leftover from a Python API extraction script; not part of the application
- `assignment-safety-triggers.sql` at project root — SQL triggers for assignment safety checks; status of application to DB is unknown
- `src/modules/gateway/` is a thin HTTP wrapper; the main ingestion path is via `ProtocolsModule/HTTPAdapter`
- `dist/modules/alarms/index.html` and `dist/modules/dashboards/smartlife-dashboard.html` are static HTML files in the dist directory — unclear if these are intentionally served or build artifacts
