import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Firmware } from './entities/firmware.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { FirmwareService } from './firmware.service';
import { FirmwareController } from './firmware.controller';
import { OtaController } from './ota.controller';
import { FirmwareConsumer } from './firmware.consumer';
import { KafkaModule } from '@/lib/kafka/kafka.module';

// NOTE (deviation from the task's BUILD 7 instructions):
//   The task said to import DevicesModule and ProtocolsModule. Doing so creates
//   a dependency cycle (DevicesModule → ProtocolsModule, and ProtocolsModule
//   imports FirmwareModule for the CoAP OTA route). Instead:
//     - Device access uses the Device repository directly via forFeature.
//     - MQTTService is injected from the @Global() MQTTModule (no import needed).
//   This keeps FirmwareModule free of cycles.
@Module({
  imports: [
    TypeOrmModule.forFeature([Firmware, Device]),
    KafkaModule, // KafkaService for the producer + FirmwareConsumer
  ],
  controllers: [FirmwareController, OtaController],
  providers: [FirmwareService, FirmwareConsumer],
  exports: [FirmwareService],
})
export class FirmwareModule {}
