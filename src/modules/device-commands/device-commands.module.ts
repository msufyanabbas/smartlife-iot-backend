import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceCommand } from '@modules/device-commands/entities/device-commands.entity';
import { Device } from '../devices/entities/device.entity';
import { DeviceCommandsService } from './device-commands.service';
import { DeviceCommandsController } from './device-commands.controller';
import { DeviceCommandsConsumer } from './device-commands.consumer';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DeviceCommand, Device]),
    KafkaModule,
    // Circular: GatewayModule now imports this module too, because
    // GatewayService persists a two-way RPC's outcome through
    // DeviceCommandsService. forwardRef is required at both ends.
    forwardRef(() => GatewayModule), // provides GatewayService → DeviceCommandsConsumer
  ],
  controllers: [DeviceCommandsController],
  providers: [DeviceCommandsService, DeviceCommandsConsumer],
  exports: [DeviceCommandsService],
})
export class DeviceCommandsModule {}