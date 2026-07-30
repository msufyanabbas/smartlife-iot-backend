import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { Asset } from './entities/asset.entity';
import { Device } from '../devices/entities/device.entity';
import { FloorPlan } from '../floor-plans/entities/floor-plan.entity';
import { FloorPlanDevice } from '../floor-plans/entities/floor-plan-device.entity';
import { AssetProfile } from '../profiles/entities/asset-profile.entity';

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
    ]),
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
