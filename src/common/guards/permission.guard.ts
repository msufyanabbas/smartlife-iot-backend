// src/common/guards/permission.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from '@common/decorators/index.decorator';
import { User, Customer, Subscription } from '@modules/index.entities';
import { SubscriptionFeatures } from '@common/interfaces/index.interface';
import { UserRole } from '@common/enums/index.enum';

// Maps permission resource strings to SubscriptionFeatures keys.
// Resources not listed here have no feature gate — always available.
const RESOURCE_TO_FEATURE: Partial<Record<string, keyof SubscriptionFeatures>> = {
  devices:      'devices',
  dashboards:   'dashboards',
  assets:       'assets',
  floor_plans:  'floorPlans',
  automations:  'automations',
};

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Customer)
    private readonly customersRepo: Repository<Customer>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
    const requiredPermissions = this.reflector.get<string[]>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );

    // No @RequirePermissions() on this route
    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin has all permissions — no checks needed
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // Tenant admin has full access within their tenant
    // Fine-grained permission checks only apply to customer-scoped users
    if (user.role === UserRole.TENANT_ADMIN) return true;

    // Subscription is cached by SubscriptionGuard (runs before this)
    const subscription: Subscription | undefined = request.subscription;

    // ── Resolve effective permissions ────────────────────────────────────────
    const effectivePermissions = await this.resolveEffectivePermissions(user, subscription);

    // ── Check all required permissions are present ────────────────────────────
    const missing = requiredPermissions.filter((p) => !effectivePermissions.has(p));

    if (missing.length > 0) {
      this.logger.warn(
        `User ${user.email} (${user.role}) missing permissions: ${missing.join(', ')}`,
      );
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${missing.join(', ')}`,
      );
    }

    // Cache resolved permissions on request for use in response interceptors
    // (e.g. to filter response fields based on what user can see)
    request.effectivePermissions = effectivePermissions;

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Permission Resolution
  //
  // Effective permissions = union(rolePermissions, directPermissions)
  //   filtered by subscription features
  //   intersected with customer.grantedPermissions (if customer-scoped user)
  // ═══════════════════════════════════════════════════════════════════════════

  private async resolveEffectivePermissions(
    user: User,
    subscription: Subscription | undefined,
  ): Promise<Set<string>> {
    // Load user with roles + permissions if not already loaded
    // JWT payload doesn't carry full permission objects — need DB load
    const fullUser = await this.usersRepo.findOne({
      where: { id: user.id },
      relations: [
        'roles',
        'roles.permissions',
        'directPermissions',
      ],
    });

    if (!fullUser) return new Set();

    // ── Step 1: Collect from roles ────────────────────────────────────────
    const rolePerms = (fullUser.roles ?? []).flatMap(
      (role) => (role.permissions ?? []).map((p) => p.permissionString),
    );

    // ── Step 2: Union with direct permissions ─────────────────────────────
    const directPerms = (fullUser.directPermissions ?? []).map(
      (p) => p.permissionString,
    );

    let permissions = new Set<string>([...rolePerms, ...directPerms]);

    // ── Step 3: Filter by subscription features ───────────────────────────
    // Remove permissions for features not in the subscription plan.
    // e.g. floor_plans:read is dropped if subscription.features.floorPlans = false
    if (subscription) {
      permissions = this.filterBySubscriptionFeatures(permissions, subscription);
    }

    // ── Step 4: Intersect with customer grants (customer-scoped users only) ─
    // CUSTOMER_ADMIN and CUSTOMER_USER can only have what their customer was granted
    if (fullUser.customerId) {
      permissions = await this.intersectWithCustomerGrants(
        permissions,
        fullUser.customerId,
        subscription,
      );
    }

    return permissions;
  }

  private filterBySubscriptionFeatures(
    permissions: Set<string>,
    subscription: Subscription,
  ): Set<string> {
    const filtered = new Set<string>();

    for (const permString of permissions) {
      const resource = permString.split(':')[0]; // 'devices' from 'devices:create'
      const featureKey = RESOURCE_TO_FEATURE[resource];

      if (!featureKey) {
        // No feature gate for this resource — always include
        filtered.add(permString);
        continue;
      }

      if (subscription.hasFeature(featureKey)) {
        filtered.add(permString);
      }
      // else: feature disabled in plan — permission silently dropped
    }

    return filtered;
  }

  private async intersectWithCustomerGrants(
    userPermissions: Set<string>,
    customerId: string,
    subscription: Subscription | undefined,
  ): Promise<Set<string>> {
    const customer = await this.customersRepo.findOne({
      where: { id: customerId },
      relations: ['grantedPermissions'],
    });

    if (!customer) {
      this.logger.warn(`Customer ${customerId} not found during permission resolution — denying all`);
      return new Set(); // customer doesn't exist — deny everything
    }

    // Build the customer's permission set, also filtered by subscription features
    let customerPerms = new Set<string>(
      (customer.grantedPermissions ?? []).map((p) => p.permissionString),
    );

    if (subscription) {
      customerPerms = this.filterBySubscriptionFeatures(customerPerms, subscription);
    }

    // Intersection: user must have it AND customer must have been granted it
    const intersection = new Set<string>();
    for (const perm of userPermissions) {
      if (customerPerms.has(perm)) {
        intersection.add(perm);
      }
    }

    return intersection;
  }
}