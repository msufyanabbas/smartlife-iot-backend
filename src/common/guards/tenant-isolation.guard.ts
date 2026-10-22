// src/common/guards/tenant-isolation.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { User } from '@modules/index.entities';
import { UserRole } from '@common/enums/index.enum';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Refuses a caller that names another tenant in the URL, and requires every
 * non-super-admin to belong to a tenant at all.
 *
 * It used to also set `request.tenantFilter = { tenantId }`, documented as
 * "Services read this to scope their queries automatically". Nothing ever
 * read it — not one service, in the whole repository. The write is gone,
 * because a filter that looks like scoping but is applied nowhere is how a
 * query ends up shipping with no tenant predicate at all. Services take their
 * scope from `@CurrentUser()` through `@common/scoping/apply-access-scope`.
 */
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true; // ← add this
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin bypasses tenant isolation — can access any tenant's data
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // Every non-super-admin must belong to a tenant
    if (!user.tenantId) {
      throw new ForbiddenException('User is not associated with a tenant');
    }

    // ── Extract requested tenantId from safe sources only ────────────────────
    //     NEVER read tenantId from request.body — a user could inject any tenant ID.
    //     Only route params and query string are acceptable, and only when the
    //     route explicitly exposes them (e.g. super admin routes).
    //     For all other routes, tenantId comes exclusively from the JWT (user.tenantId).
    const requestedTenantId: string | undefined =
      request.params?.tenantId ||   // e.g. GET /tenants/:tenantId/devices
      request.query?.tenantId;      // e.g. GET /devices?tenantId=xxx (admin routes only)

    // No explicit tenant in the URL — nothing to check here. The per-row
    // tenant predicate is the service's, via `applyAccessScope`.
    if (!requestedTenantId) return true;

    // ── Explicit tenant in URL — verify it matches user's own tenant ──────────
    if (requestedTenantId !== user.tenantId) {
      throw new ForbiddenException(
        'Access denied: you cannot access another tenant\'s data',
      );
    }

    return true;
  }
}