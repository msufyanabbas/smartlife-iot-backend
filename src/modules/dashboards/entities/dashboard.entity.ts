import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { WidgetConfig } from '@common/interfaces/index.interface'
import { DashboardVisibility } from '@common/enums/index.enum';


// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD ENTITY
// ══════════════════════════════════════════════════════════════════════════

@Entity('dashboards')
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'visibility'])
@Index(['tenantId', 'isDefault'])
export class Dashboard extends BaseEntity {
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
  // CUSTOMER SCOPING (OPTIONAL - for B2B2C)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  userId: string;  // Who created this dashboard

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  name: string;  // "Main Dashboard", "Production Overview"

  @Column({ type: 'text', nullable: true })
  description?: string;  // "Shows all production line metrics"

  @Column({ type: 'enum', enum: DashboardVisibility, default: DashboardVisibility.PRIVATE })
  @Index()
  visibility: DashboardVisibility;

  // ══════════════════════════════════════════════════════════════════════════
  // WIDGETS (Stored as JSONB array)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', default: [] })
  widgets: WidgetConfig[];
  // Example:
  // widgets: [
  //   {
  //     id: 'widget-uuid-1',
  //     widgetTypeId: 'line-chart-widget-type-id',
  //     type: 'chart',
  //     title: 'Temperature Trend',
  //     position: { x: 0, y: 0, w: 6, h: 4 },
  //     dataSource: {
  //       deviceIds: ['device-123'],
  //       telemetryKeys: ['temperature'],
  //       timeRange: '24h',
  //       useWebSocket: true
  //     },
  //     visualization: {
  //       chartType: 'line',
  //       colors: ['#3b82f6'],
  //       showLegend: true,
  //       unit: '°C',
  //       decimals: 1
  //     }
  //   },
  //   {
  //     id: 'widget-uuid-2',
  //     type: 'gauge',
  //     title: 'Current Temperature',
  //     position: { x: 6, y: 0, w: 3, h: 4 },
  //     dataSource: {
  //       deviceIds: ['device-123'],
  //       telemetryKeys: ['temperature'],
  //       aggregation: 'latest',
  //       useWebSocket: true
  //     },
  //     visualization: {
  //       unit: '°C',
  //       min: 0,
  //       max: 100,
  //       thresholds: [
  //         { value: 30, color: '#22c55e', label: 'Normal' },
  //         { value: 50, color: '#f59e0b', label: 'Warning' },
  //         { value: 70, color: '#ef4444', label: 'Critical' }
  //       ]
  //     }
  //   }
  // ]

  // ══════════════════════════════════════════════════════════════════════════
  // LAYOUT SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  layout?: {
    cols: number;                       // Number of columns (default: 12)
    rowHeight: number;                  // Height of each row in pixels (default: 100)
    compactType?: 'vertical' | 'horizontal' | null;
    margin?: [number, number];          // [x, y] margin between widgets
    containerPadding?: [number, number];
  };
  // Example:
  // layout: {
  //   cols: 12,
  //   rowHeight: 100,
  //   compactType: 'vertical',
  //   margin: [10, 10],
  //   containerPadding: [10, 10]
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    autoRefresh?: boolean;              // Auto-refresh all widgets?
    refreshInterval?: number;           // Seconds between refreshes
    theme?: 'light' | 'dark' | 'auto';
    timezone?: string;                  // 'Asia/Riyadh', 'UTC'
    dateFormat?: string;                // 'YYYY-MM-DD', 'DD/MM/YYYY'
    timeFormat?: '12h' | '24h';
  };
  // Example:
  // settings: {
  //   autoRefresh: true,
  //   refreshInterval: 30,
  //   theme: 'dark',
  //   timezone: 'Asia/Riyadh',
  //   timeFormat: '24h'
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // GLOBAL FILTERS (Applied to all widgets)
  // ══════════════════════════════════════════════════════════════════════════
 
  @Column({ type: 'jsonb', nullable: true })
  filters?: {
    dateRange?: {
      from: Date;
      to: Date;
    };
    deviceIds?: string[];               // Filter all widgets to these devices
    assetIds?: string[];
    tags?: string[];
  };
  
  // ══════════════════════════════════════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ default: false })
  @Index()
  isDefault: boolean;  // Is this the default dashboard for this user?

  @Column({ default: false })
  isFavorite: boolean;  // User marked as favorite

  // ══════════════════════════════════════════════════════════════════════════
  // SHARING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  sharedWith?: string[];  // User IDs who can view this dashboard
  // Example: ['user-uuid-1', 'user-uuid-2']

  // ══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'int', default: 0 })
  viewCount: number;  // How many times viewed

  @Column({ type: 'timestamp', nullable: true })
  lastViewedAt?: Date;  // When was it last viewed

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['production', 'monitoring', 'hvac']

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Add widget to dashboard
   */
  addWidget(widget: Omit<WidgetConfig, 'id'>): void {
    if (!this.widgets) {
      this.widgets = [];
    }
    
    const widgetWithId: WidgetConfig = {
      ...widget,
      id: this.generateWidgetId(),
    };
    
    this.widgets.push(widgetWithId);
  }

  /**
   * Remove widget from dashboard
   */
  removeWidget(widgetId: string): void {
    if (this.widgets) {
      this.widgets = this.widgets.filter((w) => w.id !== widgetId);
    }
  }

  /**
   * Update widget
   */
  updateWidget(widgetId: string, updates: Partial<WidgetConfig>): void {
    if (this.widgets) {
      const index = this.widgets.findIndex((w) => w.id === widgetId);
      if (index !== -1) {
        this.widgets[index] = { ...this.widgets[index], ...updates };
      }
    }
  }

  /**
   * Get widget by ID
   */
  getWidget(widgetId: string): WidgetConfig | undefined {
    return this.widgets?.find((w) => w.id === widgetId);
  }

  /**
   * Generate unique widget ID
   */
  private generateWidgetId(): string {
    return `widget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get all devices used in dashboard
   */
  getUsedDevices(): string[] {
    if (!this.widgets) return [];
    
    const deviceIds = new Set<string>();
    this.widgets.forEach(widget => {
      widget.dataSource.deviceIds?.forEach(id => deviceIds.add(id));
    });
    
    return Array.from(deviceIds);
  }

  /**
   * Get all assets used in dashboard
   */
  getUsedAssets(): string[] {
    if (!this.widgets) return [];
    
    const assetIds = new Set<string>();
    this.widgets.forEach(widget => {
      widget.dataSource.assetIds?.forEach(id => assetIds.add(id));
    });
    
    return Array.from(assetIds);
  }

  /**
   * Check if dashboard uses WebSocket
   */
  usesWebSocket(): boolean {
    return this.widgets?.some(w => w.dataSource.useWebSocket) ?? false;
  }
}
