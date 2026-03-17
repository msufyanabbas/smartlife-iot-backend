import { Injectable, Logger } from "@nestjs/common";
import { MailService, SubscriptionsService, TenantsService } from "../index.service";
import { OnEvent } from "@nestjs/event-emitter";
import { Customer } from "../index.entities";
import { UserRole } from "@common/enums/index.enum";

@Injectable()
export class CustomerListener {
  private readonly logger = new Logger(CustomerListener.name);

  constructor(private readonly mailService: MailService, private readonly tenantService: TenantsService, private readonly subscriptionsService: SubscriptionsService) {}

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
  } catch (err) {
    this.logger.error(`Failed to decrement customer usage for tenant ${payload.tenantId}:`, err);
  }
  }
}