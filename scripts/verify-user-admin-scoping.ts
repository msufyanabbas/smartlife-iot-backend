/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Runtime proof: a tenant admin cannot re-privilege outside its own tenant
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   createdb useradminscoping && npm run verify:user-admin-scoping
 *   npx ts-node -T -r tsconfig-paths/register \
 *     scripts/verify-user-admin-scoping.ts [db]
 *
 * Three WRITE holes in the users module took their target and their privilege
 * level out of the request body:
 *
 *   1. `POST /users` took no `@CurrentUser()`. `CreateUserDto` carries `role`
 *      and `tenantId` and `UsersService.create()` trusted both, so anyone
 *      holding `users:create` could mint a `super_admin` or plant an account
 *      inside another tenant. `POST /users/invite` was the same hole again,
 *      one route along.
 *   2. `bulkAssignRole` / `bulkRemoveRole` / `bulkUpdatePermissions` resolved
 *      the role, the permissions AND the users by bare id with no tenant
 *      predicate on either side — and reported `{ updated: n }`, so a silently
 *      dropped id looked like success.
 *   3. There was no single-user role assignment endpoint at all, so the only
 *      path to "assign this role to this user" was the bulk one.
 *
 * ── Why a script and not a unit test ──────────────────────────────────────
 * This codebase's recurring failure mode is code that compiles, reads
 * correctly and does nothing: device authentication that was never called,
 * audit handlers that wrote zero rows. A mocked repository cannot tell the
 * difference between a tenant predicate that is applied and one that is
 * written and then dropped by TypeORM because its value was `undefined`. So
 * everything below the controller is the real thing — real TypeORM
 * repositories, real SQL, a real `PermissionCacheService` over an in-memory
 * Redis — and every denial is confirmed by reading the junction table
 * afterwards. A leak here is a row that exists, not a stack trace.
 *
 * ── The positive controls are not padding ─────────────────────────────────
 * A fix that denied everything would pass a security test and break the
 * product. Roughly half the assertions below are "the legitimate operation
 * still works", including the two directions that are deliberately NOT
 * blocked: a tenant admin appointing a second tenant admin (a tenant with one
 * admin is unrecoverable if that admin is lost — this module already refuses
 * to delete the last one), and a tenant admin REMOVING an over-powerful role
 * (a de-escalation must never be refusable).
 */
import { randomUUID } from 'crypto';
import { DataSource, Repository, ObjectLiteral } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import * as entities from '../src/modules/index.entities';
import { User } from '../src/modules/users/entities/user.entity';
import { Role } from '../src/modules/roles/entities/roles.entity';
import { Permission } from '../src/modules/permissions/entities/permissions.entity';
import { UsersService } from '../src/modules/users/users.service';
import { UsersController } from '../src/modules/users/users.controller';
import { UserRole, UserStatus } from '../src/common/enums/index.enum';
import { PermissionCacheService } from '../src/lib/redis/permission-cache.service';
import { inMemoryRedis } from './support/in-memory-redis';

const database = process.argv[2] ?? 'useradminscoping';

/**
 * Every fixture row is named with this prefix and the sweep runs on it BEFORE
 * the inserts, not only after. `tenants.name` is UNIQUE, so a run that crashes
 * half way through leaves a row that makes every later run fail on the insert
 * rather than on the thing being tested — which looks exactly like a
 * regression and is not one.
 */
