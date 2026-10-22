// src/common/guards/customer-access.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { User } from '@modules/index.entities';
import { UserRole } from '@common/enums/index.enum';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Reflector } from '@nestjs/core';
import { isCustomerScopedRole } from '@common/scoping/apply-access-scope';

/**
 * Refuses a customer-scoped caller that names someone else's customer in the
 * URL, and nothing else.
 *
 * ── It used to compute a filter that nobody read ──────────────────────────
 * This guard set `request.customerFilter = { tenantId, customerId }` and
 * `TenantIsolationGuard` set `request.tenantFilter` — and NOTHING in the
 * codebase ever read either one. Every service resolves its own scope from
 * `@CurrentUser()` (now through `applyAccessScope`), which is the right place
 * for it: a guard cannot know which column of which table holds the tenant.
 *
 * A guard that computes an authorization filter nobody applies is worse than
 * no guard at all, because the comments it carries ("Services use that
 * filter") read like a scoping mechanism and invite the next person to leave
 * the predicate out of a query. Both writes are gone.
 *
 * ── It also locked out an entire role ─────────────────────────────────────
 * The final branch threw `Access denied: insufficient role` for anything that
 * was not SUPER_ADMIN, TENANT_ADMIN, CUSTOMER or CUSTOMER_USER — which is the
 * plain `USER` role. This guard is registered as an APP_GUARD, so it runs on
 * every request: a tenant-level user with no customer was refused the whole
 * API, including the routes whose `@Roles` explicitly list `UserRole.USER`
 * (`GET /devices`, `GET /assets`, …). A tenant-level user with no customer is
 * tenant-scoped, not unauthorised; the tenant predicate is applied in the
 * service, by `applyAccessScope`.
 */
@Injectable()
export class CustomerAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin: cross-tenant by design.
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // ── Customer admin / customer user ──────────────────────────────────────
    // The only check this guard can make that a service cannot: the customer
    // named in the URL. Everything else about their scope is a query
    // predicate, not a request-level decision.
    if (isCustomerScopedRole(user.role)) {
      if (!user.customerId) {
        throw new ForbiddenException('User has no customer assigned');
      }

      const requestedCustomerId: string | undefined =
        request.params?.customerId;
      if (requestedCustomerId && requestedCustomerId !== user.customerId) {
        throw new ForbiddenException(
          "Access denied: you cannot access another customer's data",
        );
      }

      return true;
    }

    // ── Tenant admin and plain tenant user ──────────────────────────────────
    // Not confined to one customer. TenantIsolationGuard has already required
    // a tenantId and refused a mismatched one in the URL; the per-row scope is
    // the service's `applyAccessScope` call.
    return true;
  }
}
