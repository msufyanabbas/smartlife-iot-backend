import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CustomersService } from '../customers/customers.service';
import { UsersService } from '../users/users.service';
import { User, UserRole } from '../users/entities/user.entity';
import { Customer } from '../customers/entities/customers.entity';

/**
 * Service to manage relationships between Customers and Users
 * Handles customer user assignments, access control, and related operations
 */
@Injectable()
export class CustomerUsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private customersService: CustomersService,
    private usersService: UsersService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Assign a user to a customer (make them a CUSTOMER_USER)
   */
  async assignUserToCustomer(
    userId: string,
    customerId: string,
  ): Promise<User> {
    const user = await this.usersService.findOne(userId);
    const customer = await this.customersService.findOne(customerId);

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
  async getUsersByCustomer(customerId: string): Promise<User[]> {
    await this.customersService.findOne(customerId); // Validate customer exists

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

    return await this.customersService.findOne(user.customerId);
  }

  /**
   * Bulk assign users to a customer
   */
  async bulkAssignUsersToCustomer(
    userIds: string[],
    customerId: string,
  ): Promise<{
    successful: string[];
    failed: Array<{ userId: string; reason: string }>;
  }> {
    const customer = await this.customersService.findOne(customerId);
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
    const newCustomer = await this.customersService.findOne(newCustomerId);

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
      const result = await this.customersService.findAll({});
      return result.customers;
    }

    // Tenant Admin: all customers in their tenant
    if (user.role === UserRole.TENANT_ADMIN && user.tenantId) {
      return await this.customersService.findByTenant(user.tenantId);
    }

    // Customer User: only their customer
    if (user.role === UserRole.CUSTOMER_USER && user.customerId) {
      const customer = await this.customersService.findOne(user.customerId);
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
  async getCustomerUserStatistics(customerId: string): Promise<{
    totalUsers: number;
    activeUsers: number;
    inactiveUsers: number;
  }> {
    await this.customersService.findOne(customerId); // Validate customer exists

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
    customerId: string,
    searchTerm: string,
    limit: number = 10,
  ): Promise<User[]> {
    await this.customersService.findOne(customerId); // Validate customer exists

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
  async handleCustomerDeletion(customerId: string): Promise<void> {
    const users = await this.getUsersByCustomer(customerId);

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
}