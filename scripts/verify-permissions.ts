/**
 * Proves that granted permissions actually decide access.
 *
 *   createdb permcheck && npm run verify:permissions permcheck
 *
 * THE BUG THIS COVERS
 * -------------------
 * `PermissionGuard` returns true when a handler carries no PERMISSIONS_KEY
 * metadata. Before this change 24 of 676 handlers had the decorator, in 2 of
 * 50 controllers — so granting a customer `devices:read` changed nothing,
 * because no route ever asked. That is the reported symptom: "permissions I
 * assign don't apply".
 *
 * These assertions pin the behaviour that makes a grant mean something:
 *
 *   - a CUSTOMER_USER whose role carries the permission AND whose customer
 *     was granted it is allowed
 *   - revoking it at EITHER level denies — the effective set is an
 *     intersection, so a customer grant cannot widen a user's role, and a
 *     role cannot exceed what the customer holds
 *   - a subscription that lacks the feature drops the permission even when
 *     both levels grant it
 *   - TENANT_ADMIN and SUPER_ADMIN bypass, as the guard intends
 *   - a route with no decorator is still open (documented, not endorsed —
 *     this is why coverage matters)
 */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as entities from '../src/modules/index.entities';
import { PermissionGuard } from '../src/common/guards/permission.guard';
import { PERMISSIONS_KEY } from '../src/common/decorators/index.decorator';
import { PermissionCacheService } from '../src/lib/redis/permission-cache.service';
import { inMemoryRedis } from './support/in-memory-redis';


const database = process.argv[2] ?? 'permcheck';

let failures = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
};
const section = (t: string) => console.log(`\n── ${t} ─────────────`);

const TENANT = randomUUID();
const CUSTOMER = randomUUID();
const CUST_USER = randomUUID();
const TENANT_ADMIN = randomUUID();
const ROLE = randomUUID();

