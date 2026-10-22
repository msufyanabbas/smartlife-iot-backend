/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: a tenant can grant a customer permissions, and they take effect
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `PermissionGuard` resolves a customer-scoped user to
 *
 *     (role permissions ∪ direct permissions) ∩ customer.grantedPermissions
 *
 * `grantedPermissions` is the join table `customer_permissions`, and **nothing
 * in the product ever wrote a row to it**. `GrantCustomerPermissionsDto` was
 * declared and referenced by no controller; the customer detail page rendered
 * the matrix as static text. So every customer created through the product
 * held an empty set, the intersection was empty, and every one of the ~690
 * permission-gated handlers answered 403 for every user beneath that
 * customer — regardless of which roles they were given.
 *
 * It was worse than a dead screen: `AssignmentService.enforcePermissionGate`
 * refuses to assign a device or asset to a customer that lacks the matching
 * grant, so the whole "each customer sees their own things" mechanism was
 * blocked at the first gate too.
 *
 * This proves the chain end to end, against a real database and the real
 * guard: a grant is written, the guard honours it, revoking it denies again,
 * and a customer cannot be granted authority over the tenant that owns it.
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/verify-customer-permissions.ts [db]
 */
import { randomUUID } from 'crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

import * as entities from '../src/modules/index.entities';
import { Customer } from '../src/modules/customers/entities/customers.entity';
import { Permission } from '../src/modules/permissions/entities/permissions.entity';
import { User } from '../src/modules/users/entities/user.entity';
import { CustomersService } from '../src/modules/customers/customers.service';
import { PermissionGuard } from '../src/common/guards/permission.guard';
import { PermissionCacheService } from '../src/lib/redis/permission-cache.service';
import { PERMISSIONS_KEY } from '../src/common/decorators/index.decorator';
import { UserRole, UserStatus } from '../src/common/enums/user.enum';
import { inMemoryRedis } from './support/in-memory-redis';

const database = process.argv[2] ?? 'custperms';

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail?: unknown) => {
  checks++;
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.error(`  \u001b[31m✗\u001b[0m ${label}`, detail ?? '');
  }
};
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ADMIN_A = randomUUID();
const CUSTOMER_A = randomUUID();
const CUST_USER = randomUUID();