const P = 'uas-fixture';

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
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}`);

/**
 * Asserts the call is REFUSED, and says how.
 *
 * `expected` is the HTTP status the refusal must carry, because the status is
 * part of the contract: §4g requires 404 and not 403 for a row outside the
 * caller's scope — a 403 confirms the id exists elsewhere and turns the route
 * into an enumeration oracle. A call that RESOLVES is the failure mode this
 * whole script exists to catch, so it is reported as such rather than thrown.
 */
const refuses = async (
  label: string,
  expected: number,
  call: () => Promise<unknown>,
): Promise<void> => {
  try {
    const value = await call();
    ok(label, false, `resolved instead of throwing: ${JSON.stringify(value)}`);
  } catch (err) {
    const status =
      typeof (err as { getStatus?: () => number }).getStatus === 'function'
        ? (err as { getStatus: () => number }).getStatus()
        : 0;
    ok(
      `${label} (${expected})`,
      status === expected,
      status === 0
        ? `not an HttpException: ${(err as Error).message}`
        : `expected ${expected}, got ${status}: ${(err as Error).message}`,
    );
  }
};

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

  const q = (sql: string, params: unknown[] = []) =>
    dataSource.query(sql, params);
  const repo = <T extends ObjectLiteral>(e: new () => T): Repository<T> =>
    dataSource.getRepository(e);

  // ── Sweep by name prefix, FIRST ───────────────────────────────────────────
  const sweep = async () => {
    await q(
      `DELETE FROM user_roles WHERE "roleId" IN (SELECT id FROM roles WHERE name LIKE $1)
          OR "userId" IN (SELECT id FROM users WHERE name LIKE $1)`,
      [`${P}%`],
    );
    await q(
      `DELETE FROM user_permissions WHERE "userId" IN (SELECT id FROM users WHERE name LIKE $1)
          OR "permissionId" IN (SELECT id FROM permissions WHERE description LIKE $1)`,
      [`${P}%`],
    );
    await q(
      `DELETE FROM role_permissions WHERE "roleId" IN (SELECT id FROM roles WHERE name LIKE $1)
          OR "permissionId" IN (SELECT id FROM permissions WHERE description LIKE $1)`,
      [`${P}%`],
    );
    await q(`DELETE FROM roles WHERE name LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM permissions WHERE description LIKE $1`, [`${P}%`]);
    await q(`DELETE FROM users WHERE name LIKE $1 OR email LIKE $2`, [
      `${P}%`,
      `${P}%`,
    ]);
    await q(`DELETE FROM customers WHERE name LIKE $1`, [`${P}%`]);
    await q(
      `DELETE FROM subscriptions WHERE "tenantId" IN (SELECT id FROM tenants WHERE name LIKE $1)`,
      [`${P}%`],
    );
    await q(`DELETE FROM tenants WHERE name LIKE $1`, [`${P}%`]);
  };
  await sweep();

  // ── Fixture graph ─────────────────────────────────────────────────────────
  section('1. Fixture: two tenants, their users, roles and permissions');

  const TENANT_A = randomUUID();
  const TENANT_B = randomUUID();

  for (const [id, label] of [
    [TENANT_A, 'a'],
    [TENANT_B, 'b'],
  ] as const) {
    await q(`INSERT INTO tenants (id, name, email) VALUES ($1, $2, $3)`, [
      id,
      `${P}-tenant-${label}`,
      `${P}-t${label}-${id.slice(0, 8)}@example.invalid`,
    ]);
    // `create()` increments subscriptions.usage.users; the row has to exist or
    // the positive control logs a counter error on every created user.
    await q(
      `INSERT INTO subscriptions (id, "tenantId", plan, status, limits, usage, features)
       VALUES ($1, $2, 'professional', 'active', $3, $4, '{}')`,
      [
        randomUUID(),
        id,
        JSON.stringify({ users: 100 }),
        JSON.stringify({ users: 0 }),
      ],
    );
  }

  const mkUser = async (
    tenantId: string | null,
    role: UserRole,
    label: string,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO users (id, email, password, name, role, status, "tenantId")
       VALUES ($1, $2, 'not-a-real-hash', $3, $4, $5, $6)`,
      [
        id,
        `${P}-${label}-${id.slice(0, 8)}@example.invalid`,
        `${P}-${label}`,
        role,
        UserStatus.ACTIVE,
        tenantId,
      ],
    );
    return id;
  };

  const adminAId = await mkUser(TENANT_A, UserRole.TENANT_ADMIN, 'admin-a');
  const superId = await mkUser(null, UserRole.SUPER_ADMIN, 'super');
  const userA1 = await mkUser(TENANT_A, UserRole.USER, 'user-a1');
  const userA2 = await mkUser(TENANT_A, UserRole.USER, 'user-a2');
  const userB1 = await mkUser(TENANT_B, UserRole.USER, 'user-b1');

  const CUSTOMER_B = randomUUID();
  await q(
    `INSERT INTO customers (id, name, email, "tenantId") VALUES ($1, $2, $3, $4)`,
    [
      CUSTOMER_B,
      `${P}-customer-b`,
      `${P}-cb-${CUSTOMER_B.slice(0, 8)}@example.invalid`,
      TENANT_B,
    ],
  );

  /** Permissions. `description` carries the prefix so the sweep can find them. */
  const mkPermission = async (
    resource: string,
    action: string,
    tenantId: string | null,
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO permissions (id, resource, action, description, "isSystem", "tenantId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        `${P}_${resource}`,
        action,
        `${P} ${resource}:${action}`,
        tenantId === null,
        tenantId,
      ],
    );
    return id;
  };

  // `resource` is prefixed so these rows cannot collide with the real seeded
  // catalogue, but the PLATFORM-level one must carry the real resource name —
  // that string is what the service's ceiling is expressed in terms of.
  const permBenign = await mkPermission('devices', 'read', null);
  const permTenantB = await mkPermission('devices', 'update', TENANT_B);
  const permPlatformId = randomUUID();
  await q(
    `INSERT INTO permissions (id, resource, action, description, "isSystem", "tenantId")
     VALUES ($1, 'tenants', 'delete', $2, true, NULL)`,
    [permPlatformId, `${P} tenants:delete`],
  );

  const mkRole = async (
    label: string,
    tenantId: string | null,
    permissionIds: string[],
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO roles (id, name, description, "isSystem", "tenantId")
       VALUES ($1, $2, $3, $4, $5)`,
      [id, `${P}-role-${label}`, `${P} ${label}`, tenantId === null, tenantId],
    );
    for (const permissionId of permissionIds) {
      await q(
        `INSERT INTO role_permissions ("roleId", "permissionId") VALUES ($1, $2)`,
        [id, permissionId],
      );
    }
    return id;
  };

  const roleA = await mkRole('custom-a', TENANT_A, [permBenign]);
  const roleB = await mkRole('custom-b', TENANT_B, [permBenign]);
  const roleSystem = await mkRole('system-benign', null, [permBenign]);
  // The seeded "Super Administrator" and "Platform Administrator" in the shape
  // that matters: a SYSTEM role (tenantId IS NULL, so visible to every tenant)
  // that carries a platform-level permission.
  const rolePlatform = await mkRole('system-platform', null, [permPlatformId]);

  ok('fixture graph inserted', true);

  // ── The services, wired by hand ───────────────────────────────────────────
  // Booting the application needs a reachable Kafka broker, so the service is
  // constructed directly. Everything that decides access is real.
  const redis = inMemoryRedis();
  const permissionCache = new PermissionCacheService(redis);
  const mailed: string[] = [];
  const mailService = {
    sendEmail: async (m: { to: string }) => {
      mailed.push(m.to);
    },
  } as any;
  const usageCalls: Array<[string, string, number]> = [];
  const subscriptionsService = {
    incrementTenantUsage: async (t: string, k: string, n: number) => {
      usageCalls.push([t, k, n]);
    },
    decrementTenantUsage: async (t: string, k: string, n: number) => {
      usageCalls.push([t, k, -n]);
    },
  } as any;

  const usersService = new UsersService(
    repo(User),
    new EventEmitter2(),
    mailService,
    repo(Role),
    repo(Permission),
    {} as any, // NotificationsService — untouched by these paths
    subscriptionsService,
    { get: () => 'http://localhost' } as any, // ConfigService
    dataSource,
    permissionCache,
  );

  /** The actors, as `@CurrentUser()` hands them to a controller. */
  const adminA = {
    id: adminAId,
    role: UserRole.TENANT_ADMIN,
    tenantId: TENANT_A,
    email: `${P}-admin-a@example.invalid`,
  } as User;
  const superAdmin = {
    id: superId,
    role: UserRole.SUPER_ADMIN,
    tenantId: undefined,
    email: `${P}-super@example.invalid`,
  } as User;
  /** The §4g case: a non-super-admin whose tenantId is missing. */
  const tenantlessAdmin = {
    id: adminAId,
    role: UserRole.TENANT_ADMIN,
    tenantId: undefined,
    email: `${P}-tenantless@example.invalid`,
  } as User;

  const email = (label: string) => `${P}-${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const roleIdsOf = async (userId: string): Promise<string[]> => {
    const rows: Array<{ roleId: string }> = await q(
      `SELECT "roleId" FROM user_roles WHERE "userId" = $1`,
      [userId],
    );
    return rows.map((r) => r.roleId).sort();
  };
  const permIdsOf = async (userId: string): Promise<string[]> => {
    const rows: Array<{ permissionId: string }> = await q(
      `SELECT "permissionId" FROM user_permissions WHERE "userId" = $1`,
      [userId],
    );
    return rows.map((r) => r.permissionId).sort();
  };
  const same = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const tenantOf = async (userId: string): Promise<string | null> => {
    const rows: Array<{ tenantId: string | null }> = await q(
      `SELECT "tenantId" FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.tenantId ?? null;
  };
  const roleOf = async (userId: string): Promise<string | null> => {
    const rows: Array<{ role: string }> = await q(
      `SELECT role FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.role ?? null;
  };
  const epoch = async (tenantId: string): Promise<number> =>
    Number((await redis.get(`perm:epoch:${tenantId}`)) ?? 0);

  // ═══════════════════════════════════════════════════════════════════════════
  section('2. HOLE 1 — POST /users cannot escalate or cross tenants');

  await refuses(
    'a tenant admin CANNOT create a super_admin',
    403,
    () =>
      usersService.create(
        { email: email('mint-super'), password: 'Password123!', name: `${P}-mint-super`, role: UserRole.SUPER_ADMIN },
        adminA,
      ),
  );
  ok(
    'and no such user row was written',
    (
      await q(`SELECT id FROM users WHERE role = 'super_admin' AND name LIKE $1`, [
        `${P}-mint-super%`,
      ])
    ).length === 0,
  );

  const plantedEmail = email('planted');
  const planted = await usersService.create(
    {
      email: plantedEmail,
      password: 'Password123!',
      name: `${P}-planted`,
      // The body names the OTHER tenant. This is the create hole verbatim.
      tenantId: TENANT_B,
      role: UserRole.USER,
    },
    adminA,
  );
  ok(
    'a tenantId naming another tenant is FORCED to the actor\'s own tenant',
    (await tenantOf(planted.id)) === TENANT_A,
    `landed in ${await tenantOf(planted.id)}, expected ${TENANT_A}`,
  );

  await refuses(
    'a customerId belonging to another tenant is refused',
    404,
    () =>
      usersService.create(
        {
          email: email('foreign-customer'),
          password: 'Password123!',
          name: `${P}-foreign-customer`,
          customerId: CUSTOMER_B,
        },
        adminA,
      ),
  );

  await refuses(
    'an actor with no tenantId cannot create at all (§4g: falsy denies)',
    403,
    () =>
      usersService.create(
        { email: email('tenantless'), password: 'Password123!', name: `${P}-tenantless-target` },
        tenantlessAdmin,
      ),
  );

  await refuses(
    'POST /users/invite is closed too — the same hole one route along',
    403,
    () =>
      usersService.inviteUser(
        { email: email('invite-super'), name: `${P}-invite-super`, role: UserRole.SUPER_ADMIN, tenantId: TENANT_B },
        adminA,
      ),
  );

  section('2b. …and the legitimate creates still work');

  const plainUser = await usersService.create(
    { email: email('plain'), password: 'Password123!', name: `${P}-plain`, role: UserRole.USER },
    adminA,
  );
  ok(
    'a tenant admin can create an ordinary user in its own tenant',
    (await tenantOf(plainUser.id)) === TENANT_A &&
      (await roleOf(plainUser.id)) === UserRole.USER,
  );

  const secondAdmin = await usersService.create(
    { email: email('second-admin'), password: 'Password123!', name: `${P}-second-admin`, role: UserRole.TENANT_ADMIN },
    adminA,
  );
  ok(
    'a tenant admin CAN appoint a second tenant admin in its own tenant',
    (await roleOf(secondAdmin.id)) === UserRole.TENANT_ADMIN &&
      (await tenantOf(secondAdmin.id)) === TENANT_A,
    'deliberate: equal rank is allowed. A tenant that cannot appoint a ' +
      'second admin has a bus factor of one, and this module already refuses ' +
      'to delete or deactivate the last one.',
  );

  const placedInB = await usersService.create(
    { email: email('super-placed'), password: 'Password123!', name: `${P}-super-placed`, tenantId: TENANT_B, role: UserRole.TENANT_ADMIN },
    superAdmin,
  );
  ok(
    'a SUPER_ADMIN may still name the tenant, and any role',
    (await tenantOf(placedInB.id)) === TENANT_B,
  );

  const defaulted = await usersService.create(
    { email: email('defaulted'), password: 'Password123!', name: `${P}-defaulted` },
    adminA,
  );
  ok(
    'omitting `role` still falls through to the column default',
    (await roleOf(defaulted.id)) === UserRole.CUSTOMER_USER,
    await roleOf(defaulted.id),
  );
  ok(
    'the subscription counter is still incremented (quota stays honest)',
    usageCalls.some(([t, k, n]) => t === TENANT_A && k === 'users' && n === 1),
    usageCalls,
  );
  ok(
    'the verification email is still sent',
    mailed.includes(plainUser.email),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('3. HOLE 2 — bulk role assignment is scoped on BOTH sides');

  await refuses(
    'a tenant-A admin CANNOT assign tenant B\'s custom role',
    404,
    () => usersService.bulkAssignRole({ userIds: [userA1], roleId: roleB }, adminA),
  );
  ok(
    'and the junction table is untouched',
    same(await roleIdsOf(userA1), []),
    await roleIdsOf(userA1),
  );

  await refuses(
    'a tenant-A admin CANNOT assign a role to a tenant-B user',
    404,
    () => usersService.bulkAssignRole({ userIds: [userB1], roleId: roleA }, adminA),
  );
  ok(
    'and the tenant-B user gained nothing',
    same(await roleIdsOf(userB1), []),
    await roleIdsOf(userB1),
  );

  await refuses(
    'a tenant-A admin CANNOT assign a system role carrying tenants:delete',
    403,
    () => usersService.bulkAssignRole({ userIds: [userA1], roleId: rolePlatform }, adminA),
  );
  ok(
    'and no platform role was attached',
    same(await roleIdsOf(userA1), []),
    'this is the escalation: grant it to a throwaway account, log in as that ' +
      'account, delete every organisation on the platform',
  );

  await refuses(
    'an unknown role uuid is refused',
    404,
    () => usersService.bulkAssignRole({ userIds: [userA1], roleId: randomUUID() }, adminA),
  );
  await refuses(
    'a malformed role id is refused, not a 500 from Postgres',
    404,
    () => usersService.bulkAssignRole({ userIds: [userA1], roleId: 'not-a-uuid' }, adminA),
  );
  await refuses(
    'a malformed user id is refused, not a 500 from Postgres',
    404,
    () => usersService.bulkAssignRole({ userIds: ['../../etc/passwd'], roleId: roleA }, adminA),
  );

  section('3b. A mixed batch is REFUSED, not partially applied');

  await refuses(
    'one foreign id refuses the whole request',
    404,
    () =>
      usersService.bulkAssignRole(
        { userIds: [userA1, userB1], roleId: roleA },
        adminA,
      ),
  );
  ok(
    'the in-scope user in that same batch was NOT silently updated',
    same(await roleIdsOf(userA1), []),
    'refusing beats skipping: `{ updated: 1 }` for a two-id request showed ' +
      'the administrator a success for a change that half happened',
  );

  section('3c. …and the legitimate assignments still work');

  const epochBefore = await epoch(TENANT_A);
  const assigned = await usersService.bulkAssignRole(
    { userIds: [userA1, userA2], roleId: roleA },
    adminA,
  );
  ok(
    'a tenant admin CAN assign its own tenant\'s role to its own users',
    assigned.updated === 2 &&
      same(await roleIdsOf(userA1), [roleA]) &&
      same(await roleIdsOf(userA2), [roleA]),
    assigned,
  );
  ok(
    'the permission cache was invalidated (epoch moved)',
    (await epoch(TENANT_A)) > epochBefore,
    `epoch ${epochBefore} → ${await epoch(TENANT_A)}`,
  );

  const sysAssigned = await usersService.bulkAssignRole(
    { userIds: [userA1], roleId: roleSystem },
    adminA,
  );
  ok(
    'a benign SYSTEM role is still assignable — it is the shared vocabulary',
    sysAssigned.updated === 1 && same(await roleIdsOf(userA1), [roleA, roleSystem]),
    await roleIdsOf(userA1),
  );

  const superCross = await usersService.bulkAssignRole(
    { userIds: [userA1, userB1], roleId: roleSystem },
    superAdmin,
  );
  ok(
    'a SUPER_ADMIN is still cross-tenant by design',
    superCross.updated === 2 && same(await roleIdsOf(userB1), [roleSystem]),
    await roleIdsOf(userB1),
  );

  section('3d. Role REMOVAL: scoped, but never blocked by the ceiling');

  await refuses(
    'a tenant-A admin cannot remove a role from a tenant-B user',
    404,
    () => usersService.bulkRemoveRole({ userIds: [userB1], roleId: roleSystem }, adminA),
  );
  ok(
    'the tenant-B user still holds it',
    same(await roleIdsOf(userB1), [roleSystem]),
  );

  const removed = await usersService.bulkRemoveRole(
    { userIds: [userA1], roleId: roleSystem },
    adminA,
  );
  ok(
    'a tenant admin CAN remove a role from its own user',
    removed.updated === 1 && same(await roleIdsOf(userA1), [roleA]),
    await roleIdsOf(userA1),
  );

  // The de-escalation direction. A SUPER_ADMIN plants the platform role, then
  // the tenant admin takes it off — which the assignment ceiling must NOT
  // block, or an admin who inherited a bad grant can never undo it.
  await usersService.bulkAssignRole({ userIds: [userA2], roleId: rolePlatform }, superAdmin);
  ok(
    'precondition: the platform role is on a tenant-A user',
    (await roleIdsOf(userA2)).includes(rolePlatform),
  );
  const deEscalated = await usersService.bulkRemoveRole(
    { userIds: [userA2], roleId: rolePlatform },
    adminA,
  );
  ok(
    'a tenant admin CAN strip a platform role it could not have assigned',
    deEscalated.updated === 1 && !(await roleIdsOf(userA2)).includes(rolePlatform),
    'a de-escalation that cannot be performed leaves a bad grant permanent',
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('4. HOLE 2 — direct permissions are scoped on BOTH sides');

  await refuses(
    'a tenant-A admin CANNOT grant tenant B\'s custom permission',
    400,
    () =>
      usersService.bulkUpdatePermissions(
        { userIds: [userA1], permissionIds: [permTenantB], operation: 'add' },
        adminA,
      ),
  );
  ok('and nothing was granted', same(await permIdsOf(userA1), []));

  await refuses(
    'a tenant-A admin CANNOT grant tenants:delete directly',
    403,
    () =>
      usersService.bulkUpdatePermissions(
        { userIds: [userA1], permissionIds: [permPlatformId], operation: 'add' },
        adminA,
      ),
  );
  ok('and nothing was granted', same(await permIdsOf(userA1), []));

  await refuses(
    'a tenant-A admin CANNOT grant to a tenant-B user',
    404,
    () =>
      usersService.bulkUpdatePermissions(
        { userIds: [userB1], permissionIds: [permBenign], operation: 'add' },
        adminA,
      ),
  );
  ok('and the tenant-B user gained nothing', same(await permIdsOf(userB1), []));

  await refuses(
    '`replace` is a grant too and is held to the same ceiling',
    403,
    () =>
      usersService.bulkUpdatePermissions(
        { userIds: [userA1], permissionIds: [permPlatformId], operation: 'replace' },
        adminA,
      ),
  );

  section('4b. …and the legitimate grants still work');

  const permEpochBefore = await epoch(TENANT_A);
  const granted = await usersService.bulkUpdatePermissions(
    { userIds: [userA1, userA2], permissionIds: [permBenign], operation: 'add' },
    adminA,
  );
  ok(
    'a tenant admin CAN grant a system permission to its own users',
    granted.updated === 2 && same(await permIdsOf(userA1), [permBenign]),
    await permIdsOf(userA1),
  );
  ok(
    'the permission cache was invalidated (epoch moved)',
    (await epoch(TENANT_A)) > permEpochBefore,
    `epoch ${permEpochBefore} → ${await epoch(TENANT_A)}`,
  );

  const revoked = await usersService.bulkUpdatePermissions(
    { userIds: [userA1], permissionIds: [permBenign], operation: 'remove' },
    adminA,
  );
  ok(
    'and CAN revoke it again',
    revoked.updated === 1 && same(await permIdsOf(userA1), []),
    await permIdsOf(userA1),
  );

  // Same reasoning as role removal: a revoke only filters what the user
  // already holds, so it cannot escalate and must stay available even for a
  // row the ceiling would refuse to grant.
  await usersService.bulkUpdatePermissions(
    { userIds: [userA2], permissionIds: [permPlatformId], operation: 'add' },
    superAdmin,
  );
  const platformRevoked = await usersService.bulkUpdatePermissions(
    { userIds: [userA2], permissionIds: [permPlatformId], operation: 'remove' },
    adminA,
  );
  ok(
    'a tenant admin CAN revoke a platform permission it could not have granted',
    platformRevoked.updated === 1 &&
      !(await permIdsOf(userA2)).includes(permPlatformId),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section('5. HOLE 3 — the new single-user endpoints');

  // Reset so the single-user assertions read cleanly.
  await usersService.bulkRemoveRole({ userIds: [userA1], roleId: roleA }, superAdmin);
  ok('precondition: tenant-A user holds no roles', same(await roleIdsOf(userA1), []));

  await refuses(
    'POST /users/:id/roles — a tenant-B user is refused',
    404,
    () => usersService.assignRole(userB1, roleA, adminA),
  );
  await refuses(
    'POST /users/:id/roles — tenant B\'s role is refused',
    404,
    () => usersService.assignRole(userA1, roleB, adminA),
  );
  await refuses(
    'POST /users/:id/roles — a platform role is refused',
    403,
    () => usersService.assignRole(userA1, rolePlatform, adminA),
  );
  ok(
    'none of those three wrote a row — the single path is not a bypass',
    same(await roleIdsOf(userA1), []),
    await roleIdsOf(userA1),
  );

  const singleEpochBefore = await epoch(TENANT_A);
  const singleAssigned = await usersService.assignRole(userA1, roleA, adminA);
  ok(
    'POST /users/:id/roles assigns one role to one user',
    singleAssigned.updated === 1 && same(await roleIdsOf(userA1), [roleA]),
    await roleIdsOf(userA1),
  );
  ok(
    'and invalidates the permission cache like the bulk path',
    (await epoch(TENANT_A)) > singleEpochBefore,
    `epoch ${singleEpochBefore} → ${await epoch(TENANT_A)}`,
  );

  const again = await usersService.assignRole(userA1, roleA, adminA);
  ok(
    'assigning a role the user already holds is idempotent, not a duplicate',
    again.updated === 1 && same(await roleIdsOf(userA1), [roleA]),
    await roleIdsOf(userA1),
  );

  await refuses(
    'DELETE /users/:id/roles/:roleId — a tenant-B user is refused',
    404,
    () => usersService.removeRole(userB1, roleSystem, adminA),
  );
  ok(
    'and the tenant-B user keeps its role',
    same(await roleIdsOf(userB1), [roleSystem]),
  );

  const singleRemoved = await usersService.removeRole(userA1, roleA, adminA);
  ok(
    'DELETE /users/:id/roles/:roleId removes it',
    singleRemoved.updated === 1 && same(await roleIdsOf(userA1), []),
    await roleIdsOf(userA1),
  );
  const removeAgain = await usersService.removeRole(userA1, roleA, adminA);
  ok('removing a role the user does not hold is idempotent', removeAgain.updated === 1);

  // ═══════════════════════════════════════════════════════════════════════════
  section('6. Route order (§4o) — read from Nest metadata, not the source');

  // §4o: Nest matches in DECLARATION order, and a parameterised segment above
  // a literal one makes the literal route unreachable dead code. That trap has
  // already produced two dead endpoints here (`POST /devices/batch` and
  // `GET /audit/modules/:module`), so the new routes are checked against the
  // real decorator metadata rather than trusted.
  const proto = UsersController.prototype;
  const routes = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (proto as any)[name];
      return {
        name,
        path: String(Reflect.getMetadata(PATH_METADATA, handler) ?? ''),
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      };
    })
    .filter((r) => r.method !== undefined);

  ok(`${routes.length} routes read off the controller`, routes.length > 0);

  const segments = (p: string) =>
    p.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  /** Does the earlier pattern swallow the later literal path? */
  const captures = (pattern: string, literal: string): boolean => {
    const a = segments(pattern);
    const b = segments(literal);
    if (a.length !== b.length) return false;
    return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
  };

  const shadowed: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (routes[i].method !== routes[j].method) continue;
      // A later route whose path has no parameter is a literal one; if an
      // earlier pattern matches it, it can never be reached.
      if (segments(routes[j].path).some((s) => s.startsWith(':'))) continue;
      if (captures(routes[i].path, routes[j].path)) {
        shadowed.push(`${routes[i].name} (${routes[i].path}) shadows ${routes[j].name} (${routes[j].path})`);
      }
    }
  }
  ok('no literal route is shadowed by an earlier parameterised one', shadowed.length === 0, shadowed);

  const indexOf = (name: string) => routes.findIndex((r) => r.name === name);
  ok(
    'POST :id/roles is declared after every literal POST route',
    routes
      .filter((r) => r.method === RequestMethod.POST && !segments(r.path).some((s) => s.startsWith(':')) && r.path !== '/')
      .every((r) => indexOf(r.name) < indexOf('assignRole')),
    routes.filter((r) => r.method === RequestMethod.POST).map((r) => `${r.name}:${r.path}`),
  );
  ok(
    'DELETE :id/roles/:roleId is declared after the literal DELETE bulk route',
    indexOf('bulkDelete') < indexOf('removeRole'),
  );
  ok(
    'both new routes exist with the paths the frontend will call',
    routes.some((r) => r.name === 'assignRole' && r.method === RequestMethod.POST && r.path === ':id/roles') &&
      routes.some((r) => r.name === 'removeRole' && r.method === RequestMethod.DELETE && r.path === ':id/roles/:roleId'),
    routes.filter((r) => r.name === 'assignRole' || r.name === 'removeRole'),
  );

  await sweep();
  await dataSource.destroy();

  console.log(
    failures === 0
      ? `\n\u001b[32mPASS\u001b[0m — ${checks} checks: user creation and privilege writes are scoped to the actor's tenant, and the legitimate operations still work\n`
      : `\n\u001b[31mFAIL\u001b[0m — ${failures} of ${checks} checks failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('\n\u001b[31mFAIL\u001b[0m — the verifier itself crashed:', error);
  process.exit(1);
});
