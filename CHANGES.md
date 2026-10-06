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

---

# Part 3 — Resources section (Widget Bundles, Widgets, Image Library, JS Library)

## What was actually missing

The brief was "the APIs are in the backend, build the frontend and integrate."
The backend half was right. The frontend was further along than expected:
routes, sidebar entries, i18n keys (English *and* Arabic) and fully typed API
clients (`widgets.api.ts`, `images.api.ts`, `scripts.api.ts`) all existed
already.

What was missing was the last step. Three pages held hardcoded arrays and never
called the API clients sitting beside them:

```ts
const bundles: WidgetBundle[] = [
  { id: '1', name: 'System Widgets', widgets: 24, ... },  // mock
];
```

`ImageLibraryPage` had an "Upload Image" button wired to `onClick: () => {}`.

## Backend additions

| Endpoint | Why |
|---|---|
| `GET /widgets/bundles/:id/export` | Widget *types* had export; bundles did not, so a bundle could only be rebuilt by hand |
| `POST /widgets/bundles/import` | Imports bundle + widgets in one call |
| `GET /images/public/:id` | Unauthenticated serving of images explicitly marked public — required for dashboard embedding |
| `POST /images/resolve` | Batch-resolves image references to URLs; a dashboard with 20 images was 20 round trips |
| `PATCH /images/:id/public` | Toggles public visibility as its own auditable action |

Three decisions in there worth knowing about:

**Bundle membership is keyed on title** (`widgetType.bundleFqn === bundle.title`),
so an import colliding with an existing title would silently absorb that
bundle's widgets. Import rejects a duplicate title unless
`allowDuplicateTitle=true`, which suffixes instead. Overwriting is never
offered — replacing a bundle other dashboards reference is not recoverable.

**`GET /images/public/:id` takes no tenant id at all.** Every other read path is
tenant-scoped; this one deliberately isn't, which is why it checks `isPublic`
rather than accepting any id. Taking a tenant id as an argument would invite a
caller to pass one from the request and turn it into a cross-tenant read. It
returns the same 404 for "missing" and "not public" so ids cannot be probed.

**Imported bundles are never system bundles**, whatever the payload claims —
otherwise an import could create something the UI refuses to delete.

## Frontend

New feature folder `src/features/resources/` — hooks, four pages, five
components. Routes repointed; the old mock pages are left in place rather than
deleted, so nothing else that imports them breaks.

**No new dependencies.** The code editor is hand-built (see below) rather than
pulling in Monaco.

Design follows `DashboardsPage` exactly: `bg-secondary hover:bg-secondary/90
text-white dark:bg-gray-800` for primary actions, bordered ghost icon buttons,
`PageHeader` → controls → stats → content, `dark:` variants throughout, tokens
from `globals.css` (`--color-secondary: #c36ba9`, `--color-primary-main: #1d174c`).

Every page has loading skeletons, an empty state, an error state with retry,
pagination, search and filters. All strings are translated in both languages.

### ThingsBoard parity

- Bundle import/export as JSON, with file download and upload
- Widget import/export/clone
- Widget editor with HTML/CSS/JS tabs and **live preview**
- Image embedding by reference (`tb-image;<id>`, matching ThingsBoard's
  convention so exported configs stay portable between the two)
- Image picker that can publish an image inline
- Script editor with a server-side test runner against `POST /scripts/:id/test`

### Two things worth flagging

**The widget preview iframe uses `sandbox="allow-scripts"` and deliberately NOT
`allow-same-origin`.** Granting both together is equivalent to no sandbox at
all — the frame could reach into the parent page, read the auth token out of
storage and act as the user. Without same-origin the widget script runs in an
opaque origin: it can draw, and nothing else.

