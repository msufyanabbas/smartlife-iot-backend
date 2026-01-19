// src/modules/devices/devices.module.ts
// UPDATED - Now includes DeviceCredentialsService

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { DeviceCredentialsService } from './device-credentials.service';
import { Device } from './entities/device.entity';
import { DeviceCredentials } from './entities/device-credentials.entity';
import { User } from '../users/entities/user.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { EmailTemplate, Tenant } from '../index.entities';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceCredentials, User, Tenant, EmailTemplate]),
    SubscriptionsModule,
  ],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceCredentialsService, TenantsService, UsersService, MailService, EmailTemplatesService],
  exports: [DevicesService, DeviceCredentialsService, UsersService, MailService, EmailTemplatesService],
})
export class DevicesModule {}