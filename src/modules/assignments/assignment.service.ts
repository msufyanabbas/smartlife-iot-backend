// src/modules/assignments/assignment.service.ts
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { User, Customer, CustomerUserLimit, CustomerDevice, CustomerDashboard, CustomerAsset, CustomerFloorPlan, CustomerAutomation, UserDevice, UserDashboard, UserAsset, UserFloorPlan, UserAutomation, Subscription } from '@modules/index.entities';
// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export type ResourceType = 'devices' | 'dashboards' | 'assets' | 'floorPlans' | 'automations';

// Maps resource type to the permission resource string used in the permissions table
const RESOURCE_TO_PERMISSION: Record<ResourceType, string> = {
  devices: 'devices',
  dashboards: 'dashboards',
  assets: 'assets',
  floorPlans: 'floor_plans',
  automations: 'automations',
};

// Maps resource type to the subscription feature key
const RESOURCE_TO_FEATURE: Record<ResourceType, string> = {
  devices: 'devices',
  dashboards: 'dashboards',
  assets: 'assets',
  floorPlans: 'floorPlans',
  automations: 'automations',
};

@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    private readonly dataSource: DataSource,

    @InjectRepository(Customer)
    private readonly customersRepo: Repository<Customer>,

    @InjectRepository(CustomerUserLimit)
    private readonly userLimitsRepo: Repository<CustomerUserLimit>,

    @InjectRepository(Subscription)
    private readonly subscriptionsRepo: Repository<Subscription>,

    @InjectRepository(CustomerDevice)
    private readonly customerDevicesRepo: Repository<CustomerDevice>,

    @InjectRepository(UserDevice)
    private readonly userDevicesRepo: Repository<UserDevice>,

    @InjectRepository(CustomerDashboard)
    private readonly customerDashboardsRepo: Repository<CustomerDashboard>,

    @InjectRepository(UserDashboard)
    private readonly userDashboardsRepo: Repository<UserDashboard>,

    @InjectRepository(CustomerAsset)
    private readonly customerAssetsRepo: Repository<CustomerAsset>,

    @InjectRepository(UserAsset)
    private readonly userAssetsRepo: Repository<UserAsset>,

    @InjectRepository(CustomerFloorPlan)
    private readonly customerFloorPlansRepo: Repository<CustomerFloorPlan>,

    @InjectRepository(UserFloorPlan)
    private readonly userFloorPlansRepo: Repository<UserFloorPlan>,

    @InjectRepository(CustomerAutomation)
    private readonly customerAutomationsRepo: Repository<CustomerAutomation>,

    @InjectRepository(UserAutomation)
    private readonly userAutomationsRepo: Repository<UserAutomation>,

    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Assign resource to customer (called by tenant admin)
  // ═══════════════════════════════════════════════════════════════════════════

  async assignResourceToCustomer(
    resourceId: string,
    resourceType: ResourceType,
    customerId: string,
    actor: User, // the tenant admin making this request
  ): Promise<void> {
    await this.verifyResourceExists(resourceId, resourceType, actor.tenantId);
    // ── Cross-tenant check ──────────────────────────────────────────────────
    // Step 0: Verify the resource belongs to the actor's tenant.
    // This is done by the caller passing a pre-verified resourceId,
    // OR by passing the resource entity here. We verify the customer
    // belongs to the tenant as the first DB call.
    const customer = await this.loadAndVerifyCustomer(customerId, actor.tenantId);

    // ── Load subscription (for quota and feature checks) ────────────────────
    const subscription = await this.loadSubscription(actor.tenantId);

    // ────────────────────────────────────────────────────────────────────────
    // GATE 1: PERMISSION GATE
    // Does this customer have ANY permission for this resource type?
    // If not, this resource type cannot be assigned to them at all.
    // ────────────────────────────────────────────────────────────────────────
    await this.enforcePermissionGate(customer, resourceType, subscription, 'customer');

    // ────────────────────────────────────────────────────────────────────────
    // GATE 2: QUOTA GATE
    // Does the customer still have capacity for this resource type?
    // Also checks the tenant subscription ceiling.
    // ────────────────────────────────────────────────────────────────────────
    await this.enforceCustomerQuotaGate(customer, resourceType, subscription);

    // ── Check for duplicate assignment ─────────────────────────────────────
    const alreadyAssigned = await this.isResourceAssignedToCustomer(
      resourceId, resourceType, customerId,
    );
    if (alreadyAssigned) {
      throw new BadRequestException(
        `This ${resourceType.slice(0, -1)} is already assigned to this customer`,
      );
    }

    // ────────────────────────────────────────────────────────────────────────
    // GATE 3: SAVE + INCREMENT COUNTERS
    // Run inside a transaction so the assignment row and counter increments
    // are atomic — if either fails, both roll back.
    // ────────────────────────────────────────────────────────────────────────
    await this.dataSource.transaction(async (manager) => {
      // Save the assignment row
      const repo = this.getCustomerResourceRepo(resourceType);
      await manager.save(repo.target, {
        customerId,
        [this.getResourceIdColumn(resourceType)]: resourceId,
        tenantId: actor.tenantId,
        assignedBy: actor.id,
      });

      // Increment customer usage counter
      await this.incrementCustomerCounter(manager, customerId, resourceType);

      // Increment tenant subscription usage counter
      await this.incrementSubscriptionCounter(manager, actor.tenantId, resourceType);
    });

    this.logger.log(
      `[ASSIGN] ${resourceType} ${resourceId} → Customer ${customerId} by ${actor.email}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Assign resource to user (called by customer admin)
  // ═══════════════════════════════════════════════════════════════════════════

  async assignResourceToUser(
    resourceId: string,
    resourceType: ResourceType,
    targetUserId: string,
    actor: User, // the customer admin making this request
  ): Promise<void> {
    await this.verifyResourceExists(resourceId, resourceType, actor.tenantId);
    // ── Cross-tenant check ──────────────────────────────────────────────────
    // Verify target user belongs to the same tenant AND the same customer
    const targetUser = await this.usersRepo.findOne({
      where: {
        id: targetUserId,
        tenantId: actor.tenantId,      // cross-tenant guard
        customerId: actor.customerId,  // cross-customer guard (admin can only manage own customer)
      },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
      // Deliberately vague — don't reveal whether user exists in another customer
    }

    if (!targetUser.customerId) {
      throw new BadRequestException('Cannot assign resources to a tenant-level user');
    }

    const customer = await this.loadAndVerifyCustomer(targetUser.customerId, actor.tenantId);
    const subscription = await this.loadSubscription(actor.tenantId);

    // ────────────────────────────────────────────────────────────────────────
    // GATE 1: PERMISSION GATE (two sub-checks)
    // 1a. Customer must have permission for this resource type
    // 1b. User must have permission for this resource type
    //     (from their roles or direct permissions, intersected with customer grants)
    // ────────────────────────────────────────────────────────────────────────
    await this.enforcePermissionGate(customer, resourceType, subscription, 'customer');
    await this.enforceUserPermissionGate(targetUser, customer, resourceType);

    // ────────────────────────────────────────────────────────────────────────
    // GATE 2: CONSISTENCY CHECK
    // The resource MUST already be assigned to the customer before
    // it can be assigned to a user within that customer.
    // ────────────────────────────────────────────────────────────────────────
    const assignedToCustomer = await this.isResourceAssignedToCustomer(
      resourceId, resourceType, targetUser.customerId,
    );

    if (!assignedToCustomer) {
      throw new ForbiddenException(
        `This ${resourceType.slice(0, -1)} is not assigned to the customer. ` +
        `It must be assigned to the customer before assigning to a user.`,
      );
    }

    // ────────────────────────────────────────────────────────────────────────
    // GATE 3: QUOTA GATE (user level)
    // Does this user still have capacity for this resource type?
    // ────────────────────────────────────────────────────────────────────────
    await this.enforceUserQuotaGate(targetUser, customer, resourceType);

    // ── Check for duplicate assignment ─────────────────────────────────────
    const alreadyAssigned = await this.isResourceAssignedToUser(
      resourceId, resourceType, targetUserId,
    );
    if (alreadyAssigned) {
      throw new BadRequestException(
        `This ${resourceType.slice(0, -1)} is already assigned to this user`,
      );
    }

    // ────────────────────────────────────────────────────────────────────────
    // SAVE + INCREMENT USER COUNTER
    // Note: We do NOT increment the customer or subscription counter here.
    // Those were already incremented when the resource was assigned to the customer.
    // The user counter tracks personal assignments within the customer pool.
    // ────────────────────────────────────────────────────────────────────────
    await this.dataSource.transaction(async (manager) => {
      const repo = this.getUserResourceRepo(resourceType);
      await manager.save(repo.target, {
        userId: targetUserId,
        customerId: targetUser.customerId,
        [this.getResourceIdColumn(resourceType)]: resourceId,
        tenantId: actor.tenantId,
        assignedBy: actor.id,
      });

      // Increment the user-level counter in CustomerUserLimit
      await this.incrementUserCounter(manager, targetUserId, targetUser.customerId, actor.tenantId, resourceType);
    });

    this.logger.log(
      `[ASSIGN] ${resourceType} ${resourceId} → User ${targetUser.email} by ${actor.email}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Unassign resource from customer
  // ═══════════════════════════════════════════════════════════════════════════

 async unassignResourceFromCustomer(
  resourceId: string,
  resourceType: ResourceType,
  customerId: string,
  actor: User,
): Promise<void> {
  await this.loadAndVerifyCustomer(customerId, actor.tenantId);

  const repo = this.getCustomerResourceRepo(resourceType);
  const idColumn = this.getResourceIdColumn(resourceType);

  const assignment = await repo.findOne({
    where: { customerId, [idColumn]: resourceId, tenantId: actor.tenantId } as any,
  });

  if (!assignment) throw new NotFoundException('Assignment not found');

  await this.dataSource.transaction(async (manager) => {
    await manager.remove(assignment);

    // ✅ Optimized: Use bulk operations instead of loading all records
    const userRepo = this.getUserResourceRepo(resourceType);
    
    // Get count of affected user assignments
    const affectedCount = await userRepo.count({
      where: { customerId, [idColumn]: resourceId } as any,
    });

    if (affectedCount > 0) {
      // Bulk decrement using raw SQL (more efficient than loading all records)
      await manager.query(
        `UPDATE customer_user_limits
         SET "usageCounters" = jsonb_set(
           "usageCounters",
           '{${resourceType}}',
           GREATEST(0, (COALESCE("usageCounters"->>'${resourceType}', '0')::int - 1))::text::jsonb
         )
         WHERE "customerId" = $1
         AND "userId" IN (
           SELECT "userId" FROM ${userRepo.metadata.tableName}
           WHERE "customerId" = $1 AND "${idColumn}" = $2
         )`,
        [customerId, resourceId],
      );

      // Delete user assignments
      await userRepo.delete({
        customerId,
        [idColumn]: resourceId,
      } as any);
    }

    await this.decrementCustomerCounter(manager, customerId, resourceType);
    await this.decrementSubscriptionCounter(manager, actor.tenantId, resourceType);
    this.logger.log(
    `[UNASSIGN] ${resourceType} ${resourceId} ← Customer ${customerId} by ${actor.email} ` +
    `(cascaded ${affectedCount} user assignments)`,
  );
  });
}

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — Unassign resource from user
  // ═══════════════════════════════════════════════════════════════════════════

  async unassignResourceFromUser(
    resourceId: string,
    resourceType: ResourceType,
    targetUserId: string,
    actor: User,
  ): Promise<void> {
    const targetUser = await this.usersRepo.findOne({
      where: { id: targetUserId, tenantId: actor.tenantId, customerId: actor.customerId },
    });
    if (!targetUser) throw new NotFoundException('User not found');

    const repo = this.getUserResourceRepo(resourceType);
    const idColumn = this.getResourceIdColumn(resourceType);

    const assignment = await repo.findOne({
      where: { userId: targetUserId, [idColumn]: resourceId, tenantId: actor.tenantId } as any,
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    await this.dataSource.transaction(async (manager) => {
      await manager.remove(assignment);
      await this.decrementUserCounter(
        manager, targetUserId, targetUser.customerId!, actor.tenantId, resourceType,
      );
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GATE IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GATE 1 — PERMISSION GATE (Customer level)
   *
   * Checks two things:
   * 1. The subscription plan includes this resource type (feature flag)
   * 2. The customer has been granted at least one permission for this resource
   *
   * If either fails → assignment is rejected.
   *
   * Why check subscription here?
   *   If the tenant's plan doesn't include floor_plans, no customer under that
   *   tenant should ever get a floor_plans permission in the first place.
   *   But we double-check here as defense-in-depth.
   */
  private async enforcePermissionGate(
    customer: Customer,
    resourceType: ResourceType,
    subscription: Subscription,
    target: 'customer' | 'user',
  ): Promise<void> {
    // Sub-check 1: Is this feature in the subscription plan?
    const featureKey = RESOURCE_TO_FEATURE[resourceType];
    if (!subscription.hasFeature(featureKey as any)) {
      throw new ForbiddenException(
        `The ${resourceType} feature is not included in your subscription plan. ` +
        `Please upgrade to access this feature.`,
      );
    }

    // Sub-check 2: Does the customer have ANY permission for this resource?
    const permissionResource = RESOURCE_TO_PERMISSION[resourceType];
    const hasPermission = (customer.grantedPermissions ?? []).some(
      (p) => p.resource === permissionResource,
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Customer "${customer.name}" does not have ${resourceType} permissions. ` +
        `Grant ${resourceType} permissions to this customer before assigning ${resourceType}.`,
      );
    }
  }

  /**
   * GATE 1b — PERMISSION GATE (User level)
   *
   * Checks that the target user has the permission for this resource type.
   * Effective permission = union(role permissions, direct permissions)
   *                        intersected with customer.grantedPermissions
   *
   * We only need to check if they have ANY permission for the resource (not a
   * specific action) because assignment itself is an admin action — we're just
   * checking if the resource type is in scope for this user at all.
   */
  private async enforceUserPermissionGate(
    user: User,
    customer: Customer,
    resourceType: ResourceType,
  ): Promise<void> {
    const permissionResource = RESOURCE_TO_PERMISSION[resourceType];

    // Get permissions from roles
    const rolePermResources = (user.roles ?? []).flatMap(
      (role) => (role.permissions ?? []).map((p) => p.resource),
    );

    // Get direct permissions
    const directPermResources = (user.directPermissions ?? []).map((p) => p.resource);

    // Union
    const userResources = new Set([...rolePermResources, ...directPermResources]);

    // Intersect with customer grants
    const customerResources = new Set(
      (customer.grantedPermissions ?? []).map((p) => p.resource),
    );

    const effectiveResources = [...userResources].filter((r) => customerResources.has(r));

    if (!effectiveResources.includes(permissionResource)) {
      throw new ForbiddenException(
        `User does not have ${resourceType} permissions. ` +
        `Assign a role with ${resourceType} permissions before assigning ${resourceType}.`,
      );
    }
  }

  /**
   * GATE 2 — QUOTA GATE (Customer level)
   *
   * Checks two ceilings:
   * 1. Tenant subscription ceiling: subscription.usage[resource] < subscription.limits[resource]
   * 2. Customer allocation ceiling: customer.usageCounters[resource] < customer.allocatedLimits[resource]
   *
   * Both must pass. The subscription is the hard outer limit.
   * The customer allocation is the inner limit set by the tenant admin.
   */
  private async enforceCustomerQuotaGate(
    customer: Customer,
    resourceType: ResourceType,
    subscription: Subscription,
  ): Promise<void> {
    // Check 1: Tenant subscription ceiling
    // Map resourceType to the subscription usage key
    const usageKey = resourceType as keyof typeof subscription.usage;
    if (subscription.isLimitReached(usageKey)) {
      const remaining = subscription.getRemainingCapacity(usageKey);
      throw new ForbiddenException(
        `Your subscription's ${resourceType} limit has been reached (${remaining} remaining). ` +
        `Please upgrade your subscription to add more ${resourceType}.`,
      );
    }

    // Check 2: Customer allocation ceiling
    // null allocatedLimit means no customer-level cap — subscription limit only applies
    const allocatedLimit = customer.allocatedLimits?.[resourceType as keyof typeof customer.allocatedLimits];
    if (allocatedLimit !== undefined && allocatedLimit !== null) {
      const currentUsage = customer.usageCounters?.[resourceType as keyof typeof customer.usageCounters] ?? 0;
      if (currentUsage >= allocatedLimit) {
        throw new ForbiddenException(
          `Customer "${customer.name}" has reached their allocated ${resourceType} limit ` +
          `(${currentUsage}/${allocatedLimit}). ` +
          `Increase the customer's ${resourceType} allocation to add more.`,
        );
      }
    }
  }

  /**
   * GATE 3 — QUOTA GATE (User level)
   *
   * Checks the per-user limit set by the customer admin.
   * If no CustomerUserLimit record exists for this user, there is no user-level cap
   * (they just share from the customer pool freely).
   */
  private async enforceUserQuotaGate(
    user: User,
    customer: Customer,
    resourceType: ResourceType,
  ): Promise<void> {
    const userLimit = await this.userLimitsRepo.findOne({
      where: { userId: user.id, customerId: user.customerId! },
    });

    // No user-level limit record → no user-level cap
    if (!userLimit) return;

    if (userLimit.hasReachedLimit(resourceType as keyof typeof userLimit.limits)) {
      const limit = userLimit.limits[resourceType as keyof typeof userLimit.limits];
      const usage = userLimit.usageCounters[resourceType as keyof typeof userLimit.usageCounters];
      throw new ForbiddenException(
        `User has reached their ${resourceType} limit (${usage}/${limit}). ` +
        `Contact your administrator to increase your ${resourceType} allocation.`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COUNTER MANAGEMENT
  // All counter updates run inside the caller's transaction (manager passed in)
  // Uses PostgreSQL jsonb_set for atomic in-place counter updates
  // ═══════════════════════════════════════════════════════════════════════════

  private async incrementCustomerCounter(
    manager: any,
    customerId: string,
    resource: ResourceType,
  ): Promise<void> {
    await manager.query(
      `UPDATE customers
       SET "usageCounters" = jsonb_set(
         "usageCounters",
         '{${resource}}',
         (COALESCE("usageCounters"->>'${resource}', '0')::int + 1)::text::jsonb
       )
       WHERE id = $1`,
      [customerId],
    );
  }

  private async decrementCustomerCounter(
    manager: any,
    customerId: string,
    resource: ResourceType,
  ): Promise<void> {
    await manager.query(
      `UPDATE customers
       SET "usageCounters" = jsonb_set(
         "usageCounters",
         '{${resource}}',
         GREATEST(0, (COALESCE("usageCounters"->>'${resource}', '0')::int - 1))::text::jsonb
       )
       WHERE id = $1`,
      [customerId],
    );
  }

  private async incrementSubscriptionCounter(
    manager: any,
    tenantId: string | undefined,
    resource: ResourceType,
  ): Promise<void> {
    await manager.query(
      `UPDATE subscriptions
       SET usage = jsonb_set(
         usage,
         '{${resource}}',
         (COALESCE(usage->>'${resource}', '0')::int + 1)::text::jsonb
       )
       WHERE "tenantId" = $1`,
      [tenantId],
    );
  }

  private async decrementSubscriptionCounter(
    manager: any,
    tenantId: string | undefined,
    resource: ResourceType,
  ): Promise<void> {
    await manager.query(
      `UPDATE subscriptions
       SET usage = jsonb_set(
         usage,
         '{${resource}}',
         GREATEST(0, (COALESCE(usage->>'${resource}', '0')::int - 1))::text::jsonb
       )
       WHERE "tenantId" = $1`,
      [tenantId],
    );
  }

  private async incrementUserCounter(
    manager: any,
    userId: string,
    customerId: string | undefined,
    tenantId: string | undefined,
    resource: ResourceType,
  ): Promise<void> {
    // Upsert the CustomerUserLimit record if it doesn't exist yet
    await manager.query(
      `INSERT INTO customer_user_limits ("userId", "customerId", "tenantId", limits, "usageCounters")
       VALUES ($1, $2, $3, '{}', $4::jsonb)
       ON CONFLICT ("userId", "customerId") DO UPDATE
       SET "usageCounters" = jsonb_set(
         customer_user_limits."usageCounters",
         '{${resource}}',
         (COALESCE(customer_user_limits."usageCounters"->>'${resource}', '0')::int + 1)::text::jsonb
       )`,
      [userId, customerId, tenantId, JSON.stringify({ [resource]: 1 })],
    );
  }

  private async decrementUserCounter(
    manager: any,
    userId: string,
    customerId: string | undefined,
    tenantId: string | undefined,
    resource: ResourceType,
  ): Promise<void> {
    await manager.query(
      `UPDATE customer_user_limits
       SET "usageCounters" = jsonb_set(
         "usageCounters",
         '{${resource}}',
         GREATEST(0, (COALESCE("usageCounters"->>'${resource}', '0')::int - 1))::text::jsonb
       )
       WHERE "userId" = $1 AND "customerId" = $2`,
      [userId, customerId],
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load customer and verify it belongs to the given tenant.
   * Returns NotFoundException for both "not found" and "wrong tenant"
   * to avoid leaking tenant existence information.
   */
  private async loadAndVerifyCustomer(customerId: string, tenantId: string | undefined): Promise<Customer> {
    const customer = await this.customersRepo.findOne({
      where: { id: customerId, tenantId },
      relations: ['grantedPermissions'],
    });

    if (!customer) throw new NotFoundException('Customer not found');
    if (!customer.isActive()) throw new ForbiddenException('Customer account is not active');

    return customer;
  }

  private async loadSubscription(tenantId: string | undefined): Promise<Subscription> {
    const subscription = await this.subscriptionsRepo.findOne({
      where: { tenantId },
    });
    if (!subscription) throw new ForbiddenException('No active subscription found for this tenant');
    if (!subscription.isActive()) {
      throw new ForbiddenException('Subscription is not active. Please renew your subscription.');
    }
    return subscription;
  }

  private async isResourceAssignedToCustomer(
    resourceId: string,
    resourceType: ResourceType,
    customerId: string,
  ): Promise<boolean> {
    const repo = this.getCustomerResourceRepo(resourceType);
    const idColumn = this.getResourceIdColumn(resourceType);
    const count = await repo.count({
      where: { customerId, [idColumn]: resourceId } as any,
    });
    return count > 0;
  }

  private async isResourceAssignedToUser(
    resourceId: string,
    resourceType: ResourceType,
    userId: string,
  ): Promise<boolean> {
    const repo = this.getUserResourceRepo(resourceType);
    const idColumn = this.getResourceIdColumn(resourceType);
    const count = await repo.count({
      where: { userId, [idColumn]: resourceId } as any,
    });
    return count > 0;
  }

  private getCustomerResourceRepo(resourceType: ResourceType): Repository<any> {
    const map: Record<ResourceType, Repository<any>> = {
      devices: this.customerDevicesRepo,
      dashboards: this.customerDashboardsRepo,
      assets: this.customerAssetsRepo,
      floorPlans: this.customerFloorPlansRepo,
      automations: this.customerAutomationsRepo,
    };
    return map[resourceType];
  }

  private getUserResourceRepo(resourceType: ResourceType): Repository<any> {
    const map: Record<ResourceType, Repository<any>> = {
      devices: this.userDevicesRepo,
      dashboards: this.userDashboardsRepo,
      assets: this.userAssetsRepo,
      floorPlans: this.userFloorPlansRepo,
      automations: this.userAutomationsRepo,
    };
    return map[resourceType];
  }

  private getResourceIdColumn(resourceType: ResourceType): string {
    const map: Record<ResourceType, string> = {
      devices: 'deviceId',
      dashboards: 'dashboardId',
      assets: 'assetId',
      floorPlans: 'floorPlanId',
      automations: 'automationId',
    };
    return map[resourceType];
  }


  async getUserResourceSummary(userId: string, tenantId: string | undefined): Promise<{
  devices: number;
  dashboards: number;
  assets: number;
  floorPlans: number;
  automations: number;
}> {
  const [devices, dashboards, assets, floorPlans, automations] = await Promise.all([
    this.userDevicesRepo.count({ where: { userId, tenantId } }),
    this.userDashboardsRepo.count({ where: { userId, tenantId } }),
    this.userAssetsRepo.count({ where: { userId, tenantId } }),
    this.userFloorPlansRepo.count({ where: { userId, tenantId } }),
    this.userAutomationsRepo.count({ where: { userId, tenantId } }),
  ]);

  return { devices, dashboards, assets, floorPlans, automations };
}


  /**
 * Verify resource exists and belongs to tenant
 */
private async verifyResourceExists(
  resourceId: string,
  resourceType: ResourceType,
  tenantId: string | undefined,
): Promise<void> {
  let exists = false;

  switch (resourceType) {
    case 'devices':
      exists = await this.dataSource.getRepository('Device').exist({
        where: { id: resourceId, tenantId },
      });
      break;
    case 'dashboards':
      exists = await this.dataSource.getRepository('Dashboard').exist({
        where: { id: resourceId, tenantId },
      });
      break;
    case 'assets':
      exists = await this.dataSource.getRepository('Asset').exist({
        where: { id: resourceId, tenantId },
      });
      break;
    case 'floorPlans':
      exists = await this.dataSource.getRepository('FloorPlan').exist({
        where: { id: resourceId, tenantId },
      });
      break;
    case 'automations':
      exists = await this.dataSource.getRepository('Automation').exist({
        where: { id: resourceId, tenantId },
      });
      break;
  }

  if (!exists) {
    throw new NotFoundException(`${resourceType.slice(0, -1)} not found`);
  }
}
}