import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('api_logs')
@Index(['userId', 'timestamp'])
@Index(['endpoint'])
@Index(['statusCode'])
export class APILog extends BaseEntity {
  @Column()
  method: string;

  @Column()
  endpoint: string;

  @Column({ name: 'status_code' })
  statusCode: number;

  @Column({ name: 'response_time', type: 'integer' })
  responseTime: number; // in milliseconds

  @Column({ name: 'user_id', nullable: true })
  @Index()
  userId?: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;

  @Column()
  ip: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  @Column({ type: 'jsonb', nullable: true })
  request?: {
    headers?: Record<string, string>;
    query?: Record<string, any>;
    body?: any;
  };

  @Column({ type: 'jsonb', nullable: true })
  response?: {
    statusCode: number;
    body?: any;
  };

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;
}
