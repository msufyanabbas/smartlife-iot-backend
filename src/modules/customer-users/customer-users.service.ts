import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomersService } from '../customers/customers.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { UserRole, UserStatus } from '@common/enums/index.enum';
import { Customer } from '../customers/entities/customers.entity';
import { MailService } from '../mail/mail.service';
import { TenantsService } from '../tenants/tenants.service';
import * as crypto from 'crypto'
import { CreateCustomerUserDto, CreateCustomerUserRequestDto } from './dto/customer-users.dto';
import { CustomerUserLimit, Role } from '../index.entities';
import { AssignmentService } from '../assignments/assignment.service';

/**
 * Service to manage relationships between Customers and Users
 * Handles customer user assignments, access control, and related operations
 */
@Injectable()
export class CustomerUsersService {
   private readonly logger = new Logger(CustomerUsersService.name);
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private customersService: CustomersService,
    @InjectRepository(Role)                  // 👈 add this
  private roleRepository: Repository<Role>,
    private usersService: UsersService,
     private tenantService: TenantsService,
    private mailService: MailService,
    private eventEmitter: EventEmitter2,
    @InjectRepository(CustomerUserLimit)
  private userLimitsRepository: Repository<CustomerUserLimit>,
   private assignmentService: AssignmentService,
  ) {}

  

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE CUSTOMER USER (with invitation)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates a new CUSTOMER_USER account and sends a set-password email.
   *
   * Called by: tenant admin or customer admin (controller enforces roles).
   *
   * @param dto             - New user details
   * @param callerTenantId  - From JWT, used for isolation checks
   * 
   * ba92b0a9-df9f-477e-8a86-44a7a599a385
   */
  async createCustomerUser(
    dto: CreateCustomerUserRequestDto,
    user: User,
  ): Promise<User> {
    const customer = await this.customersService.findOne(user.tenantId, user.customerId || dto.customerId);

    // Tenant isolation — customer must belong to the caller's tenant
    if (customer.tenantId !== user.tenantId) {
      throw new ForbiddenException('Customer does not belong to your tenant');
    }

    // Check email uniqueness
    const existing = await this.userRepository.findOne({
      where: { email: dto.email, tenantId: user.tenantId },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists in this tenant');
    }

      // Resolve optional custom role
  let assignedRoles: Role[] = [];
  if (dto.roleId) {
   const role = await this.roleRepository.findOne({
  where: [
    // System roles (global)
    { id: dto.roleId, isSystem: true },

    // Custom roles (tenant-scoped)
    { id: dto.roleId, tenantId: user.tenantId, isSystem: false },
  ],
});
    if (!role) {
      throw new NotFoundException(`Role ${dto.roleId} not found in your tenant`);
    }
    assignedRoles = [role];
  }

    // Generate set-password token (7-day window)
    const setPasswordToken = crypto.randomBytes(32).toString('hex');
    const setPasswordExpires = new Date();
    setPasswordExpires.setDate(setPasswordExpires.getDate() + 7);

    const newUser = this.userRepository.create({
      email: dto.email,
      name: dto.name,
      phone: dto.phone,
      password: 'UNSET_' + crypto.randomBytes(16).toString('hex'),
      role: UserRole.CUSTOMER_USER,
      status: UserStatus.INACTIVE,
      emailVerified: false,
      tenantId: user.tenantId,
      customerId: user.customerId || dto.customerId,
      setPasswordToken,
      setPasswordExpires,
      roles: assignedRoles
    });

    const saved = await this.userRepository.save(newUser);
    this.logger.log(
      `Customer user created: ${dto.email} (customer: ${customer.id})`,
    );

    // Send invitation
    try {
      await this.mailService.sendInvitationEmail(
        dto.email,
        dto.name,
        customer.name,
        setPasswordToken,
        UserRole.CUSTOMER_USER
      );
      this.logger.log(`Customer user invitation sent to: ${dto.email}`);
    } catch (err) {
      this.logger.error(
        `Failed to send customer user invitation to ${dto.email}:`,
        err,
      );
    }

    this.eventEmitter.emit('customer.user.created', {
      userId: saved.id,
      customerId: user.customerId,
    });

    return saved;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SET PASSWORD (first-time activation — shared logic, but scoped to CUSTOMER_USER)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Customer users call this after clicking their invitation link.
   * We reuse the same setPasswordToken column on User.
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
        'This invitation link has expired. Please ask your admin to resend it.',
      );
    }

    user.password = newPassword; // @BeforeUpdate hook hashes it
    user.status = UserStatus.ACTIVE;
    user.emailVerified = true;
    user.setPasswordToken = undefined;
    user.setPasswordExpires = undefined;

    await this.userRepository.save(user);
    this.logger.log(`Password set and account activated for: ${user.email}`);

    return { message: 'Password set successfully. You can now log in.' };
  }

  /**
   * Resend invitation to a customer user whose token expired.
   */
  async resendCustomerUserInvitation(
    userId: string,
    user: User,
  ): Promise<{ message: string }> {
    const newUser = await this.userRepository.findOne({ where: { id: userId, tenantId: user.tenantId, customerId: user.customerId } });
    const tenant = await this.tenantService.findOne(user.tenantId);

    if (!newUser) throw new NotFoundException('User not found');
    if (newUser.tenantId !== user.tenantId) {
      throw new ForbiddenException('User does not belong to your tenant');
    }
    if (newUser.status === UserStatus.ACTIVE && newUser.emailVerified) {
      throw new BadRequestException('This user has already activated their account');
    }

    const setPasswordToken = crypto.randomBytes(32).toString('hex');
    const setPasswordExpires = new Date();
    setPasswordExpires.setDate(setPasswordExpires.getDate() + 7);

    newUser.setPasswordToken = setPasswordToken;
    newUser.setPasswordExpires = setPasswordExpires;
    await this.userRepository.save(newUser);

    const customer = user.customerId
      ? await this.customersService.findOne(user.tenantId, user.customerId)
      : null;

    await this.mailService.sendInvitationEmail(
      user.email,
      user.name,
      tenant.name,
      setPasswordToken,
      UserRole.CUSTOMER_USER
    );

    return { message: 'Invitation email resent successfully' };
  }

















  /**
   * Assign a user to a customer (make them a CUSTOMER_USER)
   */
  async assignUserToCustomer(
    userId: string,
    customerId: string,
  ): Promise<User> {
    const user = await this.usersService.findOne(userId);
    const customer = await this.customersService.findOne(user.tenantId, customerId);

    // Validate tenant match
    if (user.tenantId !== customer.tenantId) {
      throw new BadRequestException(
        'User and Customer must belong to the same tenant',
      );
    }

    // Update user role and customer assignment
    user.role = UserRole.CUSTOMER_USER;
    user.customerId = customerId;

    const updatedUser = await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('customer.user.assigned', {
      userId,
      customerId,
      customer,
    });

    return updatedUser;
  }

  /**
   * Remove user from customer (unassign)
   */
  async removeUserFromCustomer(userId: string): Promise<User> {
    const user = await this.usersService.findOne(userId);

    if (!user.customerId) {
      throw new BadRequestException('User is not assigned to any customer');
    }

    const previousCustomerId = user.customerId;

    // Remove customer assignment
    user.customerId = undefined;
    // Optionally change role back to USER
    if (user.role === UserRole.CUSTOMER_USER) {
      user.role = UserRole.USER;
    }

    const updatedUser = await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('customer.user.removed', {
      userId,
      previousCustomerId,
    });

    return updatedUser;
  }

  /**
   * Get all users for a specific customer
   */
  async getUsersByCustomer(tenantId: string | undefined, customerId: string): Promise<User[]> {
    await this.customersService.findOne(tenantId, customerId); // Validate customer exists

    return await this.userRepository.find({
      where: { customerId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get customer for a specific user
   */
  async getCustomerForUser(userId: string): Promise<Customer | null> {
    const user = await this.usersService.findOne(userId);

    if (!user.customerId) {
      return null;
    }

    return await this.customersService.findOne(user.tenantId, user.customerId);
  }

  /**
   * Bulk assign users to a customer
   */
  async bulkAssignUsersToCustomer(
    user: User,
    userIds: string[],
    customerId: string,
  ): Promise<{
    successful: string[];
    failed: Array<{ userId: string; reason: string }>;
  }> {
    const customer = await this.customersService.findOne(user.tenantId, customerId);
    const successful: string[] = [];
    const failed: Array<{ userId: string; reason: string }> = [];

    for (const userId of userIds) {
      try {
        const user = await this.usersService.findOne(userId);

        // Validate tenant match
        if (user.tenantId !== customer.tenantId) {
          failed.push({
            userId,
            reason: 'User and Customer belong to different tenants',
          });
          continue;
        }

        // Assign user
        user.role = UserRole.CUSTOMER_USER;
        user.customerId = customerId;
        await this.userRepository.save(user);

        successful.push(userId);
      } catch (error) {
        failed.push({
          userId,
          reason: error.message || 'Unknown error',
        });
      }
    }

    // Emit event
    this.eventEmitter.emit('customer.users.bulk.assigned', {
      customerId,
      successful,
      failed,
    });

    return { successful, failed };
  }

  /**
   * Transfer user from one customer to another
   */
  async transferUserToCustomer(
    userId: string,
    newCustomerId: string,
  ): Promise<User> {
    const user = await this.usersService.findOne(userId);
    const newCustomer = await this.customersService.findOne(user.tenantId, newCustomerId);

    // Validate tenant match
    if (user.tenantId !== newCustomer.tenantId) {
      throw new BadRequestException(
        'User and Customer must belong to the same tenant',
      );
    }

    const previousCustomerId = user.customerId;

    // Update customer assignment
    user.customerId = newCustomerId;
    user.role = UserRole.CUSTOMER_USER;

    const updatedUser = await this.userRepository.save(user);

    // Emit event
    this.eventEmitter.emit('customer.user.transferred', {
      userId,
      previousCustomerId,
      newCustomerId,
    });

    return updatedUser;
  }

  /**
   * Check if user has access to a specific customer
   */
  async hasAccessToCustomer(user: User, customerId: string): Promise<boolean> {
    // Super Admin and Tenant Admin have access to all customers in their scope
    if (
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.TENANT_ADMIN
    ) {
      return true;
    }

    // Customer users can only access their assigned customer
    if (user.role === UserRole.CUSTOMER_USER) {
      return user.customerId === customerId;
    }

    // Default: no access
    return false;
  }

  /**
   * Get customers accessible by a user
   */
  async getAccessibleCustomers(user: User): Promise<Customer[]> {
    // Super Admin: all customers
    if (user.role === UserRole.SUPER_ADMIN) {
      const result = await this.customersService.findAll({}, user.tenantId);
      return result.customers;
    }

    // Tenant Admin: all customers in their tenant
    if (user.role === UserRole.TENANT_ADMIN && user.tenantId) {
      return await this.customersService.findByTenant(user.tenantId);
    }

    // Customer User: only their customer
    if (user.role === UserRole.CUSTOMER_USER && user.customerId) {
      const customer = await this.customersService.findOne(user.tenantId, user.customerId);
      return [customer];
    }

    return [];
  }

  /**
   * Validate user can perform action on customer
   */
  async validateCustomerAccess(
    user: User,
    customerId: string,
  ): Promise<void> {
    const hasAccess = await this.hasAccessToCustomer(user, customerId);

    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have access to this customer',
      );
    }
  }

  /**
   * Get statistics about customer users
   */
  async getCustomerUserStatistics(user: User, customerId: string): Promise<{
    totalUsers: number;
    activeUsers: number;
    inactiveUsers: number;
  }> {
    await this.customersService.findOne(user.tenantId, customerId); // Validate customer exists

    const allUsers = await this.userRepository.find({
      where: { customerId },
    });

    const totalUsers = allUsers.length;
    const activeUsers = allUsers.filter((u) => u.isActive()).length;
    const inactiveUsers = totalUsers - activeUsers;

    return {
      totalUsers,
      activeUsers,
      inactiveUsers,
    };
  }

  /**
   * Search users within a customer
   */
  async searchCustomerUsers(
    user: User,
    customerId: string,
    searchTerm: string,
    limit: number = 10,
  ): Promise<User[]> {
    await this.customersService.findOne(user.tenantId, customerId); // Validate customer exists

    return await this.userRepository
      .createQueryBuilder('user')
      .where('user.customerId = :customerId', { customerId })
      .andWhere(
        '(user.name ILIKE :search OR user.email ILIKE :search)',
        { search: `%${searchTerm}%` },
      )
      .take(limit)
      .getMany();
  }

  /**
   * When a customer is deleted, handle all associated users
   */
  async handleCustomerDeletion(tenantId: string | undefined, customerId: string): Promise<void> {
    const users = await this.getUsersByCustomer(tenantId, customerId);

    // Remove customer assignment from all users
    for (const user of users) {
      user.customerId = undefined;
      user.role = UserRole.USER; // Revert to basic user role
      await this.userRepository.save(user);
    }

    // Emit event
    this.eventEmitter.emit('customer.users.unassigned', {
      customerId,
      affectedUserIds: users.map((u) => u.id),
    });
  }


  async getCustomerUserWithResources(userId: string, requestingUser: User) {
  const user = await this.userRepository.findOne({
    where: { id: userId, tenantId: requestingUser.tenantId },
    relations: ['roles', 'directPermissions'],
  });

  if (!user) throw new NotFoundException('User not found');

  // Get their limits record if exists
  const userLimit = await this.userLimitsRepository.findOne({
    where: { userId, customerId: user.customerId },
  });

  const assignedResources = await this.assignmentService.getUserResourceSummary(
    userId,
    requestingUser.tenantId,
  );

  return {
    ...user,
    assignedResources,        // how many of each resource assigned
    limits: userLimit?.limits ?? null,        // per-resource caps
    usageCounters: userLimit?.usageCounters ?? null, // usage within caps
  };
}

async getTenantHierarchy(requestingUser: User) {
  // ── For CUSTOMER_USER: return only their own slice ──────────────────
  if (requestingUser.role === UserRole.CUSTOMER_USER) {
    return this.getSingleCustomerHierarchy(
      requestingUser.tenantId,
      requestingUser.customerId!,
      requestingUser,
    );
  }

  // ── For CUSTOMER admin: return their customer + its users ────────────
  if (requestingUser.role === UserRole.CUSTOMER) {
    const customer = await this.customersService.findOne(
      requestingUser.tenantId,
      requestingUser.customerId!,
    );
    return {
      customer: await this.buildCustomerNode(customer, requestingUser.tenantId),
    };
  }

  // ── For TENANT_ADMIN / SUPER_ADMIN: full tree ────────────────────────
  const customers = await this.customersService.findByTenant(requestingUser.tenantId!);

  const customerNodes = await Promise.all(
    customers.map(c => this.buildCustomerNode(c, requestingUser.tenantId)),
  );

  return {
    tenantId: requestingUser.tenantId,
    totalCustomers: customers.length,
    customers: customerNodes,
  };
}

// ── Private helpers ────────────────────────────────────────────────────────

private async buildCustomerNode(customer: Customer, tenantId: string | undefined) {
  const users = await this.userRepository.find({
    where: { customerId: customer.id, tenantId },
    select: ['id', 'name', 'email', 'role', 'status', 'createdAt'],
  });

  const userNodes = await Promise.all(
    users.map(async (u) => {
      const resources = await this.assignmentService.getUserResourceSummary(u.id, tenantId!);
      return { ...u, assignedResources: resources };
    }),
  );

  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    status: customer.status,
    usageCounters: customer.usageCounters,
    allocatedLimits: customer.allocatedLimits,
    totalUsers: users.length,
    users: userNodes,
  };
}

private async getSingleCustomerHierarchy(
  tenantId: string | undefined,
  customerId: string,
  requestingUser: User,
) {
  const customer = await this.customersService.findOne(tenantId, customerId);
  return {
    customer: await this.buildCustomerNode(customer, tenantId),
  };
}
}