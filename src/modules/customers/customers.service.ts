import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In, IsNull, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomerStatus, UserRole, UserStatus } from '@/common/enums/index.enum';
import { Customer, Permission, Subscription, User } from '@modules/index.entities';
import * as crypto from 'crypto';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  BulkUpdateCustomerStatusDto,
} from './dto/customers.dto';
import { MailService } from '../mail/mail.service';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
// Direct path, not the '../index.service' barrel: that barrel re-exports every
// service in the platform, so importing SubscriptionsService through it pulled
// all of them into this module's dependency graph — which is what made
// CustomersService impossible to construct in a verification script.
// UsersService already imports it this way.
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SubscriptionLimits, SubscriptionUsage } from '@/common/interfaces/subscription.interface';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import {
  BulkResultBuilder,
  BulkResultDto,
} from '@common/dto/bulk-operation.dto';
import {
  BulkDeleteCustomersDto,
  BulkUpdateCustomersDto,
} from './dto/bulk-customer.dto';
@Injectable()
export class CustomersService {
   private readonly logger = new Logger(CustomersService.name);
  constructor(
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Permission)
    private permissionRepository: Repository<Permission>,
    private tenantService: TenantsService,
    private eventEmitter: EventEmitter2,
    private mailService: MailService,
    private userService: UsersService,
    private subscriptionsService: SubscriptionsService,
    private readonly dataSource: DataSource,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a customer record AND a linked User account (role=CUSTOMER).
   *
   * The user is created in INACTIVE status with no password.
   * A set-password token is emailed so the customer can activate
   * their account on first login.
   *
   * @param dto            - Customer fields from the request body
   * @param callerTenantId - Taken from @CurrentUser() in the controller — NOT body
   */
 async create(createCustomerDto: CreateCustomerDto, user: User): Promise<Customer> {
  // ── Pre-checks OUTSIDE transaction (fast fail) ─────────────────────────
  const existingCustomer = await this.customerRepository.findOne({
    where: {
      phone: createCustomerDto.phone,
      email: createCustomerDto.email,
      tenantId: user.tenantId,
    },
  });

  const existingUser = await this.userRepository.findOne({
    where: { email: createCustomerDto.email, phone: createCustomerDto.phone },
  });

  if (existingCustomer || existingUser) {
    throw new ConflictException(
      'Customer with this phone or email already exists in this tenant',
    );
  }

  if (!createCustomerDto.email) {
    throw new BadRequestException(
      'Customer email is required so a login account can be created',
    );
  }

  if (createCustomerDto.allocatedLimits) {
    const subscription = await this.subscriptionsService.findByTenantId(user.tenantId);
    this.validateAllocatedLimits(createCustomerDto.allocatedLimits, subscription);
  }

      const setPasswordToken = crypto.randomBytes(32).toString('hex');
    const setPasswordExpires = new Date();
    setPasswordExpires.setDate(setPasswordExpires.getDate() + 7);

  // ── All writes inside a single transaction ─────────────────────────────
  const savedCustomer = await this.dataSource.transaction(async (manager) => {
    // 1. Persist customer row
    // Seed the baseline grant set. Without this a new customer holds no
    // permissions, and since the guard INTERSECTS with this set, every
    // permission-gated route 403s for every user under it — with no endpoint
    // and no screen to fix it. Read-only across the customer-facing
    // resources is the smallest set that leaves the account usable.
    const defaultGrants = await this.defaultGrantedPermissions(user.tenantId ?? null);

    const customer = manager.create(Customer, {
      ...createCustomerDto,
      tenantId: user.tenantId,
      status: CustomerStatus.INACTIVE,
    });
    customer.grantedPermissions = defaultGrants;
    const savedCustomer = await manager.save(customer);

    // 2. Create linked User


    const newUser = manager.create(User, {
      email: createCustomerDto.email,
      name: createCustomerDto.name,
      phone: createCustomerDto.phone,
      password: 'UNSET_' + crypto.randomBytes(16).toString('hex'),
      role: UserRole.CUSTOMER,
      status: UserStatus.INACTIVE,
      emailVerified: false,
      tenantId: user.tenantId,
      customerId: savedCustomer.id,
      setPasswordToken,
      setPasswordExpires,
    });

    await manager.save(newUser);

    return savedCustomer;
  });

  this.logger.log(`Customer created: ${createCustomerDto.email} (customer: ${savedCustomer.id})`);

  this.eventEmitter.emit('customer.created', {
    customer: savedCustomer,
    email: createCustomerDto.email,
    name: createCustomerDto.name,
    tenantId: user.tenantId,
    setPasswordToken: setPasswordToken /* store token before transaction if needed */,
    role: UserRole.CUSTOMER,
  });

  return savedCustomer;
}

