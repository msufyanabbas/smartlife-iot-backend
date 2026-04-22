import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { DevicesModule } from '../devices/devices.module';
import { ProtocolsModule } from '../protocols/protocols.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { CodecModule } from '@modules/devices/codecs/codec.module';
import mqttConfig from '../../config/mqtt.config';

// ─── What GatewayModule does NOT own ─────────────────────────────────────
// - DeviceListenerService: owned by ProtocolsModule, not re-declared here
// - MQTTService: owned by MQTTModule (global), re-exported via ProtocolsModule
// - Telemetry entity: owned by TelemetryModule
//
// GatewayService only needs:
//   MQTTService         → publish downlink commands  (from MQTTModule, global)
//   DevicesService      → device lookup / findByDeviceKey (from DevicesModule)
//   CodecRegistryService → encode commands for LoRaWAN (from CodecModule)

@Module({
  imports: [
    ConfigModule.forFeature(mqttConfig),
    DevicesModule,
    ProtocolsModule,  // exports DeviceListenerService + re-exports MQTTModule
    CodecModule,      // exports CodecRegistryService
    WebsocketModule,
  ],
  controllers: [GatewayController],
  providers: [GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}