**The code editor is hand-built** (`components/common/CodeEditor`). Monaco is
~2 MB and would roughly double the bundle for editing short rule-engine scripts.
This is a transparent `<textarea>` over a syntax-highlighted `<pre>`, scroll-
synced, so selection, undo, IME and mobile keyboards all behave natively.
Highlighting is one combined regex rather than sequential replaces — sequential
passes re-process their own output and a keyword inside an already-highlighted
string gets wrapped twice. No autocomplete or error squiggles; swapping in
CodeMirror 6 behind the same props interface is a contained change if those
become necessary.

## Verified

- Backend: `npm run build` (662 files), `tsc --noEmit` clean
- Frontend: `npm run build` ✓, `tsc -b --noEmit` clean, `eslint` 0 errors

## Not done

- **Image uploads report batch progress, not per-file bytes.** Real byte-level
  progress needs an `onUploadProgress` hook threaded through `apiClient`, which
  touches shared code every feature uses. Files upload sequentially and the bar
  advances per completed file.
- **Script versioning.** `scriptsApi.getVersions` exists in the client but no
  backend endpoint backs it; the editor saves in place.
- **Widget preview uses fixed sample telemetry.** Binding it to a live device
  would need the telemetry subscription machinery from the dashboard runtime.
- **Nothing is runtime-tested against a live backend.** It typechecks, builds
  and lints, and the response shapes are normalised defensively, but I could not
  exercise the endpoints.

---

# Part 4 — Bug fixes from first review, plus Schedule Management

## The root cause behind most of the visual complaints

`src/styles/globals.css` declared 14 colour tokens as **bare HSL triplets**:

```css
--color-destructive: 0 84.2% 60.2%;   /* broken */
```

That works under Tailwind v3 (`hsl(var(--destructive))` in the config). This
project is on **Tailwind v4 with `@theme`**, where the token value is used
verbatim — so `bg-destructive` emitted `background-color: 0 84.2% 60.2%`, which
is invalid CSS and silently ignored.

Affected: `destructive`, `accent`, `background`, `foreground`, `popover`,
`muted-foreground`, `border`, `input`, `ring` and more. That is why the Delete
button rendered with no fill and invisible text, and why dropdowns and popovers
looked unstyled. All 14 are now wrapped in `hsl()`.

This was pre-existing and affects the whole app, not just the Resources pages.

## Bugs fixed

| Bug | Cause |
|---|---|
| Image previews blank | `imagesApi.download()` returns a **Promise**, and it was being used as `<img src>`. Private images also need the auth header, which the browser never sends on an image request |
| Download button did nothing | Same — `window.open(Promise)` |
| `http://localhost:3000https://api.smart-life.sa/...` | `VITE_API_BASE_URL` is already absolute; `copyPublicUrl` prefixed `window.location.origin` on top |
| Delete dialog had no visible button | `bg-destructive` (above) |
| Script test failed with "property data should not exist" | The client wrapped the body as `{ data: testData }`; the DTO expects `{ msg, metadata?, msgType? }` at the top level |
| "All types" dropdown wrapped to two lines | `SelectTrigger` had no truncation and the chevron was not `shrink-0` |
| Editor dialogs overflowed the viewport | Fixed heights with no scroll container — the Save button was pushed off-screen |
| Card titles pushed badges off the card | Missing `min-w-0` on the flex child, so the title could not truncate |

New: `ImageThumb` fetches private images through `apiClient` as blob URLs and
revokes them on unmount. Without revocation, scrolling a few hundred images pins
every one in memory for the page's lifetime.

`tb-image;` → **`sl-image;`**. Both prefixes are accepted on read, so widgets
saved before the rename and anything imported from a ThingsBoard export still
resolve.

## Dead feature flags — the real cause of the 403s

`FeatureRoute` denies when a flag is not exactly `true`, and four route guards
named flags the **backend never sends**. Those pages were 403 for every user on
every plan — not a subscription problem:

| Route | Was | Now |
|---|---|---|
| `/images` | `imageLibrary` | `resources` |
| `/javascript-library` | `scriptLibrary` | `resources` |
| `/dashboards/:id` | `widgetEditor` | `solutionDashboards` |
| `/customer-management` | `createCustomer` | `customerManagement` |

