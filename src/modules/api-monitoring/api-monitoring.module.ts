import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiMonitoringService } from './api-monitoring.service';
import { ApiMonitoringController } from './api-monitoring.controller';
import { APILog } from './entities/api-log.entity';
import { Tenant } from '../index.entities';

@Module({
  imports: [TypeOrmModule.forFeature([APILog, Tenant])],
  controllers: [ApiMonitoringController],
  providers: [ApiMonitoringService],
  exports: [ApiMonitoringService],
})
export class ApiMonitoringModule { }