(async () => {
  const dataSource = new DataSource({
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
  await dataSource.initialize();
  const q = (sql: string, p: any[] = []) => dataSource.query(sql, p);

  // Swept by name prefix, not just this run's ids: `tenants.name` is UNIQUE,
  // so one crashed run would otherwise make every later run fail on a
  // duplicate key that says nothing about permissions.
  const stale = `SELECT id FROM tenants WHERE name LIKE 'custperm-%'`;
  await q(`DELETE FROM customer_permissions WHERE "customerId" IN (SELECT id FROM customers WHERE "tenantId" IN (${stale}))`);
  await q(`DELETE FROM user_roles WHERE "userId" IN (SELECT id FROM users WHERE "tenantId" IN (${stale}))`);
  await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM customers WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM tenants WHERE name LIKE 'custperm-%'`);

  for (const [id, label] of [
    [TENANT_A, 'a'],
    [TENANT_B, 'b'],
  ] as const) {
    await q('INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)', [
      id,
      `custperm-${label}-${id.slice(0, 8)}`,
      `${label}-${id.slice(0, 8)}@example.test`,
    ]);
  }

  await q(
    `INSERT INTO customers (id, name, email, "tenantId", status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [CUSTOMER_A, `custperm-cust-${CUSTOMER_A.slice(0, 8)}`, `c-${CUSTOMER_A.slice(0, 8)}@example.test`, TENANT_A],
  );

  const mkUser = (id: string, role: UserRole, tenantId: string, customerId: string | null) =>
    q(
      `INSERT INTO users (id, name, email, password, role, status, "tenantId", "customerId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        `u-${id.slice(0, 8)}`,
        `u-${id.slice(0, 8)}@example.test`,
        'not-a-real-hash',
        role,
        UserStatus.ACTIVE,
        tenantId,
        customerId,
      ],
    );
  await mkUser(ADMIN_A, UserRole.TENANT_ADMIN, TENANT_A, null);
  await mkUser(CUST_USER, UserRole.CUSTOMER_USER, TENANT_A, CUSTOMER_A);

  // Give the customer user a DIRECT permission, so the only variable under
  // test is the customer grant. Without this the test could pass because the
  // user has nothing, which proves nothing.
  const permRepo = dataSource.getRepository(Permission);

  /**
   * Seed only what this script needs, rather than requiring the full catalogue
   * seeder to have run. A verification that depends on a separate seeding step
   * is one that gets reported as broken the first time someone runs it against
   * a fresh database.
   *
   * `resource`+`action` is unique per tenant, so an existing row is reused.
   */
  const permission = async (resource: string, action: string): Promise<Permission> => {
    const existing = await permRepo.findOne({ where: { resource, action } });
    if (existing) return existing;
    return permRepo.save(
      permRepo.create({
        name: `${resource}:${action}`,
        resource,
        action,
        description: `${action} ${resource}`,
      } as Partial<Permission>),
    );
  };

  // The customer-facing one under test, plus enough of the catalogue for the
  // default-grant and grantable-catalogue assertions to be meaningful.
  const devicesRead = await permission('devices', 'read');
  await permission('devices', 'list');
  await permission('devices', 'delete');
  await permission('assets', 'read');
  await permission('dashboards', 'read');
  // A tenant-administration one, which must never be grantable to a customer.
  const usersDelete = await permission('users', 'delete');
  await permission('roles', 'manage');

  await q('INSERT INTO user_permissions ("userId","permissionId") VALUES ($1,$2)', [
    CUST_USER,
    devicesRead.id,
  ]);

  const customersService = new CustomersService(
    dataSource.getRepository(Customer) as any,
    dataSource.getRepository(User) as any,
    permRepo as any,
    {} as any, // TenantsService — unused by the grant methods
    { emit: () => true } as any,
    {} as any, // MailService
    {} as any, // UsersService
    {} as any, // SubscriptionsService
    dataSource,
  );

  const admin = { id: ADMIN_A, role: UserRole.TENANT_ADMIN, tenantId: TENANT_A } as any;

  // ── The guard, wired exactly as the application wires it ────────────────
  const cache = new PermissionCacheService(inMemoryRedis());
  const guard = new PermissionGuard(
    {
      getAllAndOverride: (key: string) =>
        key === PERMISSIONS_KEY ? (currentRequired as any) : undefined,
    } as unknown as Reflector,
    dataSource.getRepository(Customer) as any,
    dataSource.getRepository(User) as any,
    cache,
  );

  let currentRequired: string[] | undefined;

  const can = async (userId: string, required: string[]): Promise<boolean> => {
    currentRequired = required;
    // Grants changed between calls, and the cache is keyed by an epoch the
    // services bump. A script writing the join table directly gets no
    // subscriber, so it bumps by hand — exactly as any ORM-bypassing writer
    // must.
    await cache.bumpTenant(TENANT_A);
    await cache.bumpGlobal();

    const user = await dataSource
      .getRepository(User)
      .findOne({ where: { id: userId } });

    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;

    try {
      return await guard.canActivate(context);
    } catch {
      return false;
    }
  };

  // ── 1. The defect, reproduced ───────────────────────────────────────────
  section('1. An ungranted customer denies everything');

  ok(
    'the customer starts with no grants',
    (await customersService.getGrantedPermissions(admin, CUSTOMER_A)).length === 0,
  );
  ok(
    'so its user is denied devices:read EVEN THOUGH they hold it directly',
    (await can(CUST_USER, ['devices:read'])) === false,
    'this is the reported bug: the intersection with an empty set is empty',
  );

  // ── 2. The fix ──────────────────────────────────────────────────────────
  section('2. Granting the customer makes the user’s permission effective');

  await customersService.setGrantedPermissions(admin, CUSTOMER_A, [devicesRead.id]);

  ok(
    'the grant is persisted',
    (await customersService.getGrantedPermissions(admin, CUSTOMER_A)).length === 1,
  );
  ok(
    'the same user is now ALLOWED devices:read',
    (await can(CUST_USER, ['devices:read'])) === true,
    'the grant did not take effect',
  );
  ok(
    'a permission the user does not hold is still denied',
    (await can(CUST_USER, ['devices:delete'])) === false,
    'the grant is a ceiling, not a source — it must not widen the user',
  );

  // ── 3. Revocation ───────────────────────────────────────────────────────
  section('3. Revoking is a real revocation, not an append');

  await customersService.setGrantedPermissions(admin, CUSTOMER_A, []);
  ok(
    'the grant set is empty again',
    (await customersService.getGrantedPermissions(admin, CUSTOMER_A)).length === 0,
    'PUT is a full replacement — an untick must remove',
  );
  ok(
    'and the user is denied again',
    (await can(CUST_USER, ['devices:read'])) === false,
  );

  // ── 4. A customer may not be granted authority over its tenant ──────────
  section('4. Tenant-administration permissions are refused');

  let refused = false;
  try {
    await customersService.setGrantedPermissions(admin, CUSTOMER_A, [usersDelete.id]);
  } catch {
    refused = true;
  }
  ok(
    'granting users:delete to a customer is refused server-side',
    refused,
    'the UI hides these, but a crafted request must not be able to grant them',
  );
  ok(
    'and nothing was written by the refused call',
    (await customersService.getGrantedPermissions(admin, CUSTOMER_A)).length === 0,
  );

  let unknownRefused = false;
  try {
    await customersService.setGrantedPermissions(admin, CUSTOMER_A, [randomUUID()]);
  } catch {
    unknownRefused = true;
  }
  ok(
    'an unknown permission id is refused rather than silently skipped',
    unknownRefused,
    'skipping would show the admin a saved matrix that does not match storage',
  );

  // ── 5. Cross-tenant ─────────────────────────────────────────────────────
  section('5. A tenant cannot edit another tenant’s customer');

  const foreignAdmin = { id: randomUUID(), role: UserRole.TENANT_ADMIN, tenantId: TENANT_B } as any;
  let foreignRefused = false;
  try {
    await customersService.setGrantedPermissions(foreignAdmin, CUSTOMER_A, [devicesRead.id]);
  } catch {
    foreignRefused = true;
  }
  ok('an admin of another tenant is refused', foreignRefused);
  ok(
    'reading it is refused too',
    await (async () => {
      try {
        await customersService.getGrantedPermissions(foreignAdmin, CUSTOMER_A);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // ── 6. The catalogue the picker is built from ───────────────────────────
  section('6. The grantable catalogue excludes tenant administration');

  const grantable = await customersService.getGrantablePermissions(TENANT_A);
  ok('it is not empty', grantable.length > 0, grantable.length);
  ok(
    'it offers customer-facing resources',
    grantable.some((p) => p.resource === 'devices'),
  );
  ok(
    'it offers none of users / roles / permissions / tenants / billing',
    !grantable.some((p) =>
      ['users', 'roles', 'permissions', 'tenants', 'billing', 'audit', 'settings'].includes(
        p.resource,
      ),
    ),
    grantable.filter((p) => ['users', 'roles', 'tenants'].includes(p.resource)),
  );

  // ── 7. A new customer is usable on arrival ──────────────────────────────
  section('7. A newly created customer is not dead on arrival');

  // The baseline seeded by create(). Asserted through the same accessor the
  // product uses, so a change to the default is caught here.
  const seeded = await (customersService as any).defaultGrantedPermissions(TENANT_A);
  ok('the default grant set is non-empty', seeded.length > 0, seeded.length);
  ok(
    'it is read-only — no create/update/delete is granted by default',
    seeded.every((p: Permission) => ['read', 'list'].includes(p.action)),
    seeded.filter((p: Permission) => !['read', 'list'].includes(p.action)).map((p: Permission) => p.permissionString),
  );

  await q(`DELETE FROM customer_permissions WHERE "customerId" = $1`, [CUSTOMER_A]);
  await q(`DELETE FROM user_permissions WHERE "userId" = $1`, [CUST_USER]);
  await q(`DELETE FROM users WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM customers WHERE "tenantId" IN (${stale})`);
  await q(`DELETE FROM tenants WHERE name LIKE 'custperm-%'`);
  await dataSource.destroy();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: customer grants are writable and the guard honours them\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
