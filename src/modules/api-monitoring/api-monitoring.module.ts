import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiMonitoringService } from './api-monitoring.service';
import { ApiMonitoringController } from './api-monitoring.controller';
import { APILog } from './entities/api-log.entity';

@Module({
  imports: [TypeOrmModule.forFeature([APILog])],
  controllers: [ApiMonitoringController],
  providers: [ApiMonitoringService],
  exports: [ApiMonitoringService],
})
export class ApiMonitoringModule {}
