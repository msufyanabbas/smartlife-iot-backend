import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HTTPAdapter } from './adapters/http.adapter';
import { CoAPAdapter } from './adapters/coap.adapter';
import { ModbusAdapter } from './adapters/modbus.adapter';
import { BLEAdapter } from './adapters/ble.adapter';
import { ZigbeeAdapter } from './adapters/zigbee.adapter';
import { SnmpAdapter } from './adapters/snmp.adapter';
import { DeviceListenerService } from './device-listener.service';
import { Lwm2mService } from './lwm2m/lwm2m.service';
import { Lwm2mController } from './lwm2m/lwm2m.controller';
import { RpcCorrelatorService } from './rpc-correlator.service';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceProfile } from '@modules/profiles/entities/device-profile.entity';
import { CodecModule } from '@modules/devices/codecs/codec.module';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { MQTTModule } from '@/lib/mqtt/mqtt.module';
import { AttributesModule } from '@modules/attributes/attributes.module';
import { FirmwareModule } from '@modules/firmware/firmware.module';

// ─── What this module owns ────────────────────────────────────────────────
// DeviceListenerService — unified entry point for all protocol adapters.
//   Called by: MQTTService (lib/mqtt), HTTPAdapter, CoAPAdapter, SnmpAdapter,
//              Lwm2mService.
//   Does:      codec decode → device update → Kafka publish
//
// SnmpAdapter — the only POLLING transport. It reads DeviceProfile rows with
//   transportType=SNMP (hence TypeOrmModule.forFeature([DeviceProfile])) and
//   hands readings to DeviceListenerService like every other adapter.
//   Disable with SNMP_ENABLED=false.
//
// Lwm2mService — LwM2M registration (/rd) and client-initiated reporting (/dp)
//   on CoAPAdapter's existing UDP 5683 socket. Observe/Notify, server-initiated
//   Read/Write/Execute, Bootstrap and DTLS are NOT implemented; Lwm2mController
//   serves that scope list at GET /lwm2m/capabilities so the frontend can say
//   so too.
//
// RpcCorrelatorService — the pending-request table for two-way RPC. It lives
//   here, not in GatewayModule, because both the MQTT path (GatewayService +
//   RpcResponseListener) and the CoAP path (CoAPAdapter's /rpc route) resolve
//   into it. GatewayModule imports ProtocolsModule, so this direction has no
//   cycle.
//
// ─── MQTTAdapter is intentionally NOT registered here ────────────────────
// The old MQTTAdapter was a third MQTT client creating duplicate connections.
// lib/mqtt/MQTTService is the single MQTT client for device uplinks.
// It calls DeviceListenerService.handleTelemetry() directly for uplinks.
//
// ─── Circular dependency: MQTTModule ↔ ProtocolsModule ───────────────────
// MQTTModule imports ProtocolsModule (needs DeviceListenerService).
// ProtocolsModule imports MQTTModule (exports MQTTService for downlinks
// via HTTPAdapter / CoAPAdapter if needed, and for GatewayModule).
// forwardRef resolves this at both ends.

@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceProfile]),
    CodecModule, // provides CodecRegistryService for DeviceListenerService
    KafkaModule, // provides KafkaService for DeviceListenerService
    AttributesModule, // provides AttributesService for CoAPAdapter (get/set attributes)
    FirmwareModule, // provides FirmwareService for CoAPAdapter (OTA check/status)
    forwardRef(() => MQTTModule), // circular: MQTTModule also imports ProtocolsModule
  ],
  providers: [
    DeviceListenerService,
    RpcCorrelatorService,
    Lwm2mService,
    HTTPAdapter,
    CoAPAdapter,
    ModbusAdapter,
    BLEAdapter,
    ZigbeeAdapter,
    SnmpAdapter,
  ],
  controllers: [
    HTTPAdapter, // HTTPAdapter is both a provider (IProtocolAdapter) and a controller (@Controller)
    Lwm2mController,
  ],
  exports: [
    DeviceListenerService,
    HTTPAdapter,
    RpcCorrelatorService, // GatewayService + RpcResponseListener correlate through this
    Lwm2mService,
    SnmpAdapter,
    MQTTModule, // re-export so GatewayModule can reach MQTTService via ProtocolsModule
  ],
})
export class ProtocolsModule {}