An audit script now confirms every guard maps to a real backend flag. Note the
two sides still disagree on defaults: the backend treats a missing flag as
*available*, the frontend as *denied*. Worth aligning.

## Schedule Management

`pages/ScheduleManagementPage.tsx` rendered `DUMMY_SCHEDULES` and never called
`features/schedules/hooks`, which were already complete. Same pattern as the
Resources pages.

Replaced with a fully wired feature: list with search plus type and status
filters, stats, create/edit with cron presets and server-side cron validation,
interval and one-time modes, enable/disable toggle, run-now, execution history,
and delete. Translated in English and Arabic.

Two details worth noting: only the timing field for the selected type is sent
(sending all three leaves a stale `cronExpression` on a schedule switched to
interval, and the server could act on either), and a disabled schedule shows no
next-run time regardless of what `nextExecution` holds.

## Verified

Backend `npm run build` ✓ · Frontend `npm run build` ✓ · `tsc -b --noEmit` clean
· `eslint --quiet` 0 errors across `features/resources`, `features/schedules`,
`components/common/CodeEditor`.

---

# Part 5 — Dialog/header styling, Edge Management, menu restructure

## Dialog padding — a pre-existing defect in the shared component

`DialogContent` was `grid gap-4` with **no padding**, while `DialogHeader` and
`DialogFooter` each carried `p-4`. So the coloured bar and the button row were
padded and everything between them ran edge to edge — which is the margin problem
in the Create Widget Bundle screenshot, and it affected every dialog in the app.

`DialogDescription` was also `text-muted-foreground` — grey — while sitting on
the primary-coloured header bar. That is the "colour is grey" complaint.

Fixed in `components/ui/dialog.tsx`:
- `DialogContent` now carries `p-6`, so body content is padded by default
- `DialogHeader` / `DialogFooter` use `-mx-6 -mt-6` / `-mx-6 -mb-6` to cancel it,
  so the bars still run edge to edge
- `DialogDescription` uses `text-current/80`, inheriting white on the header and
  falling back to muted grey in a plain body

The five custom dialogs added earlier were simplified accordingly — they no
longer need `p-0` plus manual `px-6` on every section.

## Table headers

`ScriptLibraryPage`, `ScheduleManagementPage` and `ScheduleHistoryDialog` used
bare `<TableHeader>`, so their headings were plain grey text while `DataTable`
(used by Solution Dashboards) renders `bg-primary` with white bold headings.
They now match, via `bg-primary [&_th]:text-white [&_th]:font-medium` on the
header so every cell inherits without repeating it.

## Edge Management

`EdgeManagementPage` imported `edgeInstances` and `edgeActivities` from a static
`data.ts` fixture. The hooks (`useEdges`, `useCreateEdge`, …) and the backend
(20+ endpoints) were both already complete — the same disconnect as Resources
and Schedules.

Now wired to `useEdges`, with search, loading skeletons, empty and error states.

Two things worth knowing:

**An adapter was needed** (`utils/adapt-edge.ts`). The components were written
against the fixture, which disagrees with the API: flat `cpu`/`memory`/`storage`
vs nested metrics, `Date` objects vs ISO strings (`.toLocaleString()` on a raw
string throws), and `devices` as a count vs a relation array. Adapting is
contained; rewriting EdgeTable and EdgeStats would not have been.

**`EdgeCreateDialog` required a `customerId` prop that nothing could supply** —
the `User` type carries no customer id, so the dialog could not be mounted at
all (it was commented out in the page). It is now optional: the backend scopes
the new edge to the tenant on the JWT, and the prop is only needed when an admin
creates an edge for a specific customer.

The activity feed is derived from the edge rows rather than fetched. Events live
at `GET /edge/:id/events` — per edge — so a combined feed would be one request
per edge on page load. Worth a global events endpoint later.

## Menu restructure