  // ═══════════════════════════════════════════════════════════════════════════
  // SET PASSWORD  (first-time activation)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Called by the customer when they click the invitation link.
   * Sets their password and activates the account.
   */
  async setPasswordFromToken(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { setPasswordToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired invitation link');
    }

    if (!user.setPasswordExpires || new Date() > user.setPasswordExpires) {
      throw new BadRequestException(
        'This invitation link has expired. Please ask your tenant admin to resend it.',
      );
    }

    // The @BeforeInsert/@BeforeUpdate hook on User hashes the password automatically
    user.password = newPassword;
    user.status = UserStatus.ACTIVE;
    user.emailVerified = true;         // email was confirmed by clicking the link
    await this.userRepository.save(user);

    // `= undefined` is omitted from the UPDATE by TypeORM, so assigning it to
    // the token columns left the invitation link live. See the same fix in
    // AuthService.setPasswordFromToken, which is the path actually routed —
    // this copy is currently unreachable, and is corrected so that reviving it
    // does not revive the hole.
    await this.userRepository.update(
      { id: user.id },
      { setPasswordToken: null as never, setPasswordExpires: null as never },
    );
    this.logger.log(`Password set and account activated for: ${user.email}`);

    return { message: 'Password set successfully. You can now log in.' };
  }

  /**
   * Resend the set-password invitation email.
   * Useful when the token expires or the email was lost.
   */
  async resendCustomerInvitation(
    customerId: string,
    user: User,
  ): Promise<{ message: string }> {
    const customer = await this.findOne(user.tenantId, customerId);
    const tenant = await this.tenantService.findOne(user.tenantId);

    // Tenant isolation — make sure the customer belongs to the caller's tenant
    if (customer.tenantId !== user.tenantId) {
      throw new BadRequestException('Customer does not belong to your tenant');
    }

    const newUser = await this.userRepository.findOne({
      where: { customerId, role: UserRole.CUSTOMER },
    });

    if (!newUser) {
      throw new NotFoundException(
        'No linked user account found for this customer',
      );
    }

    if (newUser.status === UserStatus.ACTIVE && newUser.emailVerified) {
      throw new BadRequestException(
        'This customer has already activated their account',
      );
    }

    // Rotate the token
    const setPasswordToken = crypto.randomBytes(32).toString('hex');
    const setPasswordExpires = new Date();
    setPasswordExpires.setDate(setPasswordExpires.getDate() + 7);

    newUser.setPasswordToken = setPasswordToken;
    newUser.setPasswordExpires = setPasswordExpires;
    await this.userRepository.save(newUser);

      await this.mailService.sendInvitationEmail(
        newUser.email,
        newUser.name,
        tenant.name,
        setPasswordToken,
        UserRole.CUSTOMER
      );

    return { message: 'Invitation email resent successfully' };
  }

