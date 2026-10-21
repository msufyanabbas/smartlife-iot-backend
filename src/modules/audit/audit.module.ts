// src/modules/audit/audit.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditEventsService } from './audit-events.service';
import { AuditRetentionService } from './audit-retention.service';
import { AuditLog } from './entities/audit-log.entity';
import { Customer } from '../customers/entities/customers.entity';
import { User } from '../index.entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, Customer, User]), // ✅ Added Customer entity
  ],
  controllers: [AuditController],
  providers: [AuditService, AuditEventsService, AuditRetentionService],
  exports: [AuditService, AuditEventsService],
})
export class AuditModule {}