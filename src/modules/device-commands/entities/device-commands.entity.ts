// src/modules/device-commands/entities/device-command.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Device, User, Tenant } from '@modules/index.entities';

@Entity('device_commands')
@Index(['deviceId', 'status'])
@Index(['userId', 'createdAt'])
@Index(['tenantId', 'status'])
@Index(['scheduledFor'])
export class DeviceCommand {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
  // RELATIONSHIPS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // COMMAND DETAILS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  commandType: string;  // 'turnOn', 'turnOff', 'setBrightness', 'setColor'

  @Column({ type: 'jsonb', default: {} })
  params: Record<string, any>;

  @Column({ type: 'enum', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], default: 'NORMAL' })
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({
    type: 'enum',
    enum: ['PENDING', 'QUEUED', 'SENDING', 'DELIVERED', 'COMPLETED', 'FAILED', 'RETRYING', 'SCHEDULED', 'CANCELLED'],
    default: 'PENDING',
  })
  @Index()
  status: 'PENDING' | 'QUEUED' | 'SENDING' | 'DELIVERED' | 'COMPLETED' | 'FAILED' | 'RETRYING' | 'SCHEDULED' | 'CANCELLED';

  @Column({ type: 'text', nullable: true })
  statusMessage?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'int', default: 30000 })
  timeout: number;  // milliseconds

  @Column({ type: 'int', default: 3 })
  retries: number;

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'timestamp', nullable: true })
  @Index()
  scheduledFor?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // TIMESTAMPS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'timestamp', nullable: true })
  deliveredAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt?: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  isPending(): boolean {
    return ['PENDING', 'QUEUED', 'SENDING', 'RETRYING'].includes(this.status);
  }

  isCompleted(): boolean {
    return ['COMPLETED', 'DELIVERED', 'FAILED', 'CANCELLED'].includes(this.status);
  }

  canCancel(): boolean {
    return ['PENDING', 'QUEUED', 'SCHEDULED'].includes(this.status);
  }

  canRetry(): boolean {
    return this.status === 'FAILED' && this.retries > 0;
  }
}