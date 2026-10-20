#!/usr/bin/env python3
"""
Add @RequirePermissions(...) to the resource controllers.

WHY THIS EXISTS
---------------
`PermissionGuard` returns true when a handler carries no PERMISSIONS_KEY
metadata — the same default-open shape as `RolesGuard`. Before this change, 24
of 676 handlers (in 2 of 50 controllers) carried the decorator, so granting a
customer `devices:read` changed nothing: no route ever asked. That is exactly
the reported symptom, "permissions I assign do not apply".

The guard reads metadata from the HANDLER only (`reflector.get(..., getHandler())`),
so a class-level decorator would be silently ignored. Every route needs its own.

SCOPE
-----
Only the resources a CUSTOMER or CUSTOMER_USER actually touches, using the
exact resource:action vocabulary the permission seeder creates — a string that
is not seeded can never be granted, so it would be a permanent 403.

Run with --dry to print the plan without writing.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# controller path -> permission resource (seeded vocabulary, see
# src/database/seeds/permissions/)
CONTROLLERS = {
    'src/modules/devices/devices.controller.ts': 'devices',
    'src/modules/dashboards/dashboards.controller.ts': 'dashboards',
    'src/modules/assets/assets.controller.ts': 'assets',
    'src/modules/alarms/alarms.controller.ts': 'alerts',
    'src/modules/automation/automation.controller.ts': 'automations',
    'src/modules/floor-plans/floor-plans.controller.ts': 'floor_plans',
    'src/modules/reports/reports.controller.ts': 'reports',
    'src/modules/analytics/analytics.controller.ts': 'analytics',

    # ── Second pass ─────────────────────────────────────────────────────
    # The controllers above were the eight a CUSTOMER actually touches.
    # These are the rest: 43 controllers had routes and NOT ONE permission
    # decorator, and PermissionGuard returns true when a handler has none,
    # so every one of those routes ignored permissions entirely.
    #
    # Resource choice is by what the route GOVERNS, not by module name:
    # telemetry is its own resource because reading a device's readings is a
    # different grant from editing the device; the rule-engine family
    # (nodes, queues, scripts, schedules, default rule chains) all resolve to
    # `automations` because they are one capability from an operator's view.
    'src/modules/telemetry/telemetry.controller.ts': 'telemetry',
    'src/modules/users/users.controller.ts': 'users',
    'src/modules/customers/customers.controller.ts': 'customers',
    'src/modules/customer-users/customer-users.controller.ts': 'users',
    'src/modules/roles/roles.controller.ts': 'roles',
    'src/modules/permissions/permissions.controller.ts': 'permissions',
    'src/modules/audit/audit.controller.ts': 'audit',
    'src/modules/edge/edge.controller.ts': 'edge',
    'src/modules/notifications/notifications.controller.ts': 'notifications',
    'src/modules/profiles/asset-profile.controller.ts': 'profiles',
    'src/modules/profiles/device-profile.controller.ts': 'profiles',
    'src/modules/nodes/nodes.controller.ts': 'automations',
    'src/modules/queues/queues.controller.ts': 'automations',
    'src/modules/scripts/scripts.controller.ts': 'automations',
    'src/modules/schedules/schedule.controller.ts': 'automations',
    'src/modules/default-rule-chains/default-rule-chains.controller.ts': 'automations',
    'src/modules/email-templates/email-templates.controller.ts': 'settings',
    'src/modules/user-settings/user-settings.controller.ts': 'settings',
    'src/modules/images/images.controller.ts': 'settings',
    'src/modules/solution-templates/solution-templates.controller.ts': 'settings',
    'src/modules/gateway/gateway.controller.ts': 'devices',
    'src/modules/widgets/widgets.controller.ts': 'dashboards',
    'src/modules/widgets/widget-types.controller.ts': 'dashboards',
    'src/modules/integrations/integrations.controller.ts': 'integrations',
    'src/modules/converters/converters.controller.ts': 'integrations',
    'src/modules/devices/codecs/codec.controller.ts': 'integrations',
    'src/modules/rules/rules.controller.ts': 'automations',
    'src/modules/rules/rule-chain-templates.controller.ts': 'automations',
    'src/modules/subscriptions/subscriptions.controller.ts': 'billing',
    'src/modules/payments/payments.controller.ts': 'billing',
    'src/modules/assignments/assignment.controller.ts': 'customers',
    'src/modules/api-monitoring/api-monitoring.controller.ts': 'audit',
    'src/modules/groups/groups.controller.ts': 'groups',
    'src/modules/tenants/tenants.controller.ts': 'tenants',
    'src/modules/sharing/sharing.controller.ts': 'settings',
    'src/modules/attributes/attributes.controller.ts': 'devices',
    'src/modules/device-commands/device-commands.controller.ts': 'devices',
    # AI models hold provider credentials, so they are tenant settings.
    'src/modules/ai/ai.controller.ts': 'settings',
}

# Actions that actually exist per resource. A resource's set is the ceiling:
# mapping a route to an action outside it would be unsatisfiable.
ACTIONS = {
    'devices': {'control', 'create', 'delete', 'list', 'read', 'update'},
    'dashboards': {'create', 'delete', 'list', 'read', 'share', 'update'},
    'assets': {'create', 'delete', 'list', 'read', 'update'},
    'alerts': {'create', 'delete', 'list', 'read', 'update'},
    'automations': {'create', 'delete', 'list', 'read', 'update'},
    'floor_plans': {'create', 'delete', 'list', 'read', 'update'},
    'reports': {'create', 'delete', 'export', 'list', 'read', 'schedule'},
    # NOTE: analytics has NO 'create' in the seeder — only these three.
    'analytics': {'configure', 'export', 'read'},

    # Second pass. Each set is exactly what permissions.seeder.ts creates for
    # that resource; a string outside it can never be granted, so the codemod
    # refuses to emit one rather than planting a permanent 403.
    'telemetry': {'create', 'delete', 'export', 'read'},
    'users': {'create', 'delete', 'list', 'read', 'update'},
    'customers': {'create', 'delete', 'list', 'read', 'update'},
    'roles': {'create', 'delete', 'list', 'read', 'update'},
    'permissions': {'create', 'delete', 'list', 'read', 'update'},
    'audit': {'create', 'delete', 'export', 'read'},
    'edge': {'control', 'create', 'delete', 'list', 'read', 'update'},
    'notifications': {'create', 'delete', 'list', 'read', 'update'},
    'profiles': {'create', 'delete', 'list', 'read', 'update'},
    'settings': {'create', 'delete', 'read', 'update'},
    'integrations': {'create', 'delete', 'list', 'read', 'update'},
    'groups': {'create', 'delete', 'list', 'read', 'update'},
    'tenants': {'create', 'delete', 'list', 'read', 'update'},
    # billing seeds only manage/read — every write maps to `manage`.
    'billing': {'manage', 'read'},
}

# Resources whose writes all collapse to one action.
COARSE_WRITE = {'billing': 'manage'}

DECORATOR_RE = re.compile(r"^(\s*)@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?")


def classify(verb: str, path: str, resource: str) -> str:
    """Map an HTTP route onto a seeded action."""
    p = (path or '').lower()
    allowed = ACTIONS[resource]

    # Explicit intent in the path wins over the verb.
    if 'export' in p or p.endswith('csv') or 'download' in p:
        return 'export' if 'export' in allowed else 'read'
    if 'schedule' in p and 'schedule' in allowed:
        return 'schedule'
    # `share` is the right to GRANT access. GET /shared is just a list of what
    # others shared with me, so it must not demand the sharing permission.
    if '/share' in p and verb in ('Post', 'Delete') and 'share' in allowed:
        return 'share'
    # Device actuation is its own permission — a viewer may read a device
    # without being allowed to switch it on.
    if resource == 'devices' and re.search(
        r'command|rpc|control|activate|deactivate|reboot|toggle', p
    ):
        return 'control' if 'control' in allowed else 'update'
    if 'bulk/delete' in p or p == 'bulk-delete':
        return 'delete'
    # A DELETE on a nested resource edits the parent — removing a widget from a
    # dashboard, or a device from an asset, is not deleting the dashboard or
    # the asset. Classifying it as `delete` would demand a far stronger
    # permission than the operation warrants.
    if verb == 'Delete' and re.search(r':\w+/.+', p):
        return 'update' if 'update' in allowed else 'delete'
    # Bulk status/state changes are updates, not creations.
    if verb == 'Post' and re.search(r'bulk/(status|state|update|enable|disable)', p):
        return 'update' if 'update' in allowed else 'create'

    if verb == 'Get':
        # ':id' anywhere means a single entity; otherwise it is a collection.
        return 'read' if ':' in p else ('list' if 'list' in allowed else 'read')
    if verb == 'Post':
        # A POST under an existing entity mutates it rather than creating one.
        if ':' in p:
            return 'update' if 'update' in allowed else 'create'
        return 'create'
    if verb in ('Patch', 'Put'):
        return 'update' if 'update' in allowed else 'create'
    if verb == 'Delete':
        return 'delete'
    return 'read'


def process(rel: str, resource: str, dry: bool) -> int:
    path = ROOT / rel
    src = path.read_text()
    lines = src.split('\n')
    out = []
    added = 0
    plan = []

    for i, line in enumerate(lines):
        out.append(line)
        m = DECORATOR_RE.match(line)
        if not m:
            continue
        indent, verb, route = m.group(1), m.group(2), m.group(3) or ''

        # Already decorated? Look ahead over the rest of the decorator block.
        lookahead = '\n'.join(lines[i:i + 25])
        head = lookahead.split('\n')
        # stop at the handler signature so we do not see the NEXT route's
        # decorators and wrongly conclude this one is covered
        window = []
        for h in head[1:]:
            if re.match(r"^\s*@(Get|Post|Put|Patch|Delete)\(", h):
                break
            window.append(h)
        joined = '\n'.join(window)
        if '@RequirePermissions' in joined:
            continue
        # A @Public() route has no authenticated user to resolve permissions
        # for. PermissionGuard returns early on it, so a decorator here would
        # be dead code at best — and on an auth or device-uplink route it
        # would read as though the route were protected when it is not.
        if '@Public' in joined:
            print(f'  -- {rel}: {verb} {route!r} is @Public, skipped')
            continue

        action = classify(verb, route, resource)

        # Some resources have a coarser vocabulary than the verb-based
        # classifier assumes. `billing` seeds only manage/read, so every
        # write — create, update, delete — is a single `manage` grant.
        # Remapping here beats widening the seeder: splitting billing into
        # five actions would invent a permission model nobody asked for, and
        # skipping these routes would leave subscription and payment writes
        # ungated, which is the worst of the three outcomes.
        if resource in COARSE_WRITE and action not in ('read', 'list'):
            action = COARSE_WRITE[resource]

        perm = f'{resource}:{action}'
        if action not in ACTIONS[resource]:
            print(f'  !! {rel}: {verb} {route!r} -> {perm} NOT SEEDED, skipped')
            continue

        out.append(f"{indent}@RequirePermissions('{perm}')")
        plan.append(f'  {verb:<6} {route or "/":<34} -> {perm}')
        added += 1

    if plan:
        print(f'\n{rel}  [{resource}]')
        print('\n'.join(plan))

    if added and not dry:
        new = '\n'.join(out)
        if 'RequirePermissions' not in src:
            # Insert the import after the last existing import line.
            # The last line that TERMINATES an import, not the last line that
            # starts one: `import {` on its own line opens a multi-line import,
            # and inserting after it lands inside the braces.
            idx = max(
                i for i, l in enumerate(new.split('\n'))
                if re.match(r"^.*from '[^']+';\s*$", l)
            )
            nl = new.split('\n')
            nl.insert(
                idx + 1,
                "import { RequirePermissions } from "
                "'@common/decorators/permission.decorator';",
            )
            new = '\n'.join(nl)
        path.write_text(new)
    return added


if __name__ == '__main__':
    dry = '--dry' in sys.argv
    total = 0
    for rel, resource in CONTROLLERS.items():
        total += process(rel, resource, dry)
    print(f'\n{"PLANNED" if dry else "ADDED"}: {total} @RequirePermissions')
