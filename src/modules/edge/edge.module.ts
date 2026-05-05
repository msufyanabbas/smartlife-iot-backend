// src/modules/edge/edge.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EdgeService } from './edge.service';
import { EdgeController } from './edge.controller';
import { EdgeInstance } from './entities/edge-instance.entity';
import { EdgeMetricsSnapshot } from './entities/edge-metrics-snapshot.entity';
import { EdgeCommand } from './entities/edge-command.entity';
import { Device } from '@modules/devices/entities/device.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EdgeInstance,
      EdgeMetricsSnapshot,
      EdgeCommand,
      Device,
    ]),

    // Required for @Cron decorator in EdgeService
    ScheduleModule.forRoot(),

    // Required for EventEmitter2 in EdgeService.
    // Remove if already registered in AppModule.
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),
  ],
  controllers: [EdgeController],
  providers: [EdgeService],
  exports: [EdgeService],
})
export class EdgeModule {}