import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FloorPlansService } from './floor-plans.service';
import { FloorPlansController } from './floor-plans.controller';
import { FloorPlan } from './entities/floor-plan.entity';
import { FloorPlanDevice } from './entities/floor-plan-device.entity';
import { Asset } from '../assets/entities/asset.entity';
import { Device } from '../devices/entities/device.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { DWGParserService } from './dwg-parser.service';

/**
 * Repositories are registered directly rather than importing TelemetryModule /
 * AlarmsModule / AssetsModule.
 *
 * Two reasons:
 *  1. TelemetryService.getLatest(deviceId, userId) is scoped by userId — the exact
 *     bug this module is being fixed for. Going through it would reintroduce the
 *     wrong scoping; the enrichment queries scope by tenantId instead.
 *  2. AlarmsModule pulls in a Kafka consumer and a websocket gateway; importing it
 *     just to count rows creates an avoidable dependency cycle.
 *
 * Enrichment needs read-only access to 4 tables, which forFeature provides with
 * correct tenant scoping and no cycles.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      FloorPlan,
      FloorPlanDevice,
      Asset,
      Device,
      Telemetry,
      Alarm,
    ]),
  ],
  controllers: [FloorPlansController],
  providers: [FloorPlansService, DWGParserService],
  exports: [FloorPlansService],
})
export class FloorPlansModule {}
