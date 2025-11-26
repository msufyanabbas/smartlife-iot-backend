// src/modules/device-commands/device-commands.entity.ts
// FIXED - With proper User foreign key relationship

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { User } from '@modules/users/entities/user.entity';

@Entity('device_command')
export class DeviceCommand {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ============================================
  // Device Relationship (Foreign Key)
  // ============================================
  @Column()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  // ============================================
  // User Relationship (Foreign Key) - FIXED!
  // ============================================
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  // ============================================
  // Tenant (for multi-tenancy)
  // ============================================
  @Column()
  tenantId: string;

  // ============================================
  // Command Details
  // ============================================
  @Column()
  commandType: string; // 'turnOn', 'turnOff', 'setBrightness', 'setColor', etc.

  @Column('jsonb', { default: {} })
  params: Record<string, any>; // Command parameters (e.g., {brightness: 80, color: '#FF0000'})

  @Column({ default: 'NORMAL' })
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  // ============================================
  // Status Tracking
  // ============================================
  @Column({ default: 'PENDING' })
  status:
    | 'PENDING' // Just created, waiting to be sent
    | 'QUEUED' // Device offline, queued for later
    | 'SENDING' // Being sent to device
    | 'DELIVERED' // Sent to device successfully
    | 'COMPLETED' // Device acknowledged completion
    | 'FAILED' // Failed to send or execute
    | 'RETRYING' // Retrying after failure
    | 'SCHEDULED' // Scheduled for future execution
    | 'CANCELLED'; // Cancelled by user

  @Column({ type: 'text', nullable: true })
  statusMessage: string; // Additional status information

  // ============================================
  // Execution Settings
  // ============================================
  @Column({ type: 'int', default: 30000 })
  timeout: number; // Timeout in milliseconds (30 seconds default)

  @Column({ type: 'int', default: 3 })
  retries: number; // Number of retry attempts remaining

  // ============================================
  // Scheduling
  // ============================================
  @Column({ type: 'timestamp', nullable: true })
  scheduledFor: Date; // Execute command at this time (optional)

  // ============================================
  // Timestamps
  // ============================================
  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date; // When command was delivered to device

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date; // When device acknowledged completion

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // ============================================
  // Metadata (optional)
  // ============================================
  @Column('jsonb', { default: {}, nullable: true })
  metadata: Record<string, any>; // Additional metadata (response from device, etc.)
}
