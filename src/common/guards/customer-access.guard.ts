import { User } from "@/modules/index.entities";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { UserRole } from '@common/enums/index.enum';

@Injectable()
export class CustomerAccessGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;
    const requestedCustomerId = request.params.customerId;
    
    // Super admin: full access
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }
    
    // Tenant admin: access all customers in their tenant
    if (user.role === UserRole.TENANT_ADMIN) {
      // Service layer should verify customer.tenantId === user.tenantId
      return true;
    }
    
    // Customer roles: only their own customer
    if (user.role === UserRole.CUSTOMER_ADMIN || user.role === UserRole.CUSTOMER_USER) {
      if (!user.customerId) {
        throw new ForbiddenException('User has no customer assigned');
      }
      
      if (requestedCustomerId && user.customerId !== requestedCustomerId) {
        throw new ForbiddenException('Access denied to this customer');
      }
      
      // Auto-inject customer filter
      request.customerFilter = { customerId: user.customerId };
      return true;
    }
    
    return false;
  }
}