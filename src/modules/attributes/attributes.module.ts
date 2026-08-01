import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttributesService } from './attributes.service';
import { AttributesController } from './attributes.controller';
import { Attribute } from './entities/attribute.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Asset } from '@modules/assets/entities/asset.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';

// Telemetry is registered as a repository rather than by importing
// TelemetryModule: TelemetryModule pulls in ProfilesModule (which depends on
// the Asset repository) and ProtocolsModule imports AttributesModule, so the
// module-level import would close a cycle. Read-only access is all
// getTimeseries() needs.
//
// MQTTService (shared-attribute push) needs no import — MQTTModule is @Global.
@Module({
  imports: [TypeOrmModule.forFeature([Attribute, Device, Asset, Telemetry])],
  controllers: [AttributesController],
  providers: [AttributesService],
  exports: [AttributesService],
})
export class AttributesModule { }