Rule chain templates and converter templates were under Edge Management, where
neither belongs:

| Item | From | To |
|---|---|---|
| Rule chain templates | Edge Management | **Automation** — rule chains are the automation engine; an edge only executes them |
| Converter templates | Edge Management | **Integrations** — converters decode payloads on the way in, which is the integration pipeline |

The old `/edge-management/rule-chain-templates` and
`/edge-management/converter-templates` paths are **kept as route aliases**, so
saved links and bookmarks still resolve. Only the menu changed.

## Automation and Integrations — already integrated

Both were checked rather than assumed. `features/automation/hooks/useAutomation.ts`
has 11 query/mutation hooks against `automation.api`, and
`features/integrations/Hooks/index.ts` has 18 against `integrations.api`. Both
backends exist. These are **not** mock-data pages like Edge/Schedules/Resources
were, so nothing was rewritten.

A sidebar feature-flag audit also found no dead flags there, so the menus are not
being hidden. If specific screens still misbehave, the cause is per-screen and
needs the actual symptom to diagnose.

## Verified

Frontend `npm run build` ✓ · `tsc -b --noEmit` clean · `eslint --quiet` clean
across `features/resources` and `features/schedules`. Thirteen pre-existing
`any`/unused warnings remain in `EdgeTable.tsx`'s column definitions; typing
those properly is a separate refactor with real rendering risk.

---

# Part 6 — Edge creation, floor plans end to end

## Edge creation — three stacked bugs

**The form validated against a field it never shows.** The zod schema had
`customerId: z.string().trim().min(1, 'Customer is required')`, but nothing in
the app can supply a customer id — the `User` type has no such field, so the
dialog defaulted it to `''`. Validation therefore failed on every submit,
against a field that is not rendered anywhere in the form. Pressing Create did
nothing, with no visible reason. This is the bug you hit.

**The type dropdown offered values the server rejects.** The form listed
`GATEWAY`, `PROCESSOR`, `RELAY`. The backend's `EDGE_TYPES` is `GATEWAY`,
`INDUSTRIAL`, `RETAIL`, `AGRICULTURE`, `SMART_HOME`, `CUSTOM` — two of the three
options were guaranteed 400s from `@IsIn`.

**Empty strings are not optional.** Even past zod, `customerId: ''` reaches
`@IsUUID()` server-side. `@IsOptional()` skips `undefined` and `null`, not `''`.
The payload now strips blank optional fields before sending.

All three fixed; `EdgeType` and the dropdown now mirror `EDGE_TYPES` exactly.

## Floor plans — the creation wizard discarded most of the user's work

| Step | What it actually did |
|---|---|
| 1 Asset selection | Creates the floor plan ✅ |
| 2 DWG import | Uploads the file ✅ |
| 3 Zone setup | Zustand store only — **never saved** |
| 4 Device link | Zustand store only — **never saved** |
| 5 Review → Save | `// TODO` stub: `console.log`, reset store, navigate away |

So a user could lay out zones, place devices, press Save, and lose all of it —
while the plan row and its DWG survived, which is exactly why it looked
half-working rather than broken.

`handleSave` is now implemented: it writes each zone (converting the canvas rect
to the polygon the API expects) and each device placement, counting failures per
item so one bad zone does not cost the other nine. The button is disabled while
in flight — the handler issues one request per item, so a double click would
duplicate every one of them.

## Floor plan API — six client methods pointed at nothing

| Client called | Server has | Effect |
|---|---|---|
| `POST /:id/markers` | `POST /:id/devices` | **404** |
| `PATCH /:id/markers/:deviceId` | `PATCH /:id/devices/:deviceId` | **404** |
| `DELETE /:id/markers/:deviceId` | `DELETE /:id/devices/:deviceId` | **404** |
| `POST /:id/clone` | — | **404** |
| `GET /:id/zones` | — | **404** |
| `POST /:id/upload-image` | — | **404** |

