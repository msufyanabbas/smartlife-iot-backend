// src/common/decorators/permission.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * @RequirePermissions()
 * Requires specific permission strings to access a route.
 * Permissions are in the format 'resource:action'.
 * Read by PermissionGuard (global).
 *
 * Only enforced for CUSTOMER_ADMIN and CUSTOMER_USER roles.
 * SUPER_ADMIN and TENANT_ADMIN bypass this check entirely.
 *
 * @example
 * @RequirePermissions('devices:read')
 * @Get('devices')
 * listDevices() { ... }
 *
 * @RequirePermissions('devices:create')
 * @Post('devices')
 * createDevice() { ... }
 *
 * @RequirePermissions('dashboards:read', 'devices:read')
 * @Get('dashboard-with-devices')
 * getDashboardWithDevices() { ... }
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);