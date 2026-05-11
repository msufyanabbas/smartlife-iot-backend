// src/modules/analytics/entities/dashboard-view-log.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';

@Entity('dashboard_view_logs')
@Index(['dashboardId', 'viewedAt'])
@Index(['tenantId', 'viewedAt'])
export class DashboardViewLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  dashboardId: string;

  @ManyToOne(() => Dashboard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dashboardId' })
  dashboard: Dashboard;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  userId?: string;

  @Column({ nullable: true })
  widgetId?: string;

  @Column({ type: 'int', default: 0 })
  loadTimeMs: number;

  @CreateDateColumn()
  viewedAt: Date;

  @Column({ default: false })
  errorOccurred: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;
}