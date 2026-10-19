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
  // getAllAndOverride is used for @Public; get() is used for @RequirePermissions
  (r as any).getAllAndOverride = () => false;
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

  await q('INSERT INTO tenants (id,name,email) VALUES ($1,$2,$3)', [
    TENANT, 'Perm tenant', `perm-${TENANT.slice(0, 8)}@example.invalid`,
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

  const guard = new PermissionGuard(
    reflectorFor(),
    ds.getRepository(entities.Customer) as any,
    ds.getRepository(entities.User) as any,
  );

  const sub = {
    hasFeature: (k: string) => k !== 'floorPlans', // everything but floor plans
  } as any;

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
  ok('revoking the CUSTOMER grant denies even though the role still has it',
    !(await can(customerUser, ['devices:read'])));

  // put it back for the remaining checks
  await q('INSERT INTO customer_permissions ("customerId","permissionId") VALUES ($1,$2)',
    [CUSTOMER, perms['devices:read']]);
  ok('restoring the grant allows again', await can(customerUser, ['devices:read']));

  section('3. The subscription can veto a granted permission');
  const noDevices = { hasFeature: (k: string) => k !== 'devices' } as any;
  ok('plan without the devices feature drops devices:read despite both grants',
    !(await can(customerUser, ['devices:read'], noDevices)));

  section('4. Admin bypass');
  ok('tenant_admin passes without any grant', await can(tenantAdmin, ['devices:delete']));
  ok('super_admin passes without any grant', await can(superAdmin, ['devices:delete']));

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
