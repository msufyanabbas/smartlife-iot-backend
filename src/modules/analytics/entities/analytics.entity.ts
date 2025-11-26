import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum AnalyticsType {
  DEVICE_USAGE = 'device_usage',
  TELEMETRY_STATS = 'telemetry_stats',
  ALARM_FREQUENCY = 'alarm_frequency',
  USER_ACTIVITY = 'user_activity',
  SYSTEM_PERFORMANCE = 'system_performance',
}

export enum AnalyticsPeriod {
  HOURLY = 'hourly',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
}

@Entity('analytics')
@Index(['type', 'period', 'timestamp'])
@Index(['entityId', 'timestamp'])
export class Analytics extends BaseEntity {
  @Column({
    type: 'enum',
    enum: AnalyticsType,
  })
  @Index()
  type: AnalyticsType;

  @Column({
    type: 'enum',
    enum: AnalyticsPeriod,
  })
  period: AnalyticsPeriod;

  @Column({ nullable: true })
  @Index()
  entityId?: string; // Device ID, User ID, etc.

  @Column({ nullable: true })
  entityType?: string; // 'device', 'user', 'alarm', etc.

  @Column({ type: 'jsonb' })
  metrics: Record<string, any>;

  @Column({ type: 'timestamp' })
  @Index()
  timestamp: Date;

  @Column({ nullable: true })
  tenantId?: string;
}
