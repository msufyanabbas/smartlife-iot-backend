// src/modules/protocols/protocols.module.ts
// Module that manages ALL protocol adapters

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MQTTAdapter } from './adapters/mqtt.adapter';
import { HTTPAdapter } from './adapters/http.adapter';
import { GatewayModule } from '../gateway/gateway.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { Device } from '../devices/entities/device.entity';
import { DeviceCredentials } from '../index.entities';
import { CoAPAdapter } from './adapters/coap.adapter';
import { ModbusAdapter } from './adapters/modbus.adapter';
import { BLEAdapter } from './adapters/ble.adapter';

@Module({
  imports: [
    TypeOrmModule.forFeature([Device, DeviceCredentials]),
    GatewayModule, // Provides DeviceListenerService
    TelemetryModule, // Provides TelemetryService
  ],
  providers: [
    MQTTAdapter,
    CoAPAdapter,
    ModbusAdapter,
    BLEAdapter,
    HTTPAdapter,
    // WebSocketAdapter,
  ],
  controllers: [
    HTTPAdapter, // HTTP adapter is also a controller (REST endpoints)
  ],
  exports: [MQTTAdapter, CoAPAdapter, BLEAdapter, HTTPAdapter, ModbusAdapter],
})
export class ProtocolsModule {}
