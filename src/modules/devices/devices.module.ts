import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { DeviceCredentialsService } from './device-credentials.service';
import { Device } from './entities/device.entity';
import { DeviceCredentials } from './entities/device-credentials.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ProtocolsModule } from '../protocols/protocols.module';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { RolesModule } from '../index.module';


@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceCredentials]),
    SubscriptionsModule,
    RolesModule,
    ProtocolsModule,
    UsersModule,
    MailModule,
  ],
  controllers: [DevicesController],
  providers: [DevicesService, DeviceCredentialsService],
  exports: [DevicesService, DeviceCredentialsService],
})
export class DevicesModule {}