import { Injectable, Logger } from "@nestjs/common";
import { MailService, SubscriptionsService, TenantsService } from "../index.service";
import { OnEvent } from "@nestjs/event-emitter";
import { Customer } from "../index.entities";
import { CustomerStatus, UserRole, UserStatus } from "@common/enums/index.enum";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";

@Injectable()
export class CustomerListener {
  private readonly logger = new Logger(CustomerListener.name);

  constructor(@InjectRepository(Customer) private readonly customerRepository: Repository<Customer>, private readonly mailService: MailService, private readonly tenantService: TenantsService, private readonly subscriptionsService: SubscriptionsService) {}

  @OnEvent('customer.created')
  async handleCustomerCreated(payload: {
    customer: Customer;
    email: string;
    name: string;
    tenantId: string;
    setPasswordToken: string;
    role: UserRole;
  }) {
    const tenant = await this.tenantService.findOne(payload.tenantId);
    try {
      await this.mailService.sendInvitationEmail(
        payload.email,
        payload.name,
        tenant.name,
        payload.setPasswordToken,
        payload.role,
      );
      this.logger.log(`Customer invitation email sent to: ${payload.email}`);
    } catch (err) {
      this.logger.error(
        `Failed to send customer invitation email to ${payload.email}:`,
        err,
      );
    }
  try {
    await this.subscriptionsService.incrementTenantUsage(
      payload.tenantId,
      'customers',
      1,
    );
      await this.subscriptionsService.incrementTenantUsage(
      payload.tenantId,
      'users',
      1,
    );
  } catch (err) {
    this.logger.error('Failed to increment subscription usage for customers', err);
  }
  }

  @OnEvent('customer.deleted')
  async handleDeviceDeleted(payload: { customerId: string, tenantId: string }) {
  try {
    await this.subscriptionsService.decrementTenantUsage(
      payload.tenantId,
      'customers',
      1,
    );
       await this.subscriptionsService.decrementTenantUsage(
      payload.tenantId,
      'users',
      1,
    );
  } catch (err) {
    this.logger.error(`Failed to decrement customer usage for tenant ${payload.tenantId}:`, err);
  }
  }

  @OnEvent('user.deleted')
  async handleUserDeleted(payload: {
    userId: string;
    role: UserRole;
    customerId?: string;
    tenantId?: string;
  }) {
    if (payload.role !== UserRole.CUSTOMER || !payload.customerId) return;

    try {
      const customer = await this.customerRepository.findOne({
        where: { id: payload.customerId },
      });

      if (customer) {
        await this.customerRepository.remove(customer);
        this.logger.log(
          `Customer ${payload.customerId} removed after CUSTOMER user ${payload.userId} deletion`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to cascade-delete customer ${payload.customerId} after user deletion`,
        err,
      );
    }
  }

  @OnEvent('user.status.changed')
  async handleUserStatusChanged(payload: {
    userId: string;
    role: UserRole;
    customerId?: string;
    status: UserStatus;
    previousStatus: UserStatus;
  }) {
    if (payload.role !== UserRole.CUSTOMER || !payload.customerId) return;

    const statusMap: Partial<Record<UserStatus, CustomerStatus>> = {
      [UserStatus.ACTIVE]:    CustomerStatus.ACTIVE,
      [UserStatus.INACTIVE]:  CustomerStatus.INACTIVE,
      [UserStatus.SUSPENDED]: CustomerStatus.SUSPENDED,
    };

    const customerStatus = statusMap[payload.status];
    if (!customerStatus) return;

    try {
      await this.customerRepository.update(
        { id: payload.customerId },
        { status: customerStatus },
      );
      this.logger.log(
        `Customer ${payload.customerId} status synced to ${customerStatus}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to sync customer ${payload.customerId} status`,
        err,
      );
    }
  }

  @OnEvent('users.status.bulk.updated')
  async handleBulkStatusUpdated(payload: {
    status: UserStatus;
    affectedUsers: Array<{
      userId: string;
      role: UserRole;
      customerId?: string;
      tenantId?: string;
    }>;
  }) {
    const statusMap: Partial<Record<UserStatus, CustomerStatus>> = {
      [UserStatus.ACTIVE]:    CustomerStatus.ACTIVE,
      [UserStatus.INACTIVE]:  CustomerStatus.INACTIVE,
      [UserStatus.SUSPENDED]: CustomerStatus.SUSPENDED,
    };

    const customerStatus = statusMap[payload.status];
    if (!customerStatus) return;

    const customerIds = payload.affectedUsers
      .filter(u => u.role === UserRole.CUSTOMER && u.customerId)
      .map(u => u.customerId!);

    if (customerIds.length === 0) return;

    try {
      await this.customerRepository.update(
        { id: In(customerIds) },
        { status: customerStatus },
      );
      this.logger.log(
        `Bulk synced ${customerIds.length} customer(s) to status ${customerStatus}`,
      );
    } catch (err) {
      this.logger.error('Failed to bulk sync customer statuses', err);
    }
  }
}