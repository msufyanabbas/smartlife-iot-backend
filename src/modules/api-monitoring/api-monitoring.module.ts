import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiMonitoringService } from './api-monitoring.service';
import { ApiMonitoringController } from './api-monitoring.controller';
import { APILog } from './entities/api-log.entity';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';

@Module({
  // Repositories only — no sibling feature module is imported, so this module
  // cannot participate in a dependency cycle. Subscription is read directly for
  // the dashboard's API-call quota. RedisModule/KafkaModule are @Global(), so
  // the health probes need no import.
  imports: [TypeOrmModule.forFeature([APILog, Subscription])],
  controllers: [ApiMonitoringController],
  providers: [ApiMonitoringService],
  exports: [ApiMonitoringService],
})
export class ApiMonitoringModule { }
