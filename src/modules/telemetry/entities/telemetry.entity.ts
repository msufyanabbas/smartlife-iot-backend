import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Device } from '../../devices/entities/device.entity';

@Entity('telemetry')
@Index(['deviceId', 'timestamp'])
@Index(['deviceKey', 'timestamp'])
@Index(['timestamp'])
export class Telemetry extends BaseEntity {
  @Column()
  deviceId: string;

  @ManyToOne(() => Device)
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column()
  deviceKey: string;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  // Telemetry data stored as JSONB for flexibility
  @Column({ type: 'jsonb' })
  data: Record<string, any>;

  // Common telemetry fields (optional, can also be in data)
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  temperature?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  humidity?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  pressure?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  longitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  batteryLevel?: number;

  @Column({ type: 'int', nullable: true })
  signalStrength?: number;

  // Metadata
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  @Column({ nullable: true })
  tenantId?: string;
}