The first three are the entire device-placement workflow — the core of the
feature. Paths corrected.

Added to the backend:
- `GET /:id/zones` — zones live on the floor plan row, so this is a projection;
  it exists because reading zones back otherwise meant fetching the whole plan
  including parsed geometry, which can be megabytes
- `POST /:id/clone` — copies geometry, zones, settings and 3D metadata.
  Device placements are deliberately **not** copied: a device is in one physical
  place, and duplicating placements would claim the same hardware is on two
  floors. If the source floor is taken, the copy is created with no floor, since
  a floor holds one plan.

## Endpoints that had no client at all

Added clients and hooks for ~12 live backend endpoints the frontend never
called: `available-devices`, `settings` (get/patch/reset), device
`position`/`animation`, `building-3d-metadata`, `asset/:assetId`,
`asset/:assetId/3d-simulation`, and model upload/download.

**Including the 3D model generation added in Part 2, which was unreachable.**
`/model/generate` and `/model/preview` existed server-side and nothing in the UI
called them. There is now a `GenerateModelDialog` (format, up-axis, wall height,
per-category toggles) on the detail page, and the Review step's "Export 3D model"
button — previously a `console.log` — generates and downloads a GLB.

Preview-before-generate is the point of that dialog, not a nicety: the build
reports how many door and window openings could not be matched to a wall, which
is the clearest signal a drawing's layers are non-standard. Better seen before
writing a file than discovered in a viewer.

## Settings page

`FloorMapSettingsPage` had a TODO submit handler that only showed a success
toast — it saved nothing. The cause was structural: settings are stored **per
floor plan** server-side, but the page is routed at `/floor-plans/settings` with
no id, so there was nothing to save against.

Rather than move the route and break the existing link, the page now selects
which plan it is editing, loads that plan's stored settings, and maps the flat
form onto the server's nested `gridSettings` / `defaultColors` shape. Reset now
resets server-side too — previously it reset only the form, leaving stored
settings untouched while showing defaults.

## Version history — no backend exists

`FloorMapHistoryPage` rendered `mockVersions`, a hardcoded array, and offered
Restore, Compare and Export against it. There is **no version, revision or
snapshot endpoint** in the floor-plans module — nothing records history, so
there was nothing those buttons could ever do.

The fabricated rows are gone and the actions now say the feature is not
available. Implementing it is a backend change — a versions table, snapshots on
write, a restore path — not a frontend one. The sample shape is kept in the file,
commented, for whoever builds it.

## Verified

Backend `npm run build` (662 files) ✓ · `tsc --noEmit` clean.
Frontend `npm run build` ✓ · `tsc -b --noEmit` clean · the files added here lint
clean. ~180 pre-existing `any` and unused-import warnings remain across the older
floor-plan components (`FloorPlan3DViewer`, `FloorPlanCanvas`, `EnhancedCADParser`);
typing those is a separate refactor with real rendering risk.

---

# Part 7 — Mesh module restored, schedules fixed, UI pass

## First: the 3D model 404s were my regression

`/model/generate` and `/model/preview` returned 404 because **the endpoints did
not exist**. The entire mesh module from Part 2 — `triangulate.ts`,
`mesh.builder.ts`, `floor-plan-mesh.factory.ts`, `gltf.exporter.ts`,
`obj.exporter.ts`, the DTO, the service methods, the controller routes — was
lost when a later session built on a re-uploaded copy of the repo instead of the
previous output. I then wired frontend buttons against the missing API.

All of it is restored and re-verified. Nine checks pass, including the two real
bugs the original pass found:

- **Hole triangulation** returns 84 units for a 10×10 room with a 4×4 core, not
  140. Bridging a hole creates duplicate vertices; an ear test comparing by index
  rejected every ear and fell through to a fan, which fills holes in.
- **Winding is not reversed for Y-up.** The map `(x,y,z) → (x,z,−y)` has
  determinant +1 — a rotation, not a mirror. Reversing it desynchronises
  triangles from normals and renders the model inside-out. Verified by signed
  volume (positive) and zero normal mismatches across every triangle.

