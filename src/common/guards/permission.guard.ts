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
import { PermissionCacheService } from '@lib/redis/permission-cache.service';

// Maps permission resource strings to SubscriptionFeatures keys.
// Resources not listed here have no feature gate — always available.
const RESOURCE_TO_FEATURE: Partial<Record<string, keyof SubscriptionFeatures>> = {
  devices:      'devices',
  dashboards:   'dashboards',
  assets:       'assets',
  floor_plans:  'floorPlans',
  automations:  'automations',
  // Mapped to the boolean `firmware` flag, NOT to `otaUpdates`. `otaUpdates` is
  // typed 'manual' | 'automatic' while Subscription.hasFeature() compares with
  // `=== true`, so any plan that actually sets otaUpdates would be DENIED and
  // only plans that omit it would pass (hasFeature reads a missing key as
  // allowed). `firmware` is the gate; `otaUpdates` says which rollout mode the
  // plan is entitled to.
  firmware:     'firmware',
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
    // Provided by the @Global RedisModule, so GuardsModule needs no new import.
    private readonly permissionCache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
    // Handler first, then class. The previous `reflector.get(..., getHandler())`
    // read the HANDLER ONLY, so a class-level `@RequirePermissions()` — the
    // natural way to protect a whole controller in one line — was silently
    // ignored and every route in it stayed open. `RolesGuard` already used
    // `getAllAndOverride`; this guard simply did not.
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @RequirePermissions() on this route
    if (!requiredPermissions || requiredPermissions.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user: User = request.user;

    if (!user) throw new ForbiddenException('User not authenticated');

    // Super admin has all permissions — no checks needed
    if (user.role === UserRole.SUPER_ADMIN) return true;

    // ── Tenant admin ──────────────────────────────────────────────────────
    //
    // A tenant admin has full access within their tenant by default, which is
    // the ThingsBoard model and is what most deployments want.
    //
    // But it used to be unconditional, and that made a real feature a lie:
    // permissions assigned to a user who happens to hold TENANT_ADMIN did
    // nothing at all, with no indication anywhere that they had been ignored.
    // Someone restricting an admin to `devices:read` got an admin who could
    // still delete every tenant in the platform.
    //
    // `enforcePermissions` is the opt-in that makes the grant real. It is
    // per-user and defaults to false, so existing admins are unaffected by
    // this change — switching it on is a deliberate act that says "this
    // account is restricted to what it has been granted". With it on, the
    // account goes through exactly the same resolution as a customer user.
    //
    // SUPER_ADMIN above is deliberately NOT subject to this: an account that
    // can lock itself out of the platform it administers is a footgun, and
    // there would be no way back in.
    if (user.role === UserRole.TENANT_ADMIN && !user.enforcePermissions) {
      return true;
    }

    // Subscription is cached by SubscriptionGuard (runs before this)
    const subscription: Subscription | undefined = request.subscription;

    // ── Resolve effective permissions ────────────────────────────────────────
    //
    // Cached in Redis, keyed on (tenant, epoch, user) — see
    // PermissionCacheService for what invalidates it and why invalidation is
    // by tenant epoch rather than per user. A cache miss, a Redis outage or a
    // corrupt entry all fall through to the two-join resolution below; the
    // cache can only ever return a set that was previously computed from the
    // database, so it cannot widen anyone's access.
    //
    // The cache key does NOT include the subscription, even though
    // filterBySubscriptionFeatures() narrows the set by plan. It does not need
    // to: a plan change is a subscription mutation, which the TTL bounds, and
    // a tenant has exactly one subscription — so two requests from the same
    // user in the same tenant always filter through the same features.
    const effectivePermissions =
      (await this.permissionCache.get(user.tenantId, user.id)) ??
      (await this.resolveAndCache(user, subscription));

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

  /**
   * Resolve from the database and populate the cache.
   *
   * Split out so the cache write happens in exactly one place. An empty set is
   * cached too — a user with no permissions is a legitimate, common answer,
   * and not caching it would leave the most expensive case (every denied
   * request from an unprivileged account) uncached, which is precisely the
   * traffic an attacker generates.
   */
  private async resolveAndCache(
    user: User,
    subscription: Subscription | undefined,
  ): Promise<Set<string>> {
    const resolved = await this.resolveEffectivePermissions(user, subscription);
    await this.permissionCache.set(user.tenantId, user.id, resolved);
    return resolved;
  }

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