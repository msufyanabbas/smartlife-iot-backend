// src/modules/device-commands/device-commands.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { Device } from '../devices/entities/device.entity';
import { DeviceCommandsService } from './device-commands.service';
import { DeviceCommandsController } from './device-commands.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceCommand, Device])],
  controllers: [DeviceCommandsController],
  providers: [DeviceCommandsService],
  exports: [DeviceCommandsService],
})
export class DeviceCommandsModule {}
