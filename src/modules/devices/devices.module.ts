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
import { Tenant } from '../index.entities';
import { TenantsService } from '../tenants/tenants.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceCredentials, User, Tenant]),
    SubscriptionsModule,
  ],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceCredentialsService, TenantsService],
  exports: [DevicesService, DeviceCredentialsService],
})
export class DevicesModule {}