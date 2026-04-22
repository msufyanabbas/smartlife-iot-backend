import { Module, Global, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MQTTService } from './mqtt.service';
import { Device } from '@modules/devices/entities/device.entity';
import { ProtocolsModule } from '@modules/protocols/protocols.module';

// MQTTService needs:
//   DeviceListenerService — unified telemetry entry point (from ProtocolsModule)
//   Device repository     — to look up deviceKey/devEUI for each incoming message
//
// forwardRef is required: ProtocolsModule imports MQTTModule (for MQTTService
// downlink) and MQTTModule imports ProtocolsModule (for DeviceListenerService).

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Device]),
    forwardRef(() => ProtocolsModule),
  ],
  providers: [MQTTService],
  exports: [MQTTService],
})
export class MQTTModule {}