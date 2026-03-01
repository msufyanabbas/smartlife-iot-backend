// src/modules/protocols/protocols.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MQTTAdapter } from './adapters/mqtt.adapter';
import { HTTPAdapter } from './adapters/http.adapter';
import { CoAPAdapter } from './adapters/coap.adapter';
import { ModbusAdapter } from './adapters/modbus.adapter';
import { BLEAdapter } from './adapters/ble.adapter';
import { ZigbeeAdapter } from './adapters/zigbee.adapter';
import { DeviceListenerService } from './device-listener.service';  // ← MOVED HERE
import { Device, DeviceCredentials } from '@modules/index.entities';
import { DevicesModule } from '@modules/devices/devices.module';  // For codec registry
import { KafkaModule } from '@/lib/kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceCredentials]),
    DevicesModule,  // Provides CodecRegistryService
    KafkaModule,    // Provides KafkaService
  ],
  providers: [
    DeviceListenerService,  // ← Core processor
    MQTTAdapter,
    HTTPAdapter,
    CoAPAdapter,
    ModbusAdapter,
    BLEAdapter,
    ZigbeeAdapter,
  ],
  controllers: [
    HTTPAdapter,  // HTTP adapter has REST endpoints
  ],
  exports: [
    DeviceListenerService,  // Other modules can inject this
    MQTTAdapter,
    HTTPAdapter,
  ],
})
export class ProtocolsModule {}