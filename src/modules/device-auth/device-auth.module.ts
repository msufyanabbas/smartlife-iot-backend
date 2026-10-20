import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Device } from '@modules/devices/entities/device.entity';
import { DeviceCredentials } from '@modules/devices/entities/device-credentials.entity';

import { DeviceAuthService } from './device-auth.service';
import { DeviceAuthController } from './device-auth.controller';

/**
 * Deliberately depends on NO other feature module.
 *
 * `DevicesModule` imports `ProtocolsModule`, so the protocol adapters — the
 * things that most need to authenticate a device — cannot import
 * `DevicesModule` back. Registering the two repositories directly keeps this
 * module importable from anywhere, which is the same reasoning
 * `FloorPlansModule` uses for its Subscription repository (CLAUDE.md §4a).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Device, DeviceCredentials])],
  controllers: [DeviceAuthController],
  providers: [DeviceAuthService],
  exports: [DeviceAuthService],
})
export class DeviceAuthModule {}
