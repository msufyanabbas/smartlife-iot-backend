import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum EdgeStatus {
  ONLINE = 'online',
  OFFLINE = 'offline',
  SYNCING = 'syncing',
  ERROR = 'error',
}

@Entity('edge_instances')
@Index(['userId', 'status'])
export class EdgeInstance extends BaseEntity {
  @Column()
  name: string;

  @Column()
  location: string;

  @Column({ type: 'enum', enum: EdgeStatus, default: EdgeStatus.OFFLINE })
  status: EdgeStatus;

  @Column()
  version: string;

  @Column({ name: 'ip_address' })
  ipAddress: string;

  @Column({ name: 'last_seen', type: 'timestamp', nullable: true })
  lastSeen?: Date;

  @Column({ default: 0 })
  devices: number;

  @Column({ type: 'jsonb' })
  metrics: {
    cpu: number;
    memory: number;
    storage: number;
    uptime: string;
  };

  @Column({ type: 'jsonb', name: 'data_sync' })
  dataSync: {
    pending: number;
    lastSync?: Date;
  };

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId?: string;
}
