import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum IntegrationType {
  CLOUD = 'cloud',
  WEBHOOK = 'webhook',
  MQTT = 'mqtt',
  NOTIFICATION = 'notification',
}

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

@Entity('integrations')
@Index(['userId', 'status'])
// @Index(['tenantId'])
export class Integration extends BaseEntity {
  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: IntegrationType,
  })
  type: IntegrationType;

  @Column()
  protocol: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: IntegrationStatus,
    default: IntegrationStatus.INACTIVE,
  })
  status: IntegrationStatus;

  @Column({ default: true })
  enabled: boolean;

  @Column({ type: 'jsonb' })
  configuration: {
    url?: string;
    port?: number;
    username?: string;
    password?: string;
    apiKey?: string;
    topic?: string;
    headers?: Record<string, string>;
    method?: string;
  };

  @Column({ name: 'messages_processed', default: 0 })
  messagesProcessed: number;

  @Column({ name: 'last_activity', type: 'timestamp', nullable: true })
  lastActivity?: Date;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
