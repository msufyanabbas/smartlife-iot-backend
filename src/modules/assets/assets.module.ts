import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { Asset } from './entities/asset.entity';
import { Device } from '../devices/entities/device.entity';
import { FloorPlan } from '../floor-plans/entities/floor-plan.entity';
import { FloorPlanDevice } from '../floor-plans/entities/floor-plan-device.entity';
import { AssetProfile } from '../profiles/entities/asset-profile.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';

// FloorPlan repositories are registered directly (not via FloorPlansModule):
// GET /assets/:id/floors only needs read access to two tables, and importing
// FloorPlansModule — which itself depends on the Asset repository — would create
// a module cycle.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Asset,
      Device,
      FloorPlan,
      FloorPlanDevice,
      // Read-only: schema validation + deviceLinkingConfig enforcement.
      AssetProfile,
      // Read-only, for the asset roll-ups (GET /assets/:id/telemetry and
      // /alarms). Registered as repositories rather than by importing
      // TelemetryModule / AlarmsModule: TelemetryModule already pulls in
      // AlarmsModule and ProfilesModule, and ProfilesModule depends on the
      // Asset repository — importing either here would close that loop into a
      // module cycle. Same reasoning as the FloorPlan registration above.
      Telemetry,
      Alarm,
    ]),
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
