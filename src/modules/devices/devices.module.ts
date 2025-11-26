import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { Device } from './entities/device.entity';
import { User } from '../users/entities/user.entity';
import { DeviceCredentials } from '../index.entities';

@Module({
  imports: [TypeOrmModule.forFeature([Device, User, DeviceCredentials])],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
