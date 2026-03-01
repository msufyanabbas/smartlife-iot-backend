// src/modules/audit/entities/audit-log.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant, Customer } from '@modules/index.entities';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@Entity('audit_logs')
@Index(['tenantId', 'timestamp'])
@Index(['tenantId', 'userId', 'timestamp'])
@Index(['tenantId', 'customerId', 'timestamp'])
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['tenantId', 'action', 'timestamp'])
@Index(['tenantId', 'severity', 'timestamp'])
@Index(['success'])
export class AuditLog extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // USER CONTEXT (Who performed the action?)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  userId?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ nullable: true })
  userName?: string;

  @Column({ nullable: true })
  userEmail?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION DETAILS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'enum', enum: AuditAction })
  @Index()
  action: AuditAction;

  @Column({ type: 'enum', enum: AuditEntityType })
  @Index()
  entityType: AuditEntityType;

  @Column({ nullable: true })
  @Index()
  entityId?: string;

  @Column({ nullable: true })
  entityName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // CHANGE TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // REQUEST CONTEXT
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ type: 'text', nullable: true })
  userAgent?: string;

  @Column({ nullable: true })
  requestId?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // SEVERITY & STATUS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'enum', enum: AuditSeverity, default: AuditSeverity.INFO })
  @Index()
  severity: AuditSeverity;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  timestamp: Date;

  @Column({ default: true })
  @Index()
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // ADDITIONAL CONTEXT
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isSuccess(): boolean {
    return this.success === true;
  }

  isFailed(): boolean {
    return this.success === false;
  }

  isCritical(): boolean {
    return this.severity === AuditSeverity.CRITICAL;
  }

  isError(): boolean {
    return this.severity === AuditSeverity.ERROR;
  }

  hasChanges(): boolean {
    return !!this.changes && (!!this.changes.before || !!this.changes.after);
  }
}