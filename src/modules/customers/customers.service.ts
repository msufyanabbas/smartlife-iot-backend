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
import { Repository, Like, In, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomerStatus, UserRole, UserStatus } from '@/common/enums/index.enum';
import { Customer, Subscription, User } from '@modules/index.entities';
import * as crypto from 'crypto';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  BulkUpdateCustomerStatusDto,
} from './dto/customers.dto';
import { MailService } from '../mail/mail.service';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import { SubscriptionsService } from '../index.service';
import { SubscriptionLimits, SubscriptionUsage } from '@/common/interfaces/subscription.interface';
@Injectable()
export class CustomersService {
   private readonly logger = new Logger(CustomersService.name);
  constructor(
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
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
    const customer = manager.create(Customer, {
      ...createCustomerDto,
      tenantId: user.tenantId,
      status: CustomerStatus.INACTIVE,
    });
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
    user.setPasswordToken = undefined;
    user.setPasswordExpires = undefined;

    await this.userRepository.save(user);
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
  }, tenantId: string | undefined): Promise<{
    customers: Customer[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
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

    return {
      customers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
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
   * Bulk update customer status
   */
  async bulkUpdateStatus(
    bulkUpdateDto: BulkUpdateCustomerStatusDto,
  ): Promise<void> {
    await this.customerRepository.update(
      { id: In(bulkUpdateDto.customerIds) },
      { status: bulkUpdateDto.status },
    );

    // Emit event
    this.eventEmitter.emit('customers.status.bulk.updated', {
      customerIds: bulkUpdateDto.customerIds,
      status: bulkUpdateDto.status,
    });
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
}