import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { RpcResponseListener } from './rpc-response.listener';
import { DevicesModule } from '../devices/devices.module';
import { ProtocolsModule } from '../protocols/protocols.module';
import { DeviceCommandsModule } from '../device-commands/device-commands.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { CodecModule } from '@modules/devices/codecs/codec.module';
import mqttConfig from '../../config/mqtt.config';

// ─── What GatewayModule does NOT own ─────────────────────────────────────
// - DeviceListenerService: owned by ProtocolsModule, not re-declared here
// - MQTTService: owned by MQTTModule (global), re-exported via ProtocolsModule
// - Telemetry entity: owned by TelemetryModule
// - RpcCorrelatorService: owned by ProtocolsModule (CoAPAdapter resolves into
//   the same pending map, and ProtocolsModule sits below this one)
//
// GatewayService needs:
//   MQTTService          → publish downlink commands  (from MQTTModule, global)
//   DevicesService       → device lookup / findByDeviceKey (from DevicesModule)
//   CodecRegistryService → encode commands for LoRaWAN (from CodecModule)
//   RpcCorrelatorService → correlate two-way RPC       (from ProtocolsModule)
//   DeviceCommandsService → persist the RPC outcome    (from DeviceCommandsModule)
//
// ─── Circular dependency: GatewayModule ↔ DeviceCommandsModule ───────────
// DeviceCommandsModule imports GatewayModule (DeviceCommandsConsumer sends
// commands through GatewayService). GatewayModule now imports
// DeviceCommandsModule so an RPC's outcome lands in the command history
// instead of being lost. forwardRef at both ends resolves it, and
// GatewayService injects DeviceCommandsService with
// @Inject(forwardRef(() => DeviceCommandsService)).
//
// RpcResponseListener is declared here (not in ProtocolsModule) because the
// `devices/{deviceKey}/rpc/*` topics are this module's contract with devices.
// It is a second, subscribe-only MQTT client on one topic pattern — see the
// header of rpc-response.listener.ts for why it cannot be folded into
// lib/mqtt/MQTTService.

@Module({
  imports: [
    ConfigModule.forFeature(mqttConfig),
    DevicesModule,
    ProtocolsModule,  // exports DeviceListenerService, RpcCorrelatorService + re-exports MQTTModule
    forwardRef(() => DeviceCommandsModule), // circular: it imports GatewayModule
    CodecModule,      // exports CodecRegistryService
    WebsocketModule,
  ],
  controllers: [GatewayController],
  providers: [GatewayService, RpcResponseListener],
  exports: [GatewayService, RpcResponseListener],
})
export class GatewayModule {}
