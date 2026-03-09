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

@Injectable()
export class CustomerAccessGuard implements CanActivate {
  constructor(private reflector: Reflector){}
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin: full access, no filter injected
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // ── Tenant admin ──────────────────────────────────────────────────────────
    // Can access ALL customers within their own tenant.
    // TenantIsolationGuard already set request.tenantFilter = { tenantId: user.tenantId }.
    // Services use that filter — this guard doesn't need to add anything more.
    // The service layer must verify: customer.tenantId === user.tenantId.
    if (user.role === UserRole.TENANT_ADMIN) {
      request.customerFilter = { tenantId: user.tenantId };
      return true;
    }

    // ── Customer admin / customer user ────────────────────────────────────────
    // Scoped to their own customer only.
    if (
      user.role === UserRole.CUSTOMER ||
      user.role === UserRole.CUSTOMER_USER
    ) {
      if (!user.customerId) {
        throw new ForbiddenException('User has no customer assigned');
      }

      // If a specific customer is requested via route param, verify it matches
      const requestedCustomerId: string | undefined = request.params?.customerId;
      if (requestedCustomerId && requestedCustomerId !== user.customerId) {
        throw new ForbiddenException(
          'Access denied: you cannot access another customer\'s data',
        );
      }

      // Inject customer scope — services use this to filter queries
      request.customerFilter = {
        tenantId: user.tenantId,
        customerId: user.customerId,
      };

      return true;
    }

    // Unknown role — deny explicitly with an error, not a silent false
    throw new ForbiddenException('Access denied: insufficient role');
  }
}