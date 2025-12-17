import { Entity, Column, ManyToOne, JoinColumn, OneToMany, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { User } from '../../users/entities/user.entity';

export enum DashboardVisibility {
  PRIVATE = 'private',
  SHARED = 'shared',
  PUBLIC = 'public',
}

export interface WidgetConfig {
  id: string;
  type: 'chart' | 'gauge' | 'map' | 'table' | 'stat' | 'timeseries' | 'heatmap';
  title: string;
  position: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  dataSource: {
    deviceIds?: string[];
    telemetryKeys?: string[];
    aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count';
    timeRange?: string; // '1h', '24h', '7d', '30d', 'custom'
    refreshInterval?: number; // seconds
  };
  visualization: {
    chartType?: 'line' | 'bar' | 'pie' | 'doughnut' | 'area';
    colors?: string[];
    showLegend?: boolean;
    showGrid?: boolean;
    unit?: string;
    decimals?: number;
    thresholds?: Array<{
      value: number;
      color: string;
      label?: string;
    }>;
  };
  filters?: Record<string, any>;
}

@Entity('dashboards')
export class Dashboard extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: DashboardVisibility,
    default: DashboardVisibility.PRIVATE,
  })
  visibility: DashboardVisibility;

  @Column()
  userId: string;

  @Column({ nullable: true })
  @Index()
  customerId?: string;
  
  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'jsonb', default: [] })
  widgets: WidgetConfig[];

  @Column({ type: 'jsonb', nullable: true })
  layout?: {
    cols: number;
    rowHeight: number;
    compactType?: 'vertical' | 'horizontal';
  };

  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    autoRefresh?: boolean;
    refreshInterval?: number; // seconds
    theme?: 'light' | 'dark' | 'auto';
    timezone?: string;
  };

  @Column({ type: 'jsonb', nullable: true })
  filters?: {
    dateRange?: {
      from: Date;
      to: Date;
    };
    deviceIds?: string[];
    tags?: string[];
  };

  @Column({ default: false })
  isDefault: boolean;

  @Column({ default: false })
  isPublic: boolean; 

  @Column({ default: false })
  isFavorite: boolean;

  @Column({ type: 'jsonb', nullable: true })
  sharedWith?: string[]; // User IDs

  @Column({ type: 'int', default: 0 })
  viewCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastViewedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  // Helper method to add widget
  addWidget(widget: WidgetConfig): void {
    if (!this.widgets) {
      this.widgets = [];
    }
    this.widgets.push(widget);
  }

  // Helper method to remove widget
  removeWidget(widgetId: string): void {
    if (this.widgets) {
      this.widgets = this.widgets.filter((w) => w.id !== widgetId);
    }
  }

  // Helper method to update widget
  updateWidget(widgetId: string, updates: Partial<WidgetConfig>): void {
    if (this.widgets) {
      const index = this.widgets.findIndex((w) => w.id === widgetId);
      if (index !== -1) {
        this.widgets[index] = { ...this.widgets[index], ...updates };
      }
    }
  }
}
