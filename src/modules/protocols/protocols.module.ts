import { DeviceAuthModule } from '@modules/device-auth/device-auth.module';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HTTPAdapter } from './adapters/http.adapter';
import { CoAPAdapter } from './adapters/coap.adapter';
import { ModbusAdapter } from './adapters/modbus.adapter';
import { BLEAdapter } from './adapters/ble.adapter';
import { ZigbeeAdapter } from './adapters/zigbee.adapter';
import { SnmpAdapter } from './adapters/snmp.adapter';
import { OpcuaAdapter } from './adapters/opcua.adapter';
import { BacnetAdapter } from './adapters/bacnet.adapter';
import { OpcuaServer } from './opcua/entities/opcua-server.entity';
import { OpcuaService } from './opcua/opcua.service';
import { OpcuaController } from './opcua/opcua.controller';
import { BacnetDevice } from './bacnet/entities/bacnet-device.entity';
import { BacnetService } from './bacnet/bacnet.service';
import { BacnetController } from './bacnet/bacnet.controller';
import { NbIotDevice } from './nbiot/entities/nbiot-device.entity';
import { NbIotService } from './nbiot/nbiot.service';
import { NbIotController } from './nbiot/nbiot.controller';
import { Integration } from '@modules/integrations/entities/integration.entity';
import { DeviceListenerService } from './device-listener.service';
import { Lwm2mService } from './lwm2m/lwm2m.service';
import { Lwm2mController } from './lwm2m/lwm2m.controller';
import { Lwm2mRegistration } from './lwm2m/entities/lwm2m-registration.entity';
import { ModbusDevice } from './modbus/entities/modbus-device.entity';
import { ModbusDevicesService } from './modbus/modbus-devices.service';
import { ModbusDevicesController } from './modbus/modbus-devices.controller';
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
    DeviceAuthModule,
    // ModbusDevice: the poller's fleet, formerly a MODBUS_DEVICES env blob.
    // Lwm2mRegistration: LwM2M registrations, formerly in-process Maps that
    // were lost on every restart.
    TypeOrmModule.forFeature([
      Device,
      DeviceProfile,
      ModbusDevice,
      Lwm2mRegistration,
      // OpcuaServer / BacnetDevice / NbIotDevice: the three industrial and
      // carrier transports' fleets. Database-driven like SnmpAdapter, so the
      // adapters read these repositories on a refresh interval rather than
      // taking their targets from env vars (which is ModbusAdapter's old,
      // deliberately-not-copied shape).
      //
      // Integration is registered here — NOT owned here — because the NB-IoT
      // carrier push authenticates against the integration row that names it.
      // A second forFeature() on the same entity is only a repository
      // registration; IntegrationsModule remains its owner.
      OpcuaServer,
      BacnetDevice,
      NbIotDevice,
      Integration,
    ]),
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
    // ModbusDevicesService → ModbusAdapter only (so a saved change reloads the
    // poller). The adapter reads its repository directly, so there is no cycle.
    ModbusDevicesService,
    BLEAdapter,
    ZigbeeAdapter,
    SnmpAdapter,
    // OpcuaAdapter — subscription-first OPC-UA. Reads `opcua_servers` rows,
    //   shares one session per endpoint, coalesces monitored-item
    //   notifications, ends at DeviceListenerService. OPCUA_ENABLED=false to
    //   switch off.
    // BacnetAdapter — BACnet/IP Who-Is discovery and ReadPropertyMultiple
    //   polling of `bacnet_devices`. OFF unless BACNET_ENABLED=true, because
    //   it binds a host UDP port (47808).
    // The services depend on their adapters (for test / browse / discover),
    // never the reverse, so there is no cycle.
    OpcuaAdapter,
    OpcuaService,
    BacnetAdapter,
    BacnetService,
    // NbIotService has no adapter: NB-IoT is a BEARER, not a wire protocol.
    // It owns the SIM records and the carrier push endpoint, and hands uplinks
    // to DeviceListenerService like every other inbound path.
    NbIotService,
  ],
  controllers: [
    HTTPAdapter, // HTTPAdapter is both a provider (IProtocolAdapter) and a controller (@Controller)
    Lwm2mController,
    ModbusDevicesController,
    OpcuaController,
    BacnetController,
    NbIotController,
  ],
  exports: [
    DeviceListenerService,
    HTTPAdapter,
    RpcCorrelatorService, // GatewayService + RpcResponseListener correlate through this
    Lwm2mService,
    SnmpAdapter,
    OpcuaAdapter,
    BacnetAdapter,
    // Exported for the eventual CoAP/MQTT canonicalisation hook
    // (`applyToTelemetry()`), which NOTHING CALLS YET — wiring it in costs a
    // nbiot_devices lookup on every CoAP and MQTT message platform-wide and
    // needs a bounded device cache first. See that method's doc block. Direct
    // CoAP and MQTT ingestion works today without it.
    NbIotService,
    MQTTModule, // re-export so GatewayModule can reach MQTTService via ProtocolsModule
  ],
})
export class ProtocolsModule {}
