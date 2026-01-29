import { User } from "@modules/index.entities";
import { UserRole } from "@common/enums/index.enum";
import { UsersService } from "@modules/index.service";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSIONS_KEY } from "@common/decorators/index.decorator";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private usersService: UsersService,
  ) {}
  
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.get<string[]>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );
    
    if (!requiredPermissions) return true;
    
    const request = context.switchToHttp().getRequest();
    const user: User = request.user;
    
    // Super admins have all permissions
    if (user.role === UserRole.SUPER_ADMIN) {
      return true;
    }
    
    // Get user's permissions through their roles
    // const userPermissions = await this.usersService.getUserPermissions(user.id);
    
    // const hasPermission = requiredPermissions.every(permission =>
    //   userPermissions.includes(permission)
    // );
    
    // if (!hasPermission) {
    //   throw new ForbiddenException(
    //     `Required permissions: ${requiredPermissions.join(', ')}`
    //   );
    // }
    
    return true;
  }
}