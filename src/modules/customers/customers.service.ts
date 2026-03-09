import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomerStatus, UserRole, UserStatus } from '@/common/enums/index.enum';
import { Customer, Tenant, User } from '@modules/index.entities';
import * as crypto from 'crypto';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
  BulkUpdateCustomerStatusDto,
} from './dto/customers.dto';
import { MailService, TenantsService } from '../index.service';

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
    // Check if customer with same title exists in this tenant
    const existingCustomer = await this.customerRepository.findOne({
      where: {
        name: createCustomerDto.name,
        tenantId: user.tenantId,
      },
    });

    const tenant = await this.tenantService.findOne(user.tenantId);

    if (existingCustomer) {
      throw new ConflictException(
        'Customer with this title already exists in this tenant',
      );
    }

    // ── Email is required to create the login user ─────────────────────────
    if (!createCustomerDto.email) {
      throw new BadRequestException(
        'Customer email is required so a login account can be created',
      );
    }

    // ── Check if a user with this email already exists ─────────────────────
    const existingUser = await this.userRepository.findOne({
      where: { email: createCustomerDto.email },
    });
    if (existingUser) {
      throw new ConflictException(
        'A user with this email already exists',
      );
    }

    // ── 1. Persist customer row ────────────────────────────────────────────
    const customer = this.customerRepository.create({
      ...createCustomerDto,
      tenantId: user.tenantId, // always from JWT, never from body
    });
    const savedCustomer = await this.customerRepository.save(customer);

    // ── 2. Create linked User (CUSTOMER role, no password yet) ────────────
    const setPasswordToken = crypto.randomBytes(32).toString('hex');
    const setPasswordExpires = new Date();
    setPasswordExpires.setDate(setPasswordExpires.getDate() + 7); // 7-day window

    const newUser = this.userRepository.create({
      email: createCustomerDto.email,
      name: createCustomerDto.name,
      phone: createCustomerDto.phone,
      // Use a random placeholder — the real password is set via the token link.
      // The bcrypt hook will hash this, but it will never be usable for login
      // because the account is INACTIVE until they click the link.
      password: 'UNSET_' + crypto.randomBytes(16).toString('hex'),
      role: UserRole.CUSTOMER,
      status: UserStatus.INACTIVE,     // ← cannot login until they set a password
      emailVerified: false,
      tenantId: user.tenantId,
      customerId: savedCustomer.id,
      setPasswordToken,
      setPasswordExpires,
    });

    await this.userRepository.save(newUser);
    this.logger.log(`Customer user created: ${createCustomerDto.email} (customer: ${savedCustomer.id})`);

    // ── 3. Send set-password invitation email ──────────────────────────────
    try {
      await this.mailService.sendInvitationEmail(
        createCustomerDto.email,
        createCustomerDto.name,
        tenant.name,
        setPasswordToken,
        UserRole.CUSTOMER
      );
      this.logger.log(`Customer invitation email sent to: ${createCustomerDto.email}`);
    } catch (err) {
      // Non-fatal — admin can resend later; customer record is already created
      this.logger.error(
        `Failed to send customer invitation email to ${createCustomerDto.email}:`,
        err,
      );
    }

    this.eventEmitter.emit('customer.created', { customer: savedCustomer });

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
    const customer = await this.findOne(customerId);
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
    tenantId?: string;
    isPublic?: boolean;
  }): Promise<{
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

    if (options.tenantId) {
      queryBuilder.andWhere('customer.tenantId = :tenantId', {
        tenantId: options.tenantId,
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
  async findOne(id: string | undefined): Promise<Customer> {
    const customer = await this.customerRepository.findOne({ where: { id } });

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
    id: string,
    updateCustomerDto: UpdateCustomerDto,
  ): Promise<Customer> {
    const customer = await this.findOne(id);

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

    Object.assign(customer, updateCustomerDto);

    const updatedCustomer = await this.customerRepository.save(customer);

    // Emit event
    this.eventEmitter.emit('customer.updated', { customer: updatedCustomer });

    return updatedCustomer;
  }

  /**
   * Delete customer (soft delete)
   */
  async remove(id: string): Promise<void> {
    const customer = await this.findOne(id);

    await this.customerRepository.softRemove(customer);

    // Emit event
    this.eventEmitter.emit('customer.deleted', { customerId: id });
  }

  /**
   * Update customer status
   */
  async updateStatus(
    customerId: string,
    status: CustomerStatus,
  ): Promise<Customer> {
    const customer = await this.findOne(customerId);
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
  async findByTenant(tenantId: string): Promise<Customer[]> {
    return await this.customerRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS / SEARCH
  // ═══════════════════════════════════════════════════════════════════════════

  async search(term: string, tenantId?: string, limit = 10): Promise<Customer[]> {
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
}