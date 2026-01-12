// src/common/decorators/audit.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { AuditAction, AuditEntityType, AuditSeverity } from '../../modules/audit/entities/audit-log.entity';

export interface AuditMetadata {
  action: AuditAction;
  entityType: AuditEntityType;
  severity?: AuditSeverity;
  description?: string;
}

export const AUDIT_KEY = 'audit';
export const Audit = (metadata: AuditMetadata) => SetMetadata(AUDIT_KEY, metadata);