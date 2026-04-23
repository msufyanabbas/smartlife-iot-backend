import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { WidgetConfig } from '@common/interfaces/index.interface';
import { DashboardVisibility } from '@common/enums/index.enum';

@Entity('dashboards')
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'customerId'])
@Index(['tenantId', 'visibility'])
@Index(['tenantId', 'isDefault'])
export class Dashboard extends BaseEntity {
  // ── Tenant scoping ────────────────────────────────────────────────────────

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ── Customer scoping (optional) ───────────────────────────────────────────

  @Column({ nullable: true })
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ── Ownership ─────────────────────────────────────────────────────────────

  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ── Basic info ────────────────────────────────────────────────────────────

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: DashboardVisibility, default: DashboardVisibility.PRIVATE })
  visibility: DashboardVisibility;

  // ── Widgets (JSONB array of widget instances) ─────────────────────────────
  // Each entry is a WidgetConfig — a fully self-contained widget instance with:
  //   id            — unique widget instance ID (uuid)
  //   widgetTypeId  — references a WidgetType template
  //   type          — 'chart' | 'gauge' | 'map' | 'table' | 'stat' | ...
  //   title         — display title
  //   position      — { x, y, w, h } grid position
  //   dataSource    — { deviceIds, telemetryKeys, timeRange, useWebSocket }
  //   visualization — chart/gauge/table-specific display config

  @Column({ type: 'jsonb', default: [] })
  widgets: WidgetConfig[];

  // ── Layout settings ───────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  layout?: {
    cols: number;
    rowHeight: number;
    compactType?: 'vertical' | 'horizontal' | null;
    margin?: [number, number];
    containerPadding?: [number, number];
  };

  // ── Dashboard settings ────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  settings?: {
    autoRefresh?: boolean;
    refreshInterval?: number;
    theme?: 'light' | 'dark' | 'auto';
    timezone?: string;
    dateFormat?: string;
    timeFormat?: '12h' | '24h';
  };

  // ── Global filters ────────────────────────────────────────────────────────

  @Column({ type: 'jsonb', nullable: true })
  filters?: {
    dateRange?: { from: Date; to: Date };
    deviceIds?: string[];
    assetIds?: string[];
    tags?: string[];
  };

  // ── Flags ──────────────────────────────────────────────────────────────────

  @Column({ default: false })
  isDefault: boolean;

  @Column({ default: false })
  isFavorite: boolean;

  // ── Sharing ───────────────────────────────────────────────────────────────

  @Column({ type: 'simple-array', nullable: true })
  sharedWith?: string[];

  // ── Statistics ────────────────────────────────────────────────────────────

  @Column({ type: 'int', default: 0 })
  viewCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastViewedAt?: Date;

  // ── Metadata ──────────────────────────────────────────────────────────────

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  // ── Helper methods ────────────────────────────────────────────────────────

  addWidget(widget: Omit<WidgetConfig, 'id'>): void {
    if (!this.widgets) this.widgets = [];
    this.widgets.push({ ...widget, id: this.generateWidgetId() } as WidgetConfig);
  }

  removeWidget(widgetId: string): void {
    if (this.widgets) {
      this.widgets = this.widgets.filter((w) => w.id !== widgetId);
    }
  }

  updateWidget(widgetId: string, updates: Partial<WidgetConfig>): void {
    if (this.widgets) {
      const index = this.widgets.findIndex((w) => w.id === widgetId);
      if (index !== -1) {
        this.widgets[index] = { ...this.widgets[index], ...updates };
      }
    }
  }

  getWidget(widgetId: string): WidgetConfig | undefined {
    return this.widgets?.find((w) => w.id === widgetId);
  }

  /** All unique deviceIds referenced across all widgets on this dashboard */
  getUsedDevices(): string[] {
    if (!this.widgets) return [];
    const ids = new Set<string>();
    this.widgets.forEach((w) => w.dataSource?.deviceIds?.forEach((id) => ids.add(id)));
    return Array.from(ids);
  }

  /** All unique assetIds referenced across all widgets */
  getUsedAssets(): string[] {
    if (!this.widgets) return [];
    const ids = new Set<string>();
    this.widgets.forEach((w) => w.dataSource?.assetIds?.forEach((id) => ids.add(id)));
    return Array.from(ids);
  }

  /** True if any widget has useWebSocket: true in its dataSource */
  usesWebSocket(): boolean {
    return this.widgets?.some((w) => w.dataSource?.useWebSocket) ?? false;
  }

  private generateWidgetId(): string {
    // substring is the modern replacement for the deprecated substr
    return `widget-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}