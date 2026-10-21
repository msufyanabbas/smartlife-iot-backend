#!/usr/bin/env python3
"""
Add @Audit(...) to every state-changing route that should leave a trail.

WHY THIS EXISTS
---------------
`AuditInterceptor` is registered globally and returns `next.handle()`
unchanged when a handler carries no AUDIT_KEY metadata — the same default-open
shape as `RolesGuard` and `PermissionGuard` (§4g, §4k). Before this change the
`@Audit()` decorator was on **3 handlers in 3 of 56 controllers** (users,
devices, customers — one route each) out of ~700 routes. So the generic
"record this action" mechanism covered ~0.4% of the API, and there was no CRUD
audit at all for tenants, dashboards, rule chains, automations, integrations,
subscriptions, payments, roles, permissions, groups, firmware, relations,
SCADA diagrams or anything else.

`tsc` cannot see this, and no test would either: the decorator's absence is
not an error, it is silence.

SCOPE — WRITES ONLY
-------------------
POST / PUT / PATCH / DELETE. Reads are deliberately excluded: `audit_logs`
would then grow at full request rate (every dashboard poll, every telemetry
page) and an audit log you cannot read because it is 400 million rows of
`GET /devices` is not an audit log. Who read what is answered by `api_logs`,
which is written for every request by `ApiLoggingMiddleware` and has its own
retention.

ENTITY TYPES
------------
`AuditEntityType` is a **Postgres enum** column. A new TypeScript member alone
is not enough — `@IsEnum` accepts it and the INSERT then fails with
`invalid input value for enum audit_logs_entitytype_enum`, which is exactly
the trap §4e documents for `integrations.type`, and `migration:run` is blocked
(§11). So this codemod emits **only members that already exist**, and a
resource with no dedicated member maps onto the closest one plus an explicit
`description` naming the real resource. `SETTINGS` is the honest catch-all for
tenant-configuration resources (roles, permissions, groups, templates); the
description is what makes the row readable.

Run with --dry to print the plan without writing. Re-runnable and idempotent:
a handler that already has an @Audit() is skipped, as is any @Public() route.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ─────────────────────────────────────────────────────────────────────────────
# controller path -> (AuditEntityType member, human resource name or None)
#
# A resource name is emitted as the decorator's `description` whenever the
# entity type is not a one-to-one match for the resource, so a reader of the
# audit table can tell a role change from an email-template edit even though
# both are stored as SETTINGS.
#
# DELIBERATELY ABSENT, and why:
#   assets/, profiles/, floor-plans/, reports/, analytics/  — owned by other
#     agents in this round; adding decorators there would collide.
#   auth/              — login / logout / password / role changes are recorded
#                        by the EVENT path (AuditEventsService), which has the
#                        IP, the user agent and the failure reason. Decorating
#                        them too would double-log every login.
#   audit/             — the audit controller auditing itself is a feedback
#                        loop; its own reads are in api_logs.
#   device-auth/, firmware/ota — @Public broker and OTA callbacks, no user.
#   health/, metrics/, api-monitoring/, widget-types/, lwm2m/ — no writes.
# ─────────────────────────────────────────────────────────────────────────────
CONTROLLERS = {
    # ── Identity and tenancy: the rows that matter most ────────────────────
    'src/modules/users/users.controller.ts': ('USER', None),
    'src/modules/customer-users/customer-users.controller.ts': ('USER', 'customer user'),
    'src/modules/customers/customers.controller.ts': ('CUSTOMER', None),
    'src/modules/tenants/tenants.controller.ts': ('TENANT', None),
    'src/modules/roles/roles.controller.ts': ('SETTINGS', 'role'),
    'src/modules/permissions/permissions.controller.ts': ('SETTINGS', 'permission'),
    'src/modules/two-factor/two-factor-auth.controller.ts': ('USER', 'two-factor setting'),
    'src/modules/assignments/assignment.controller.ts': ('CUSTOMER', 'resource assignment'),

    # ── Devices and their data ────────────────────────────────────────────
    'src/modules/devices/devices.controller.ts': ('DEVICE', None),
    'src/modules/device-commands/device-commands.controller.ts': ('DEVICE', 'device command'),
    'src/modules/gateway/gateway.controller.ts': ('DEVICE', 'device control'),
    'src/modules/attributes/attributes.controller.ts': ('DEVICE', 'attribute'),
    'src/modules/telemetry/telemetry.controller.ts': ('TELEMETRY', None),
    'src/modules/edge/edge.controller.ts': ('SETTINGS', 'edge instance'),
    'src/modules/protocols/opcua/opcua.controller.ts': ('DEVICE', 'OPC UA server'),
    'src/modules/protocols/bacnet/bacnet.controller.ts': ('DEVICE', 'BACnet device'),
    'src/modules/protocols/nbiot/nbiot.controller.ts': ('DEVICE', 'NB-IoT device'),
    'src/modules/protocols/modbus/modbus-devices.controller.ts': ('DEVICE', 'Modbus device'),
    'src/modules/firmware/firmware.controller.ts': ('FILE', 'firmware package'),

    # ── Visualisation ─────────────────────────────────────────────────────
    'src/modules/dashboards/dashboards.controller.ts': ('DASHBOARD', None),
    'src/modules/widgets/widgets.controller.ts': ('WIDGET', None),
    'src/modules/scada/scada.controller.ts': ('DASHBOARD', 'SCADA diagram'),

    # ── Monitoring ────────────────────────────────────────────────────────
    'src/modules/alarms/alarms.controller.ts': ('ALARM', None),
    'src/modules/notifications/notifications.controller.ts': ('NOTIFICATION', None),
    'src/modules/notifications/push-subscriptions.controller.ts': ('NOTIFICATION', 'push subscription'),

    # ── Automation and the rule engine ────────────────────────────────────
    # All of these resolve to RULE_CHAIN: from an operator's point of view the
    # rule engine, automations, schedules, scripts and queues are one
    # capability, and the description keeps them apart in the table.
    'src/modules/rules/rules.controller.ts': ('RULE_CHAIN', None),
    'src/modules/rules/rule-chain-templates.controller.ts': ('RULE_CHAIN', 'rule chain template'),
    'src/modules/default-rule-chains/default-rule-chains.controller.ts': ('RULE_CHAIN', 'default rule chain'),
    'src/modules/nodes/nodes.controller.ts': ('RULE_NODE', None),
    'src/modules/automation/automation.controller.ts': ('RULE_CHAIN', 'automation'),
    'src/modules/schedules/schedule.controller.ts': ('RULE_CHAIN', 'schedule'),
    'src/modules/scripts/scripts.controller.ts': ('RULE_CHAIN', 'script'),
    'src/modules/queues/queues.controller.ts': ('RULE_CHAIN', 'queue'),

    # ── Integrations ──────────────────────────────────────────────────────
    'src/modules/integrations/integrations.controller.ts': ('INTEGRATION', None),
    'src/modules/converters/converters.controller.ts': ('INTEGRATION', 'data converter'),
    'src/modules/devices/codecs/codec.controller.ts': ('INTEGRATION', 'codec'),

    # ── Money ─────────────────────────────────────────────────────────────
    'src/modules/subscriptions/subscriptions.controller.ts': ('SUBSCRIPTION', None),
    'src/modules/payments/payments.controller.ts': ('PAYMENT', None),

    # ── Resources and settings ────────────────────────────────────────────
    'src/modules/groups/groups.controller.ts': ('SETTINGS', 'entity group'),
    'src/modules/relations/relations.controller.ts': ('SETTINGS', 'entity relation'),
    'src/modules/images/images.controller.ts': ('FILE', 'image'),
    'src/modules/email-templates/email-templates.controller.ts': ('SETTINGS', 'email template'),
    'src/modules/user-settings/user-settings.controller.ts': ('SETTINGS', 'user setting'),
    'src/modules/solution-templates/solution-templates.controller.ts': ('SETTINGS', 'solution template'),
    'src/modules/sharing/sharing.controller.ts': ('SETTINGS', 'resource share'),
    'src/modules/ai/ai.controller.ts': ('SETTINGS', 'AI model'),
    # cad-standards is deliberately absent: every route on it is a pure
    # geometry check that writes nothing, so an audit row would record a
    # calculation, not a change.
}

# Routes that are state-changing by HTTP verb but must NOT be audited.
#
# These are DATA paths, not control paths. `POST /telemetry/devices/:key` and
# `POST /gateway/devices/:key/telemetry` are reading-ingest endpoints hit once
# per sample per device; one audit row each would grow `audit_logs` at
# telemetry rate — ~144k rows a day for 100 devices reporting each minute —
# which is the exact failure the read exclusion exists to avoid. Telemetry
# already has its own table, its own retention and its own rollups.
#
# The rest write nothing at all (`validate`, `resolve`, `check-stair`) or are
# a counter bump on a hot path (`track-view`, `heartbeat`).
SKIP_ROUTE_RE = re.compile(
    r'telemetry|heartbeat|track-view|(^|/)validate$|check-stair'
)

# Routes already covered by the EVENT path. Those handlers fire for the
# non-HTTP origins too — an alarm raised by `TelemetryConsumer` has no request
# behind it — so they must stay, and decorating the HTTP route as well would
# write two rows for one action. The event is the one to keep: it is the only
# one that covers both origins.
#
# Note `AlarmsController` routes NOT listed here (patch, delete, assign,
# enable, disable, test) have no event and so are decorated.
#
# Single-entity device and user CRUD is the clearest case: `DevicesService` and
# `UsersService` emit `device.*` / `user.*` with the actor and a field-level
# diff, and they fire for callers that never touch the controller (a Tuya
# import, a bulk operation, a customer sync). Bulk ROUTES keep their decorator
# on purpose — the per-entity event rows and one "an admin ran a bulk delete on
# 40 users" row are different facts, and an audit log wants both.
SKIP_EXACT = {
    ('src/modules/users/users.controller.ts', 'change-password'),
    ('src/modules/users/users.controller.ts', ':id'),
    ('src/modules/devices/devices.controller.ts', ''),
    ('src/modules/devices/devices.controller.ts', ':id'),
    ('src/modules/gateway/gateway.controller.ts', 'devices/:deviceKey/command'),
    ('src/modules/images/images.controller.ts', 'resolve'),
    ('src/modules/alarms/alarms.controller.ts', ''),
    ('src/modules/alarms/alarms.controller.ts', ':id/acknowledge'),
    ('src/modules/alarms/alarms.controller.ts', ':id/clear'),
    ('src/modules/alarms/alarms.controller.ts', ':id/resolve'),
    ('src/modules/alarms/alarms.controller.ts', 'bulk/acknowledge'),
    ('src/modules/alarms/alarms.controller.ts', 'bulk/clear'),
    ('src/modules/alarms/alarms.controller.ts', 'bulk/resolve'),
}

# Only these four verbs. See "SCOPE — WRITES ONLY" above.
DECORATOR_RE = re.compile(r"^(\s*)@(Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?")

IMPORT_BLOCK_RE = re.compile(r"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)';", re.S)


def classify(verb: str, path: str) -> tuple[str, str]:
    """Map an HTTP route onto (AuditAction member, AuditSeverity member)."""
    p = (path or '').lower()

    # Device actuation is its own action — it changes the physical world and
    # is the first thing anyone looks for after an incident.
    if re.search(r'command|rpc|/control|actuat|reboot|toggle', p):
        return 'DEVICE_COMMAND', 'INFO'

    # A bulk delete creates nothing, whatever its verb says.
    if re.search(r'bulk/delete|bulk-delete|bulk-unassign|bulk/unassign', p):
        return 'DELETE', 'WARNING'

    # Credential and account lifecycle get their own actions — these are the
    # rows a security review reads first.
    if 'forgot-password' in p or 'reset-password' in p:
        return 'PASSWORD_RESET', 'WARNING'
    if 'change-password' in p:
        return 'PASSWORD_CHANGE', 'WARNING'
    if 'verify-email' in p or 'resend-verification' in p:
        return 'EMAIL_VERIFY', 'INFO'
    if re.search(r'send-email|send-notification|resend-invitation|invite', p):
        return 'NOTIFICATION_SENT', 'INFO'
    if re.search(r'credential|secret', p):
        return 'API_KEY_CREATE', 'WARNING'
    if re.search(r'(^|/)sync', p):
        return 'UPDATE', 'INFO'

    # Lifecycle transitions read far better than a generic UPDATE when you are
    # scanning for "who turned this off".
    if re.search(r'activat(e|ion)|enable|resume|restore|publish', p) and 'deactivat' not in p:
        return 'ACTIVATE', 'INFO'
    if re.search(r'deactivate|disable|suspend|revoke|cancel|quarantine', p):
        return 'DEACTIVATE', 'WARNING'
    if re.search(r'status|state', p) and verb in ('Post', 'Put', 'Patch'):
        return 'STATUS_CHANGE', 'INFO'
    if re.search(r'permission|grant', p):
        return 'PERMISSION_CHANGE', 'WARNING'
    if re.search(r'\brole\b|roles', p) and verb in ('Post', 'Put', 'Patch', 'Delete'):
        return 'ROLE_CHANGE', 'WARNING'

    if verb == 'Delete':
        # A delete is the one write you cannot undo by repeating it, so it is
        # WARNING rather than INFO regardless of what it deletes.
        return 'DELETE', 'WARNING'
    if verb in ('Put', 'Patch'):
        return 'UPDATE', 'INFO'
    if verb == 'Post':
        # A POST under an existing entity mutates it rather than creating one —
        # `POST /dashboards/:id/widgets` edits the dashboard.
        return ('UPDATE', 'INFO') if ':' in p else ('CREATE', 'INFO')
    return 'UPDATE', 'INFO'


def imported_names(src: str) -> set[str]:
    names: set[str] = set()
    for block, _module in IMPORT_BLOCK_RE.findall(src):
        for raw in block.split(','):
            name = raw.strip().split(' as ')[0].strip()
            if name:
                names.add(name)
    return names


def process(rel: str, entity: str, resource: str | None, dry: bool) -> int:
    path = ROOT / rel
    if not path.exists():
        print(f'  !! {rel}: not found, skipped')
        return 0

    src = path.read_text()
    lines = src.split('\n')
    out: list[str] = []
    added = 0
    plan: list[str] = []

    for i, line in enumerate(lines):
        out.append(line)
        m = DECORATOR_RE.match(line)
        if not m:
            continue
        indent, verb, route = m.group(1), m.group(2), m.group(3) or ''

        # Look ahead over the REST of this handler's decorator block only.
        # Stopping at the next route decorator matters: without it a handler
        # would be judged "already covered" by the next one's @Audit.
        window: list[str] = []
        for h in lines[i + 1:i + 40]:
            if re.match(r"^\s*@(Get|Post|Put|Patch|Delete)\(", h):
                break
            window.append(h)
        joined = '\n'.join(window)

        if '@Audit(' in joined:
            continue
        # A @Public() route has no authenticated user, and AuditInterceptor
        # logs a warning and skips when `request.user` is undefined — so a
        # decorator here is dead code that also makes the route look audited.
        if '@Public' in joined:
            print(f'  -- {rel}: {verb} {route!r} is @Public, skipped')
            continue
        if SKIP_ROUTE_RE.search((route or '').lower()):
            print(f'  -- {rel}: {verb} {route!r} is a data/no-op path, skipped')
            continue
        if (rel, route) in SKIP_EXACT:
            print(f'  -- {rel}: {verb} {route!r} is covered by an event, skipped')
            continue

        action, severity = classify(verb, route)

        out.append(f'{indent}@Audit({{')
        out.append(f'{indent}  action: AuditAction.{action},')
        out.append(f'{indent}  entityType: AuditEntityType.{entity},')
        if resource:
            out.append(
                f"{indent}  description: '{action.replace('_', ' ').lower()} {resource}',"
            )
        if severity != 'INFO':
            out.append(f'{indent}  severity: AuditSeverity.{severity},')
        out.append(f'{indent}}})')

        label = f'{entity}' + (f' ({resource})' if resource else '')
        plan.append(f'  {verb:<6} {route or "/":<40} -> {action:<17} {label}')
        added += 1

    if plan:
        print(f'\n{rel}')
        print('\n'.join(plan))

    if added and not dry:
        new_lines = out
        new = '\n'.join(new_lines)

        have = imported_names(src)
        missing_enums = [
            n for n in ('AuditAction', 'AuditEntityType', 'AuditSeverity')
            if n not in have
        ]
        new_imports: list[str] = []
        if 'Audit' not in have:
            new_imports.append(
                "import { Audit } from '@common/decorators/audit.decorator';"
            )
        if missing_enums:
            new_imports.append(
                f"import {{ {', '.join(missing_enums)} }} "
                "from '@common/enums/index.enum';"
            )

        if new_imports:
            # Insert after the last line that TERMINATES an import. The last
            # line that STARTS one is not the same thing: `import {` on its own
            # line opens a multi-line import and inserting after it lands
            # inside the braces.
            split = new.split('\n')
            idx = max(
                j for j, l in enumerate(split)
                if re.match(r"^.*from '[^']+';\s*$", l)
            )
            for offset, imp in enumerate(new_imports):
                split.insert(idx + 1 + offset, imp)
            new = '\n'.join(split)

        path.write_text(new)

    return added


if __name__ == '__main__':
    dry = '--dry' in sys.argv
    total = 0
    for rel, (entity, resource) in CONTROLLERS.items():
        total += process(rel, entity, resource, dry)
    print(f'\n{"PLANNED" if dry else "ADDED"}: {total} @Audit decorators '
          f'across {len(CONTROLLERS)} controllers')