Plus: door cut → 3 boxes, window cut → 4 (pier/sill/lintel/pier), a distant
collinear door is reported unmatched rather than cut, GLB header length and
4-byte alignment, POSITION min/max present, STL size matches its triangle count.

## Schedules — could not be created at all

The form was wrong in four ways simultaneously:

| Sent | Server wants |
|---|---|
| `type: 'cron'` | `type: 'CRON'` — uppercase enum |
| `action: {...}` | **No such field** — `forbidNonWhitelisted` rejects it |
| — | `actionType`: one of six enums |
| — | `actionConfig`: discriminated object keyed by `actionType` |

`actionConfig` has six distinct shapes (`deviceCommand`, `attributeUpdate`,
`ruleChainTrigger`, `notification`, `maintenance`, `report`), which is why a
single free-text "Target" box could never work. The form now switches its inputs
per action type.

**`POST /schedules/validate-cron` did not exist** — I had invented it. Added, and
it returns the **next five fire times** rather than a bare boolean: `0 0 * * 0`
parses fine and runs weekly, not daily, and only the preview makes that obvious.

### Target and command, from the codecs

Target is now a device dropdown. Command is driven by the device's codec via the
existing `GET /devices/:id/capabilities`, so the picker only offers RPC methods
that hardware actually implements — and each command's parameters render as
**typed inputs with real ranges and defaults** taken from the codec definition,
not a raw JSON box:

```ts
{ key: 'target_temperature', type: 'number', default: 20, min: 5, max: 35 }
```

A device whose codec declares no commands says so, rather than looking broken.

## Edge actions — the actions column was mis-called

`createActionsColumn(onEdit, onDelete)` takes **two callbacks**. EdgeTable passed
a function returning an array of action objects, so that function was read as
`onEdit`: the menu rendered its built-in Edit item whose handler returned an
array and did nothing, and Delete never rendered at all. That is both "Edit does
nothing" and "Delete is missing", from one mistake.

The dropdown was also wrapped in `<div className="relative">`, which makes the
absolutely-positioned panel resolve against that div instead of the viewport —
the overflow and stray-margin behaviour. Wrapper removed.

Edit, Delete and Sync now work; the edit form reuses the create dialog seeded
with the row rather than a second near-identical component that would drift.

## Dropdowns, platform-wide

Two defects in the shared `Select`:

- `SelectContent` was `w-full`, pinning the panel to the trigger's width so long
  options were clipped. Now `min-w-full max-w-[22rem]`, growing to its content.
- `SelectItem` used `pl-8` plus an absolutely-positioned tick, reserving the
  indent on *every* row — so unselected options looked pushed in and the list
  read as misaligned. The tick now sits in a fixed-width slot.

## Lists as rows

Widget Bundles and Widgets were card grids; both are now tables with actions on
the right, matching the convention used elsewhere (primary header bar, white
bold headings, icon buttons in the last column).

## Image thumbnails

`ImageThumb` now falls back to the authenticated blob fetch when a public URL
fails — which happens when `VITE_API_BASE_URL` does not match where the API is
served, and previously left a permanently blank tile with no indication why. A
failed load is labelled "Preview unavailable" rather than showing the same
placeholder as "still loading".

If tiles are still blank after this, the files are missing from disk on the
server (the DB row exists, the file does not) — check `uploads/images/`.

## Users

`UsersPage.handleDeleteConfirm` showed "deleted successfully" and **called
nothing**. The user stayed, and the list only revealed it on the next refresh. A
success toast for an action that did not happen is worse than an error. Now uses
the `useDeleteUser` hook that already existed.

## Verified

Backend `npm run build` (668 files) ✓ · `tsc --noEmit` clean · 9/9 mesh checks.
Frontend `npm run build` ✓ · `tsc -b --noEmit` clean.
