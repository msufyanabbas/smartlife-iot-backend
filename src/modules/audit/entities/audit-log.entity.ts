// src/modules/audit/entities/audit-log.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { User, Tenant } from '@modules/index.entities';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';
@Entity('audit_logs')
@Index(['tenantId', 'timestamp'])
@Index(['userId', 'timestamp'])
@Index(['entityType', 'entityId'])
@Index(['action', 'timestamp'])
@Index(['severity', 'timestamp'])
export class AuditLog extends BaseEntity {
  // User who performed the action
  @Column({ nullable: true })
  @Index()
  userId?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true })
  userName?: string;

  @Column({ nullable: true })
  userEmail?: string;

  // Tenant context
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, { nullable:                     false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // Customer context (optional - for customer-level isolation)
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  // Action details
  @Column({
    type: 'enum',
    enum: AuditAction,
  })
  @Index()
  action: AuditAction;

  @Column({
    type: 'enum',
    enum: AuditEntityType,
  })
  @Index()
  entityType: AuditEntityType;

  @Column({ nullable: true })
  @Index()
  entityId?: string;

  @Column({ nullable: true })
  entityName?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // Change tracking
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };

  // Request context
  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({ nullable: true })
  requestId?: string;

  // Severity and status
  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  @Index()
  severity: AuditSeverity;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  timestamp: Date;

  @Column({ default: true })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  // Additional context
  @Column({ type: 'jsonb', nullable: true })
  tags?: string[]; // For filtering/categorization
}