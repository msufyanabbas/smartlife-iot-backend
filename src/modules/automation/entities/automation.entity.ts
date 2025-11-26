import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum TriggerType {
  THRESHOLD = 'threshold',
  STATE = 'state',
  SCHEDULE = 'schedule',
  EVENT = 'event',
}

export enum ActionType {
  CONTROL = 'control',
  SET_VALUE = 'setValue',
  NOTIFICATION = 'notification',
  WEBHOOK = 'webhook',
}

export enum AutomationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

@Entity('automations')
@Index(['userId', 'enabled'])
@Index(['userId', 'status'])
export class Automation extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb' })
  trigger: {
    type: TriggerType;
    device?: string;
    attribute?: string;
    operator?: string;
    value?: any;
    schedule?: string;
  };

  @Column({ type: 'jsonb' })
  action: {
    type: ActionType;
    target: string;
    command: string;
    value?: any;
    message?: string;
    url?: string;
  };

  @Column({ name: 'execution_count', default: 0 })
  executionCount: number;

  @Column({ name: 'last_triggered', type: 'timestamp', nullable: true })
  lastTriggered?: Date;

  @Column({
    type: 'enum',
    enum: AutomationStatus,
    default: AutomationStatus.INACTIVE,
  })
  status: AutomationStatus;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
