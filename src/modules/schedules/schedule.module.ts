// src/modules/schedules/schedule.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SchedulesService } from './schedule.service';
import { SchedulesController } from './schedule.controller';
import { Schedule } from './entities/schedule.entity';
import { ScheduleExecutionLog } from './entities/schedule-execution-log.entity';
import { ScheduleExecutorService } from './schedule-executor.service';
import { ScheduleCronService } from './schedule-cron.service';

@Module({
  imports: [
    // Register both entities with TypeORM
    TypeOrmModule.forFeature([Schedule, ScheduleExecutionLog]),

    // NestJS cron scheduler (needed by ScheduleCronService)
    ScheduleModule.forRoot(),

    // Event emitter (needed by ScheduleExecutorService)
    // Use .forRoot() here only if it hasn't been registered at the app level.
    // If EventEmitterModule.forRoot() is already in AppModule, remove this line.
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: 20,
      verboseMemoryLeak: true,
      ignoreErrors: false,
    }),
  ],
  controllers: [SchedulesController],
  providers: [
    SchedulesService,
    ScheduleExecutorService,
    ScheduleCronService,
  ],
  exports: [SchedulesService, ScheduleExecutorService],
})
export class SchedulesModule {}