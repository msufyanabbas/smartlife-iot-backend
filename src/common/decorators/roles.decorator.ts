// src/common/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@common/enums/index.enum';

export const ROLES_KEY = 'roles';

/**
 * @Roles()
 * Restricts a route to specific system roles.
 * Read by RolesGuard (global).
 *
 * @example
 * @Roles(UserRole.TENANT_ADMIN)
 * @Post('customers')
 * createCustomer() { ... }
 *
 * @Roles(UserRole.TENANT_ADMIN, UserRole.CUSTOMER_ADMIN)
 * @Get('devices')
 * listDevices() { ... }
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);