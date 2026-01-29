import { User } from "@modules/index.entities";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { UserRole } from "@common/enums/index.enum";

// Ensures users only access their tenant's data
@Injectable()
export class TenantIsolationGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;
    
    // Super admins bypass isolation
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }
    
    // Extract tenantId from request (params, query, or body)
    const requestedTenantId = request.params.tenantId 
      || request.query.tenantId 
      || request.body.tenantId;
    
    // If no tenant specified, auto-inject user's tenant
    if (!requestedTenantId) {
      request.tenantFilter = { tenantId: user.tenantId };
      return true;
    }
    
    // If tenant specified, verify it matches user's tenant
    if (requestedTenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied to this tenant');
    }
    
    return true;
  }
}