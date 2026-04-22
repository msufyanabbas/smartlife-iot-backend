import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HTTPAdapter } from './adapters/http.adapter';
import { CoAPAdapter } from './adapters/coap.adapter';
import { ModbusAdapter } from './adapters/modbus.adapter';
import { BLEAdapter } from './adapters/ble.adapter';
import { ZigbeeAdapter } from './adapters/zigbee.adapter';
import { DeviceListenerService } from './device-listener.service';
import { Device } from '@modules/devices/entities/device.entity';
import { CodecModule } from '@modules/devices/codecs/codec.module';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { MQTTModule } from '@/lib/mqtt/mqtt.module';

// ─── What this module owns ────────────────────────────────────────────────
// DeviceListenerService — unified entry point for all protocol adapters.
//   Called by: MQTTService (lib/mqtt), HTTPAdapter, CoAPAdapter, etc.
//   Does:      codec decode → device update → Kafka publish
//
// ─── MQTTAdapter is intentionally NOT registered here ────────────────────
// The old MQTTAdapter was a third MQTT client creating duplicate connections.
// lib/mqtt/MQTTService is the single MQTT client for the platform.
// It calls DeviceListenerService.handleTelemetry() directly for uplinks.
//
// ─── Circular dependency: MQTTModule ↔ ProtocolsModule ───────────────────
// MQTTModule imports ProtocolsModule (needs DeviceListenerService).
// ProtocolsModule imports MQTTModule (exports MQTTService for downlinks
// via HTTPAdapter / CoAPAdapter if needed, and for GatewayModule).
// forwardRef resolves this at both ends.

@Module({
  imports: [
    TypeOrmModule.forFeature([Device]),
    CodecModule,       // provides CodecRegistryService for DeviceListenerService
    KafkaModule,       // provides KafkaService for DeviceListenerService
    forwardRef(() => MQTTModule), // circular: MQTTModule also imports ProtocolsModule
  ],
  providers: [
    DeviceListenerService,
    HTTPAdapter,
    CoAPAdapter,
    ModbusAdapter,
    BLEAdapter,
    ZigbeeAdapter,
  ],
  controllers: [
    HTTPAdapter, // HTTPAdapter is both a provider (IProtocolAdapter) and a controller (@Controller)
  ],
  exports: [
    DeviceListenerService,
    HTTPAdapter,
    MQTTModule, // re-export so GatewayModule can reach MQTTService via ProtocolsModule
  ],
})
export class ProtocolsModule {}