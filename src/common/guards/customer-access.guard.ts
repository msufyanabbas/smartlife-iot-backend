import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../modules/users/entities/user.entity';

@Injectable()
export class CustomerAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const requestedCustomerId = request.params.customerId || request.query.customerId;

    // Super Admin and Tenant Admin can access everything
    if (
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.TENANT_ADMIN
    ) {
      return true;
    }

    // Customer users can only access their own customer's resources
    if (user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        throw new ForbiddenException('User has no customer assigned');
      }

      if (requestedCustomerId && user.customerId !== requestedCustomerId) {
        throw new ForbiddenException('Access denied to this customer');
      }

      // Add customerId filter to the request for queries
      request.customerFilter = { customerId: user.customerId };
      return true;
    }

    return true;
  }
}