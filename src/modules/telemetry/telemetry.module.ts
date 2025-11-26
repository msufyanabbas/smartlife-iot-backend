import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { Telemetry } from './entities/telemetry.entity';
import { Device } from '../devices/entities/device.entity';
import { BullModule } from '@nestjs/bull';
import { TelemetryConsumer } from './telemetry.consumer';

@Module({
  imports: [
    TypeOrmModule.forFeature([Telemetry, Device]),
    BullModule.registerQueue({
      name: 'telemetry',
      // Uses default Redis connection
    }),
  ],
  controllers: [TelemetryController],
  providers: [TelemetryService, TelemetryConsumer],
  exports: [TelemetryService],
})
export class TelemetryModule {}
