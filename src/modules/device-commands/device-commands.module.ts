// src/modules/device-commands/device-commands.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { Device } from '../devices/entities/device.entity';
import { DeviceCommandsService } from './device-commands.service';
import { DeviceCommandsController } from './device-commands.controller';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { ProtocolsModule } from '../protocols/protocols.module';
import { DeviceCommandsConsumer } from './device-commands.consumer';

@Module({
  imports: [TypeOrmModule.forFeature([DeviceCommand, Device]), KafkaModule, ProtocolsModule],
  controllers: [DeviceCommandsController],
  providers: [DeviceCommandsService, DeviceCommandsConsumer],
  exports: [DeviceCommandsService],
})
export class DeviceCommandsModule {}
