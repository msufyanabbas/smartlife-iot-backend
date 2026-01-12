// src/modules/gateway/gateway.module.ts
// UPDATED - Now imports DevicesModule for credential verification

import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GatewayService } from './gateway.service';
import { GatewayController } from './gateway.controller';
import { DeviceListenerService } from './device-listener.service';
import { Device } from '../devices/entities/device.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { WebsocketModule } from '../websocket/websocket.module';
import { DevicesModule } from '../devices/devices.module';
import mqttConfig from '../../config/mqtt.config';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [
    ConfigModule.forFeature(mqttConfig),
    TypeOrmModule.forFeature([Device, Telemetry]),
    WebsocketModule,
    JwtModule,
    forwardRef(() => TelemetryModule),
    forwardRef(() => DevicesModule), // 🆕 Import DevicesModule for credential verification
  ],
  controllers: [GatewayController],
  providers: [GatewayService, DeviceListenerService],
  exports: [GatewayService, DeviceListenerService],
})
export class GatewayModule {}