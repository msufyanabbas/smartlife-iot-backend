/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE tenant / customer read scope. One function, every read path.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is `DevicesService.applyAccessFilter()` lifted out of the devices
 * module unchanged in behaviour. It is here because the same twelve lines had
 * been hand-written five times — in `DevicesService`, `AssetsService`
 * (twice), `DashboardsService` and `AlarmsService` — and four of the copies
 * had drifted into a leak:
 *
 *   · `AssetsService.findOne()` gave a CUSTOMER_USER a customer predicate and
 *     no tenant predicate, and gave `CUSTOMER` and `USER` no predicate at
 *     all — either role read any asset on the platform by uuid.
 *   · `DashboardsService.findAll()` matched `visibility = PUBLIC` with no
 *     tenant predicate, listing every tenant's public dashboards.
 *   · `AlarmsService.findAll()` applied the customer predicate only
 *     `if (customerId)`, so a customer-scoped caller whose `customerId` was
 *     missing silently widened to tenant-wide.
 *   · `DevicesService.findAll()` applied the tenant predicate only
 *     `if (effectiveTenantId)`, with the same consequence one level up.
 *
 * Copying it a sixth time is what this file exists to stop.
 *
 * ── The two rules, and why they are rules ─────────────────────────────────
 *
 * 1. **A falsy scope value DENIES. It never widens.** `if (user.tenantId)
 *    qb.andWhere(...)` leaves the query unscoped for exactly the caller it
 *    was meant to confine. Only `SUPER_ADMIN` is legitimately tenant-less,
 *    and that case returns before anything else runs. The same holds one
 *    level down: a CUSTOMER or CUSTOMER_USER with no `customerId` gets
 *    `1 = 0`, not "everything in the tenant". (CLAUDE.md §4g.)
 *
 * 2. **A row outside the scope is ABSENT, not forbidden.** This produces a
 *    predicate, so a detail read answers 404 rather than 403 and cannot be
 *    used to confirm that an id exists.
 *
 * Both rules are asserted against a real Postgres by
 * `npm run verify:access-scoping`.
 */
import type { SelectQueryBuilder } from 'typeorm';
import { UserRole } from '@common/enums/index.enum';

/**
 * The three fields a scope decision needs. A `User` entity satisfies it
 * structurally, and so does a JWT payload or a socket's `data` — the helper
 * deliberately does not demand the whole entity.
 */
export interface AccessScopePrincipal {
  role?: UserRole | string | null;
  tenantId?: string | null;
  customerId?: string | null;
}

export interface AccessScopeOptions {
  /** Entity property holding the tenant. Default `tenantId`. */
  tenantColumn?: string;

  /** Entity property holding the customer. Default `customerId`. */
  customerColumn?: string;

  /**
   * Whether a customer-scoped caller also sees rows with NO customer, i.e.
   * tenant-wide rows: `(x.customerId = :id OR x.customerId IS NULL)`.
   *
   * Off by default, because for a device or an asset an unassigned row is
   * tenant-level inventory a customer must not see. Reports turn it on: a
   * report template with no customer is a tenant-wide template every
   * customer of that tenant is meant to be able to run.
   *
   * It does NOT weaken rule 1 — a falsy `customerId` still denies.
   */
  includeUnassigned?: boolean;

  /**
   * An extra disjunct for the CUSTOMER / CUSTOMER_USER branch: rows that
   * caller may also see *inside its own tenant*, expressed in the calling
   * module's own vocabulary.
   *
   * Dashboards need it — a dashboard is visible to its owner and, when it is
   * `PUBLIC`, to the whole tenant — and that rule cannot live here without
   * dragging `visibility` and `userId` into a common helper. It is ANDed
   * after the tenant predicate, so it can only ever widen *within* the
   * tenant, and a falsy `customerId` still denies everything before this is
   * reached.
   *
   * Use parameter names that cannot collide with the caller's own.
   */
  alsoVisible?: { sql: string; params?: Record<string, unknown> };
}

/** Roles whose reads are confined to a single customer. */
export function isCustomerScopedRole(
  role: UserRole | string | null | undefined,
): boolean {
  return role === UserRole.CUSTOMER || role === UserRole.CUSTOMER_USER;
}

/**
 * Applies the caller's tenant and customer scope to `qb`.
 *
 * Call it ONCE per query, and do not add manual tenant/customer `andWhere`
 * clauses on top of it. Pure in the sense that matters: it reads nothing but
 * its arguments and only ever narrows the query it is given.
 */
export function applyAccessScope<T extends object>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  user: AccessScopePrincipal | null | undefined,
  options: AccessScopeOptions = {},
): void {
  const {
    tenantColumn = 'tenantId',
    customerColumn = 'customerId',
    includeUnassigned = false,
    alsoVisible,
  } = options;

  // No resolvable principal means no access. Failing open here would restore
  // every hole this helper closes at once.
  if (!user) {
    qb.andWhere('1 = 0');
    return;
  }

  // The one legitimate cross-tenant role. Checked first, because it is also
  // the only role allowed to have no tenantId.
  if (user.role === UserRole.SUPER_ADMIN) return;

  if (!user.tenantId) {
    qb.andWhere('1 = 0');
    return;
  }

  qb.andWhere(`${alias}.${tenantColumn} = :accessScopeTenantId`, {
    accessScopeTenantId: user.tenantId,
  });

  if (!isCustomerScopedRole(user.role)) return;

  if (!user.customerId) {
    // A customer-scoped role with no customer assignment can see nothing.
    // This is the branch every drifted copy got wrong.
    qb.andWhere('1 = 0');
    return;
  }

  const own = includeUnassigned
    ? `(${alias}.${customerColumn} = :accessScopeCustomerId OR ${alias}.${customerColumn} IS NULL)`
    : `${alias}.${customerColumn} = :accessScopeCustomerId`;

  if (alsoVisible) {
    qb.andWhere(`(${own} OR ${alsoVisible.sql})`, {
      accessScopeCustomerId: user.customerId,
      ...(alsoVisible.params ?? {}),
    });
    return;
  }

  qb.andWhere(own, { accessScopeCustomerId: user.customerId });
}

/**
 * The same decision for a row already in hand, for the paths that cannot
 * express it as a predicate (a single `findOne` by primary key, an entity
 * handed over by another service).
 *
 * Returns true when the caller may see the row. The caller answers 404 on
 * false — never 403, see rule 2 above.
 */
export function isWithinAccessScope(
  row: { tenantId?: string | null; customerId?: string | null } | null | undefined,
  user: AccessScopePrincipal | null | undefined,
  options: { includeUnassigned?: boolean } = {},
): boolean {
  if (!row || !user) return false;
  if (user.role === UserRole.SUPER_ADMIN) return true;
  if (!user.tenantId || row.tenantId !== user.tenantId) return false;
  if (!isCustomerScopedRole(user.role)) return true;
  if (!user.customerId) return false;
  if (row.customerId === user.customerId) return true;
  return options.includeUnassigned === true && !row.customerId;
}