/** A fake ExecutionContext carrying the permissions a route would require. */
const ctxFor = (user: any, required: string[] | undefined, subscription?: any) => {
  const request: any = { user, subscription };
  return {
    request,
    context: {
      getHandler: () => ({ __required: required }),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
};

const reflectorFor = () => {
  const r = new Reflector();

  // `getAllAndOverride` now serves BOTH @Public and @RequirePermissions.
  //
  // It used to be stubbed as `() => false` because only @Public went through
  // it, while @RequirePermissions was read with `get()` from the handler
  // alone. That handler-only read was the bug — a class-level decorator was
  // silently ignored — and fixing the guard to use `getAllAndOverride` for
  // permissions turned this stub into a mock that answered "no permissions
  // required" for every route, so the guard allowed everything and all four
  // denial assertions failed.
  //
  // The mock must therefore be key-aware, and must honour handler-over-class
  // precedence exactly as the real Reflector does.
  (r as any).getAllAndOverride = (key: any, targets: any[]) => {
    if (key === PERMISSIONS_KEY) {
      for (const t of targets ?? []) {
        if (t?.__required !== undefined) return t.__required;
      }
      return undefined;
    }
    return false; // IS_PUBLIC_KEY and anything else
  };

  (r as any).get = (key: any, handler: any) =>
    key === PERMISSIONS_KEY ? handler?.__required : undefined;

  return r;
};

(async () => {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '123456',
    database,
    entities: Object.values(entities) as any[],
    synchronize: true,
    logging: false,
  });
  await ds.initialize();
  const q = (sql: string, p: any[] = []) => ds.query(sql, p);

  // `tenants.name` is UNIQUE and this fixture used the fixed literal
  // 'Perm tenant'. Any run that died before its cleanup — a failed assertion,
  // a Ctrl-C, a schema change mid-run — left that row behind and made the
  // script permanently unrunnable with a duplicate-key error that says nothing
  // about permissions. A guard that needs the database hand-cleaned before it
  // will run is a guard that stops being run.
  //
  // Two changes: the name is now unique per run, and any residue from an
  // earlier crashed run is swept first.
  await q(
    `DELETE FROM users WHERE "tenantId" IN (
       SELECT id FROM tenants WHERE name LIKE 'Perm tenant%'
     )`,
  );
  await q(
    `DELETE FROM customers WHERE "tenantId" IN (
       SELECT id FROM tenants WHERE name LIKE 'Perm tenant%'
     )`,
  );
  await q(`DELETE FROM tenants WHERE name LIKE 'Perm tenant%'`);

  await q('INSERT INTO tenants (id,name,email) VALUES ($1,$2,$3)', [
    TENANT,
    `Perm tenant ${TENANT.slice(0, 8)}`,
    `perm-${TENANT.slice(0, 8)}@example.invalid`,
  ]);
  await q(
    `INSERT INTO customers (id,name,email,"tenantId",status)
     VALUES ($1,$2,$3,$4,'active')`,
    [CUSTOMER, 'Perm customer', `pc-${CUSTOMER.slice(0, 8)}@example.invalid`, TENANT],
  );
  const addUser = (id: string, role: string, customerId: string | null) =>
    q(`INSERT INTO users (id,email,password,name,role,"tenantId","customerId")
       VALUES ($1,$2,'x',$3,$4,$5,$6)`,
      [id, `${id.slice(0, 8)}@example.invalid`, role, role, TENANT, customerId]);
  await addUser(CUST_USER, 'customer_user', CUSTOMER);
  await addUser(TENANT_ADMIN, 'tenant_admin', null);

  // Permissions: devices:read and devices:delete
  const perms: Record<string, string> = {};
  for (const [resource, action] of [['devices', 'read'], ['devices', 'delete']]) {
    const id = randomUUID();
    perms[`${resource}:${action}`] = id;
    await q(
      `INSERT INTO permissions (id,resource,action,"isSystem") VALUES ($1,$2,$3,true)`,
      [id, resource, action],
    );
  }

  // The user's ROLE carries devices:read only.
  await q(
    `INSERT INTO roles (id,name,description,"tenantId","isSystem")
     VALUES ($1,'Perm role','',$2,false)`,
    [ROLE, TENANT],
  );
  await q(`INSERT INTO role_permissions ("roleId","permissionId") VALUES ($1,$2)`,
    [ROLE, perms['devices:read']]);
  await q(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`,
    [CUST_USER, ROLE]);

  // The CUSTOMER is granted both.
  for (const id of Object.values(perms)) {
    await q(`INSERT INTO customer_permissions ("customerId","permissionId") VALUES ($1,$2)`,
      [CUSTOMER, id]);
  }

  // PermissionGuard gained a fourth constructor parameter — PermissionCacheService
  // — when per-request permission resolution was cached. This script was still
  // passing three, so `this.permissionCache` was undefined, `canActivate()`
  // threw a TypeError on the first `.get()`, and `can()` below catches and
  // returns false.
  //
  // That is worth spelling out, because the failure was asymmetric and the
  // asymmetry is the dangerous part: every "is allowed" assertion failed
  // loudly, while every "is denied" assertion PASSED — for the wrong reason.
  // A revoke test whose baseline is already denied proves nothing. The suite
  // would have reported 3 failures and 12 passes while actually testing
  // nothing at all.
  //
  // The real cache is used here, not a pass-through stub, so its invalidation
  // is exercised too. It is backed by an in-memory Redis stand-in: the epoch
  // scheme needs INCR and real TTL semantics, and a stub that ignored them
  // would make every cached lookup a miss and hide the same class of bug
  // again.
  const permissionCache = new PermissionCacheService(inMemoryRedis());

  const guard = new PermissionGuard(
    reflectorFor(),
    ds.getRepository(entities.Customer) as any,
    ds.getRepository(entities.User) as any,
    permissionCache,
  );

  const sub = {
    hasFeature: (k: string) => k !== 'floorPlans', // everything but floor plans
  } as any;

  /**
   * Every raw-SQL change to a grant below has to be followed by a cache
   * invalidation, exactly as the ORM-bypassing paths in the application do.
   * `UsersService` and `RolesService` call this for writes that go through
   * them; a script (or a seeder, or a migration) writing the join tables
   * directly gets no subscriber and no hook, so it must bump by hand or every
   * subsequent assertion reads a stale set.
   *
   * This is the requirement the cache imposes on any new write path, stated
   * once, in the place that would otherwise silently drift.
   */
  const invalidate = async () => {
    await permissionCache.bumpTenant(TENANT);
    await permissionCache.bumpGlobal();
  };

  const can = async (user: any, required: string[] | undefined, subscription = sub) => {
    const { context } = ctxFor(user, required, subscription);
    try {
      return await guard.canActivate(context);
    } catch {
      return false;
    }
  };

  const customerUser = { id: CUST_USER, role: 'customer_user', email: 'cu@x', customerId: CUSTOMER };
  const tenantAdmin = { id: TENANT_ADMIN, role: 'tenant_admin', email: 'ta@x' };
  const superAdmin = { id: randomUUID(), role: 'super_admin', email: 'sa@x' };

  section('1. A granted permission is allowed');
  ok('customer_user with devices:read on role AND customer grant → allowed',
    await can(customerUser, ['devices:read']));

  section('2. Missing at either level denies');
  ok('devices:delete granted to the CUSTOMER but not on the role → denied',
    !(await can(customerUser, ['devices:delete'])));

  await q('DELETE FROM customer_permissions WHERE "customerId"=$1 AND "permissionId"=$2',
    [CUSTOMER, perms['devices:read']]);
  await invalidate();
  ok('revoking the CUSTOMER grant denies even though the role still has it',
    !(await can(customerUser, ['devices:read'])));

  // put it back for the remaining checks
  await q('INSERT INTO customer_permissions ("customerId","permissionId") VALUES ($1,$2)',
    [CUSTOMER, perms['devices:read']]);
  await invalidate();
  ok('restoring the grant allows again', await can(customerUser, ['devices:read']));

  section('3. The subscription can veto a granted permission');
  const noDevices = { hasFeature: (k: string) => k !== 'devices' } as any;
  ok('plan without the devices feature drops devices:read despite both grants',
    !(await can(customerUser, ['devices:read'], noDevices)));

  section('4. Admin bypass');
  ok('tenant_admin passes without any grant', await can(tenantAdmin, ['devices:delete']));
  ok('super_admin passes without any grant', await can(superAdmin, ['devices:delete']));

  // ── 4b. enforcePermissions ────────────────────────────────────────────
  //
  // The tenant-admin bypass used to be unconditional, which made assigning
  // permissions to a tenant admin a no-op: the grant saved, the UI showed
  // it, and the guard never looked. `users.enforcePermissions` is the
  // per-user opt-in that makes it real.
  //
  // Four properties matter and all four are asserted: the flag is off by
  // default (above), turning it on restricts, a grant then works, and
  // SUPER_ADMIN ignores it — an account that can revoke its own access to
  // the platform it administers has no way back in.
  section('4b. enforcePermissions makes a grant real for a tenant admin');

  await q('UPDATE users SET "enforcePermissions" = true WHERE id = $1', [
    TENANT_ADMIN,
  ]);
  await invalidate();
  const restrictedAdmin = { ...tenantAdmin, enforcePermissions: true };

  ok(
    'with the flag on and NO grant, the tenant admin is denied',
    !(await can(restrictedAdmin, ['devices:delete'])),
  );

  // Give the admin exactly one permission, via a role.
  const ADMIN_ROLE = randomUUID();
  await q(
    `INSERT INTO roles (id, name, "tenantId") VALUES ($1, 'restricted-admin', $2)`,
    [ADMIN_ROLE, TENANT],
  );
  await q(`INSERT INTO role_permissions ("roleId","permissionId") VALUES ($1,$2)`, [
    ADMIN_ROLE,
    perms['devices:read'],
  ]);
  await invalidate();
  await q(`INSERT INTO user_roles ("userId","roleId") VALUES ($1,$2)`, [
    TENANT_ADMIN,
    ADMIN_ROLE,
  ]);

  ok(
    'the granted permission now applies',
    await can(restrictedAdmin, ['devices:read']),
  );
  ok(
    'an ungranted one is still refused',
    !(await can(restrictedAdmin, ['devices:delete'])),
  );
  ok(
    'super_admin ignores the flag and cannot lock itself out',
    await can(
      { ...superAdmin, enforcePermissions: true },
      ['devices:delete'],
    ),
  );

  // Restore, so later sections see the documented default.
  await q('UPDATE users SET "enforcePermissions" = false WHERE id = $1', [
    TENANT_ADMIN,
  ]);
  await invalidate();
  ok(
    'with the flag off again the admin bypasses as before',
    await can(tenantAdmin, ['devices:delete']),
  );

  section('5. The default-open shape that caused the bug');
  ok('a handler with NO @RequirePermissions is open to a customer_user',
    await can(customerUser, undefined));
  console.log(
    '    ^ this is why coverage matters: an undecorated route asks nothing.',
  );

  section('6. Several permissions at once');
  ok('requiring read AND delete fails when only read is effective',
    !(await can(customerUser, ['devices:read', 'devices:delete'])));

  await ds.destroy();
  console.log(
    failures
      ? `\nFAIL — ${failures} check(s) failed`
      : '\nPASS — grants, revocations and plan features all decide access',
  );
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nFAILED:', e?.message);
  console.error(e?.stack);
  process.exit(1);
});