  /**
   * Find all customers with pagination and filters
   */
  async findAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    status?: CustomerStatus;
    isPublic?: boolean;
  }, tenantId: string | undefined): Promise<PaginatedResponseDto<Customer>> {
    const page = options.page || 1;
    const limit = options.limit || 10;
    const skip = (page - 1) * limit;

    const queryBuilder = this.customerRepository.createQueryBuilder('customer');

    // Apply filters
    if (options.search) {
      queryBuilder.andWhere(
        '(customer.title ILIKE :search OR customer.email ILIKE :search OR customer.city ILIKE :search)',
        { search: `%${options.search}%` },
      );
    }

    if (options.status) {
      queryBuilder.andWhere('customer.status = :status', {
        status: options.status,
      });
    }

    if (tenantId) {
      queryBuilder.andWhere('customer.tenantId = :tenantId', {
        tenantId: tenantId,
      });
    }

    if (options.isPublic !== undefined) {
      queryBuilder.andWhere('customer.isPublic = :isPublic', {
        isPublic: options.isPublic,
      });
    }

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const customers = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('customer.createdAt', 'DESC')
      .getMany();

    // ── Login state for the row badge ────────────────────────────────────
    //
    // A customer's `status` alone cannot distinguish "invited, has not set a
    // password yet" from "deliberately deactivated" — both are INACTIVE — so
    // the table rendered a red badge for a customer who had done nothing
    // wrong, and an admin had no way to tell whether to press Resend.
    //
    // That state lives on the linked CUSTOMER user, not on the customer row.
    // Fetched as ONE extra query for the page rather than a join, because the
    // join would multiply rows against a customer that has several users and
    // the pagination above counts customers.
    const decorated = await this.attachLoginState(customers);

    return PaginatedResponseDto.create(decorated, page, limit, total);
  }

  /**
   * Find one customer by ID
   */
  async findOne(tenantId: string | undefined, id: string | undefined): Promise<Customer> {
    const customer = await this.customerRepository.findOne({ where: { id, tenantId } });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return customer;
  }

  /**
   * Find customer by title and tenant
   */
  async findByTitleAndTenant(
    name: string,
    tenantId: string,
  ): Promise<Customer | null> {
    return await this.customerRepository.findOne({
      where: { name, tenantId },
    });
  }

  /**
   * Update customer
   */
  async update(
    user: User,
    id: string,
    updateCustomerDto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOne(user.tenantId,id);

    // Check if title is being changed and if it's already taken
    if (updateCustomerDto.name && updateCustomerDto.name !== customer.name) {
      const existingCustomer = await this.findByTitleAndTenant(
        updateCustomerDto.name,
        customer.tenantId,
      );
      if (existingCustomer) {
        throw new ConflictException('Customer title already in use');
      }
    }

    if (updateCustomerDto.allocatedLimits) {
    const subscription = await this.subscriptionsService.findByTenantId(user.tenantId);
    this.validateAllocatedLimits(updateCustomerDto.allocatedLimits, subscription);
  }

    Object.assign(customer, updateCustomerDto);

    const updatedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.updated', { customer: updatedCustomer });

    return updatedCustomer;
  }

  /**
   * Delete customer (soft delete)
   */
  async remove(user: User, id: string): Promise<void> {
    const customer = await this.findOne(user.tenantId, id);
    const newUser = await this.userService.findByCustomer(customer.id);

    // await this.customerRepository.softRemove(customer);
    await this.customerRepository.remove(customer);
    await this.userRepository.remove(newUser);

    // Emit event
    this.eventEmitter.emit('customer.deleted', { customerId: id, tenantId: user.tenantId });
  }

  /**
   * Update customer status
   */
  async updateStatus(
    customerId: string,
    status: CustomerStatus,
    user: User
  ): Promise<Customer> {
    const customer = await this.findOne(user.tenantId, customerId);
    const previousStatus = customer.status;
    customer.status = status;

    const updatedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.status.changed', {
      customerId,
      status,
      previousStatus,
    });

    return updatedCustomer;
  }

  /**
   * Bulk update customer status.
   *
   * @deprecated Use PATCH /customers/bulk, which reports per-id outcomes.
   * Kept because the existing route's contract is `void`; it now goes through
   * the tenant-scoped bulkUpdate() instead of the unscoped
   * `UPDATE ... WHERE id IN (...)` it used to run.
   */
  async bulkUpdateStatus(
    bulkUpdateDto: BulkUpdateCustomerStatusDto,
    actor: User,
  ): Promise<void> {
    await this.bulkUpdate(
      { ids: bulkUpdateDto.customerIds, status: bulkUpdateDto.status },
      actor,
    );
  }

  // ── Bulk delete / bulk update (per-id outcomes) ────────────────────────────
  //
  // TRANSACTION GRANULARITY: ONE TRANSACTION PER ITEM. Per batch, a single
  // customer that still owns devices would roll back every other delete in
  // the request, which contradicts the partial-success contract.
  //
  // TENANT SCOPING: every id is re-resolved against the caller's tenantId
  // before anything is written; a foreign id answers `not_found`. The existing
  // `bulkUpdateStatus()` below did `UPDATE customers SET status WHERE id IN
  // (...)` with no tenant predicate, so it could re-status another tenant's
  // customers — it now delegates here.
  //
  // DELETES ARE SOFT here, unlike the single-customer `remove()`, which calls
  // `repository.remove()` (a HARD delete) with the `softRemove` line commented
  // out. Soft is what the rest of the repo does and what the brief for these
  // routes requires; the single-route inconsistency is left alone rather than
  // changed underneath whoever depends on it.
  //
  // CASCADES: the paired login accounts (`users.customerId = customer.id`,
  // created alongside the customer by create()) are soft-removed in the same
  // transaction. A customer whose login account outlived it would still be
  // able to sign in to an organisation that no longer exists.
  //
  // COUNTERS: `subscriptions.usage.customers` is decremented by the number of
  // customers deleted and `subscriptions.usage.users` by the number of paired
  // accounts removed — mirroring the two increments CustomerListener performs
  // on `customer.created`. This path deliberately does NOT emit
  // `customer.deleted`: CustomerListener's handler for it decrements both
  // counters by exactly 1, which would double-count here and would be wrong
  // for a customer with no paired user. `customers.bulk.deleted` is emitted
  // instead, for anything that wants to observe without owning counters.
  //
  // BLOCKS: a customer that still has devices assigned to it — either
  // `devices.customerId` or a `customer_devices` assignment row. Soft-deleting
  // the org would leave those devices scoped to an organisation that no longer
  // resolves: they vanish from every customer-filtered list while still
  // counting against the tenant's device quota. Unassign them first
  // (`PATCH /devices/bulk` with `customerId: null`).

  async bulkDelete(
    dto: BulkDeleteCustomersDto,
    actor: User,
  ): Promise<BulkResultDto> {
    const result = new BulkResultBuilder(dto.ids);
    const customers = await this.resolveForBulk(result.ids, actor);

    const deviceCounts = await this.countAttachedDevices([...customers.keys()]);

    let deletedCustomers = 0;
    let deletedUsers = 0;
    const deleted: Customer[] = [];

    for (const id of result.ids) {
      const customer = customers.get(id);

      if (!customer) {
        result.notFound(id, 'Customer not found in your scope');
        continue;
      }

      const attached = deviceCounts.get(id) ?? 0;
      if (attached > 0) {
        result.blocked(
          id,
          `Customer still has ${attached} device(s) assigned; unassign them first`,
        );
        continue;
      }

      try {
        const removedUsers = await this.dataSource.transaction(
          async (manager) => {
            const linked = await manager.find(User, {
              where: { customerId: customer.id },
            });
            if (linked.length > 0) {
              await manager.softRemove(linked);
            }
            await manager.softRemove(customer);
            return linked.length;
          },
        );

        deletedCustomers++;
        deletedUsers += removedUsers;
        deleted.push(customer);
        result.success(id);
      } catch (err) {
        this.logger.error(
          `Bulk delete failed for customer ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    // One UPDATE per counter per tenant, after the loop. Non-fatal: the rows
    // ARE deleted, so a failed counter write must not look like a failed
    // delete.
    const tenantId = actor.tenantId ?? deleted[0]?.tenantId;
    if (tenantId && deletedCustomers > 0) {
      await this.releaseQuota(tenantId, 'customers', deletedCustomers);
    }
    if (tenantId && deletedUsers > 0) {
      await this.releaseQuota(tenantId, 'users', deletedUsers);
    }

    if (deleted.length > 0) {
      this.eventEmitter.emit('customers.bulk.deleted', {
        customerIds: deleted.map((c) => c.id),
        tenantId,
        usersRemoved: deletedUsers,
      });
    }

    return result.build();
  }

  async bulkUpdate(
    dto: BulkUpdateCustomersDto,
    actor: User,
  ): Promise<BulkResultDto> {
    const patch: Record<string, unknown> = {};
    if (dto.status !== undefined) patch.status = dto.status;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        message: 'No updatable field supplied',
        errors: [
          'Supply at least one of: status',
          'allocatedLimits and grantedPermissions are deliberately not bulk-updatable',
        ],
      });
    }

    const result = new BulkResultBuilder(dto.ids);
    const customers = await this.resolveForBulk(result.ids, actor);
    const updated: Customer[] = [];

    for (const id of result.ids) {
      const customer = customers.get(id);

      if (!customer) {
        result.notFound(id, 'Customer not found in your scope');
        continue;
      }

      const changes = Object.entries(patch).filter(
        ([key, value]) =>
          (customer[key as keyof Customer] ?? null) !== (value ?? null),
      );

      if (changes.length === 0) {
        result.skipped(id, 'Already in the requested state');
        continue;
      }

      const previousStatus = customer.status;

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.update(Customer, { id: customer.id }, patch);
        });
        updated.push(customer);
        result.success(id);

        if (dto.status !== undefined) {
          this.eventEmitter.emit('customer.status.changed', {
            customerId: customer.id,
            status: dto.status,
            previousStatus,
          });
        }
      } catch (err) {
        this.logger.error(
          `Bulk update failed for customer ${id}: ${(err as Error).message}`,
        );
        result.failed(id, (err as Error).message);
      }
    }

    if (dto.status !== undefined && updated.length > 0) {
      this.eventEmitter.emit('customers.status.bulk.updated', {
        customerIds: updated.map((c) => c.id),
        status: dto.status,
      });
    }

    return result.build();
  }

  // ── Bulk helpers ───────────────────────────────────────────────────────────

  /**
   * Re-resolves every requested id inside the caller's tenant. This is the
   * security boundary: the request body is a bare uuid array, so nothing else
   * stops a caller submitting another tenant's customer ids.
   */
  private async resolveForBulk(
    ids: string[],
    actor: User,
  ): Promise<Map<string, Customer>> {
    if (ids.length === 0) return new Map();

    if (actor.role !== UserRole.SUPER_ADMIN && !actor.tenantId) {
      this.logger.warn(
        `Bulk customer request from ${actor.id} with role ${actor.role} and no tenantId — denied`,
      );
      return new Map();
    }

    const where =
      actor.role === UserRole.SUPER_ADMIN
        ? { id: In(ids) }
        : { id: In(ids), tenantId: actor.tenantId };

    const rows = await this.customerRepository.find({ where });
    return new Map(rows.map((customer) => [customer.id, customer]));
  }

  /**
   * customerId → number of live devices still pointing at it, counting both
   * the `devices.customerId` column and the `customer_devices` assignment
   * table, because the platform has both mechanisms and either one leaves an
   * orphan.
   */
  private async countAttachedDevices(
    customerIds: string[],
  ): Promise<Map<string, number>> {
    if (customerIds.length === 0) return new Map();

    const rows: Array<{ customerId: string; count: string }> =
      await this.dataSource.query(
        `SELECT "customerId", SUM(cnt) AS count FROM (
            SELECT "customerId", COUNT(*)::int AS cnt
              FROM devices
             WHERE "customerId" = ANY($1) AND deleted_at IS NULL
             GROUP BY "customerId"
            UNION ALL
            SELECT "customerId", COUNT(*)::int AS cnt
              FROM customer_devices
             WHERE "customerId" = ANY($1)
             GROUP BY "customerId"
         ) AS attached
         GROUP BY "customerId"`,
        [customerIds],
      );

    return new Map(rows.map((row) => [row.customerId, Number(row.count)]));
  }

  private async releaseQuota(
    tenantId: string,
    resource: keyof SubscriptionUsage,
    amount: number,
  ): Promise<void> {
    try {
      await this.subscriptionsService.decrementTenantUsage(
        tenantId,
        resource,
        amount,
      );
    } catch (err) {
      this.logger.error(
        `Failed to decrement ${String(resource)} usage for tenant ${tenantId} by ${amount}`,
        err,
      );
    }
  }

  /**
   * Get customers by tenant
   */
  async findByTenant(tenantId: string | undefined): Promise<Customer[]> {
    return await this.customerRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS / SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  async search(user: User, term: string, limit = 10): Promise<Customer[]> {
    const {tenantId} = user;
    const qb = this.customerRepository.createQueryBuilder('customer');
    qb.where(
      '(customer.name ILIKE :term OR customer.email ILIKE :term OR customer.city ILIKE :term)',
      { term: `%${term}%` },
    );
    if (tenantId) qb.andWhere('customer.tenantId = :tenantId', { tenantId });
    return qb.take(limit).getMany();
  }

  async getStatistics(tenantId?: string) {
    const qb = this.customerRepository.createQueryBuilder('customer');
    if (tenantId) qb.where('customer.tenantId = :tenantId', { tenantId });

    const [total, active, inactive, suspended] = await Promise.all([
      qb.getCount(),
      qb.clone().andWhere('customer.status = :s', { s: CustomerStatus.ACTIVE }).getCount(),
      qb.clone().andWhere('customer.status = :s', { s: CustomerStatus.INACTIVE }).getCount(),
      qb.clone().andWhere('customer.status = :s', { s: CustomerStatus.SUSPENDED }).getCount(),
    ]);

    return { total, active, inactive, suspended };
  }

  /**
   * Get public customers (accessible to all tenant users)
   */
  async getPublicCustomers(tenantId: string): Promise<Customer[]> {
    return await this.customerRepository.find({
      where: {
        tenantId,
        status: CustomerStatus.ACTIVE,
      },
      order: { name: 'ASC' },
    });
  }

  /**
   * Check if customer exists
   */
  async exists(id: string): Promise<boolean> {
    const count = await this.customerRepository.count({ where: { id } });
    return count > 0;
  }

  /**
   * Get customers by status
   */
  async findByStatus(
    status: CustomerStatus,
    tenantId?: string,
  ): Promise<Customer[]> {
    const where: any = { status };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return await this.customerRepository.find({
      where,
      order: { name: 'ASC' },
    });
  }

  // src/modules/customers/customers.service.ts

/**
 * Validates that the requested allocatedLimits for a customer do not exceed
 * what the tenant's subscription permits.
 *
 * Two checks per resource:
 *  1. Hard ceiling  — cannot exceed the plan limit itself
 *  2. Available cap — cannot exceed what the tenant hasn't used yet
 *     (so the sum of all customer allocations stays within the plan)
 *
 * -1 on a subscription limit = unlimited → skip that resource entirely.
 */
private validateAllocatedLimits(
  allocatedLimits: Customer['allocatedLimits'],
  subscription: Subscription,
): void {
  if (!allocatedLimits || Object.keys(allocatedLimits).length === 0) return;

  // Map customer allocatedLimits keys → subscription keys
  const resourceMap: Array<{
    customerKey: keyof Customer['allocatedLimits'];
    limitKey:    keyof SubscriptionLimits;
    usageKey:    keyof SubscriptionUsage;
    label:       string;
  }> = [
    { customerKey: 'devices',     limitKey: 'devices',     usageKey: 'devices',     label: 'Devices'     },
    { customerKey: 'dashboards',  limitKey: 'dashboards',  usageKey: 'dashboards',  label: 'Dashboards'  },
    { customerKey: 'assets',      limitKey: 'assets',      usageKey: 'assets',      label: 'Assets'      },
    { customerKey: 'floorPlans',  limitKey: 'floorPlans',  usageKey: 'floorPlans',  label: 'Floor Plans' },
    { customerKey: 'automations', limitKey: 'automations', usageKey: 'automations', label: 'Automations' },
    { customerKey: 'users',       limitKey: 'users',       usageKey: 'users',       label: 'Users'       },
  ];

  const errors: string[] = [];

  for (const { customerKey, limitKey, usageKey, label } of resourceMap) {
    const requested = allocatedLimits[customerKey];
    if (requested === undefined || requested === null) continue; // null = no cap, always valid

    const planLimit   = subscription.limits[limitKey] as number;
    const currentUsage = subscription.usage[usageKey] as number ?? 0;

    // -1 means unlimited on the subscription side — no cap to enforce
    if (planLimit === -1) continue;

    // 1. Cannot exceed the plan's hard ceiling
    if (requested > planLimit) {
      errors.push(
        `${label}: requested allocation (${requested}) exceeds plan limit (${planLimit})`,
      );
      continue; // no point checking available if already over ceiling
    }

    // 2. Cannot allocate more than what's still available at tenant level
    const available = planLimit - currentUsage;
    if (requested > available) {
      errors.push(
        `${label}: requested allocation (${requested}) exceeds available tenant capacity ` +
        `(${available} remaining — ${currentUsage}/${planLimit} used)`,
      );
    }
  }

  if (errors.length > 0) {
    throw new BadRequestException({
      message: 'Allocated limits exceed subscription capacity',
      errors,
    });
  }
}

  // ═══════════════════════════════════════════════════════════════════════════
  // PERMISSION GRANTS
  //
  // What a customer is allowed AT ALL, as decided by the tenant. This is the
  // outer of the two levers a tenant admin has; the inner one is each user's
  // roles and direct grants.
  //
  // `PermissionGuard` resolves a customer-scoped user to
  //
  //     (role permissions ∪ direct permissions) ∩ customer.grantedPermissions
  //
  // so an empty grant set is not "unrestricted" — it is **deny everything**.
  // That is the right default for security and was the wrong default in
  // practice: `grantedPermissions` had no endpoint to populate it (the DTO
  // existed, referenced by no controller) and no UI, so every customer created
  // through the product was permanently unable to call any permission-gated
  // route, whatever roles were assigned. `create()` now seeds a baseline and
  // these two methods let the tenant widen or narrow it.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The resources a customer may be granted at all.
   *
   * Tenant administration is deliberately absent: a customer must never be
   * grantable `users`, `roles`, `permissions`, `tenants`, `billing`, `audit`
   * or `settings`, because those govern the tenant that owns them. Keeping
   * this as an allow-list rather than a deny-list means a newly seeded
   * resource is excluded until someone decides otherwise.
   */
  private static readonly CUSTOMER_GRANTABLE_RESOURCES = [
    'devices',
    'assets',
    'dashboards',
    'telemetry',
    'alerts',
    'floor_plans',
    'analytics',
    'reports',
    'automations',
    'groups',
    'notifications',
    'profiles',
    'firmware',
    'edge',
    'integrations',
  ];

  /**
   * What a brand-new customer starts with: read-only across the resources a
   * customer is allowed to see.
   *
   * Read-only rather than nothing, because a customer with no grants cannot
   * use the product at all and the failure is a 403 with no explanation.
   * Read-only rather than full, because granting write access to someone
   * else's estate should be a decision, not a default.
   */
  private static readonly DEFAULT_CUSTOMER_ACTIONS = ['read', 'list'];

  /** Permissions a customer MAY hold, for the tenant's picker. */
  async getGrantablePermissions(tenantId: string | null): Promise<Permission[]> {
    const all = await this.permissionRepository.find({
      where: [{ tenantId: tenantId ?? undefined }, { tenantId: IsNull() }],
      order: { resource: 'ASC', action: 'ASC' },
    });
    return all.filter((p) =>
      CustomersService.CUSTOMER_GRANTABLE_RESOURCES.includes(p.resource),
    );
  }

  /** The customer's current grants. Tenant-checked. */
  async getGrantedPermissions(user: User, customerId: string): Promise<Permission[]> {
    const customer = await this.findOneScoped(user, customerId);
    return customer.grantedPermissions ?? [];
  }

  /**
   * Replace the customer's grants wholesale.
   *
   * A full replacement rather than add/remove: the UI shows a matrix and the
   * user's mental model is "this is what they may do", so a partial update
   * would silently keep a permission the admin had just unticked.
   */
  async setGrantedPermissions(
    user: User,
    customerId: string,
    permissionIds: string[],
  ): Promise<Customer> {
    const customer = await this.findOneScoped(user, customerId);

    const unique = [...new Set(permissionIds ?? [])];
    let permissions: Permission[] = [];

    if (unique.length > 0) {
      permissions = await this.permissionRepository.find({
        where: { id: In(unique) },
      });

      // An id that does not resolve is a bug in the caller, not something to
      // skip quietly — silently dropping it would show the admin a saved
      // matrix that does not match what was stored.
      if (permissions.length !== unique.length) {
        const found = new Set(permissions.map((p) => p.id));
        throw new BadRequestException(
          `Unknown permission id(s): ${unique.filter((id) => !found.has(id)).join(', ')}`,
        );
      }

      // Enforce the allow-list server-side. The picker already hides these,
      // but a crafted request must not be able to grant a customer authority
      // over the tenant that owns it.
      const forbidden = permissions.filter(
        (p) => !CustomersService.CUSTOMER_GRANTABLE_RESOURCES.includes(p.resource),
      );
      if (forbidden.length > 0) {
        throw new BadRequestException(
          'A customer cannot be granted tenant-administration permissions: ' +
            forbidden.map((p) => p.permissionString).join(', '),
        );
      }

      // A tenant must not grant another tenant's custom permission.
      const foreign = permissions.filter(
        (p) => p.tenantId && p.tenantId !== customer.tenantId,
      );
      if (foreign.length > 0) {
        throw new BadRequestException(
          'Those permissions belong to another tenant: ' +
            foreign.map((p) => p.permissionString).join(', '),
        );
      }
    }

    customer.grantedPermissions = permissions;
    const saved = await this.customerRepository.save(customer);

    this.logger.log(
      `Customer ${customerId} grants set to ${permissions.length} permission(s) by ${user.id}`,
    );

    // Every user under this customer has a different effective permission set
    // from this moment, so any cached resolution for them is stale.
    this.eventEmitter.emit('customer.permissions.changed', {
      customer: saved,
      tenantId: customer.tenantId,
      permissionCount: permissions.length,
      changedBy: user,
    });

    return saved;
  }

  /**
   * Load a customer with its grants, refusing one outside the caller's tenant.
   *
   * Separate from `findOne()` because this needs the `grantedPermissions`
   * relation and a hard tenant check on every path — a permission editor that
   * can be pointed at another tenant's customer is worse than no editor.
   */
  private async findOneScoped(user: User, customerId: string): Promise<Customer> {
    const customer = await this.customerRepository.findOne({
      where: { id: customerId },
      relations: ['grantedPermissions'],
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    if (
      user.role !== UserRole.SUPER_ADMIN &&
      customer.tenantId !== user.tenantId
    ) {
      // Same answer as a missing customer: confirming existence is a leak.
      throw new NotFoundException('Customer not found');
    }

    return customer;
  }

  /** The baseline grant set applied to a new customer. */
  private async defaultGrantedPermissions(
    tenantId: string | null,
  ): Promise<Permission[]> {
    const grantable = await this.getGrantablePermissions(tenantId);
    return grantable.filter((p) =>
      CustomersService.DEFAULT_CUSTOMER_ACTIONS.includes(p.action),
    );
  }

  /**
   * Annotate customers with the activation state of their primary login.
   *
   * `invitationPending` is the field the UI needs: true means an invitation
   * was issued and not yet accepted, which is the one case where "Resend"
   * is the right action. It is computed, not stored — adding a column would
   * mean keeping it in step with the user row forever, and this is a read.
   */
  private async attachLoginState(customers: Customer[]): Promise<Customer[]> {
    if (customers.length === 0) return customers;

    const rows = await this.userRepository.find({
      where: {
        customerId: In(customers.map((c) => c.id)),
        role: UserRole.CUSTOMER,
      },
      select: [
        'id',
        'customerId',
        'email',
        'status',
        'emailVerified',
        'lastLoginAt',
        'setPasswordExpires',
      ],
    });

    const byCustomer = new Map(rows.map((u) => [u.customerId, u]));

    return customers.map((customer) => {
      const login = byCustomer.get(customer.id);
      return Object.assign(customer, {
        loginEmail: login?.email ?? null,
        loginStatus: login?.status ?? null,
        loginEmailVerified: login?.emailVerified ?? null,
        lastLoginAt: login?.lastLoginAt ?? null,
        // An account that exists, has never verified, and still holds an
        // unexpired invitation window.
        invitationPending: login
          ? !login.emailVerified && login.status !== UserStatus.SUSPENDED
          : false,
        invitationExpiresAt: login?.setPasswordExpires ?? null,
      });
    });
  }
}
