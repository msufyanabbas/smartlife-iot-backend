// src/modules/widgets/entities/widget-type.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { WidgetTypeCategory } from '@common/enums/index.enum';
import { Tenant } from '@modules/index.entities';

@Entity('widget_types')
@Index(['tenantId', 'name'])
@Index(['tenantId', 'category'])
@Index(['bundleFqn'])
export class WidgetType extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (OPTIONAL - null for system widgets)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  tenantId?: string;  // null = system widget, has value = tenant-specific widget

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ unique: true })
  @Index()
  name: string;  // "Time-Series Line Chart", "Temperature Gauge"

  @Column({ type: 'text', nullable: true })
  description?: string;  // "Display time-series data as a line chart"

  @Column({ type: 'enum', enum: WidgetTypeCategory, default: WidgetTypeCategory.OTHER })
  @Index()
  category: WidgetTypeCategory;

  @Column({ nullable: true })
  bundleFqn?: string;  // "Charts", "Gauges" - groups widgets

  @Column({ nullable: true })
  image?: string;  // Preview image URL

  @Column({ nullable: true })
  iconUrl?: string;  // Icon for widget picker

  // ══════════════════════════════════════════════════════════════════════════
  // WIDGET DESCRIPTOR (How to render this widget)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb' })
  descriptor: {
    // Widget data type
    type: 'timeseries' | 'latest' | 'rpc' | 'alarm' | 'static';

    // Size constraints (grid units)
    sizeX: number;          // Default width
    sizeY: number;          // Default height
    minSizeX?: number;      // Minimum width
    minSizeY?: number;      // Minimum height
    maxSizeX?: number;      // Maximum width (12 = full width)
    maxSizeY?: number;      // Maximum height

    // External resources (Chart.js, Leaflet, etc.)
    resources?: Array<{
      url: string;          // CDN URL
      isModule?: boolean;   // Is this an ES module?
    }>;

    // HTML template
    templateHtml?: string;  // HTML to render

    // CSS template
    templateCss?: string;   // CSS styles

    // JavaScript controller
    controllerScript?: string;  // JS code to run

    // Settings schema (what settings can users configure?)
    settingsSchema?: {
      schema: {
        type: 'object';
        title?: string;
        properties: Record<string, any>;
      };
      form?: any[];
    };

    // Data keys schema
    dataKeySettingsSchema?: {
      schema: any;
      form?: any[];
    };

    // Action sources (buttons, etc.)
    actionSources?: Record<string, {
      name: string;
      multiple?: boolean;
    }>;

    // Default configuration
    defaultConfig?: Record<string, any>;
  };
  // Example for Line Chart:
  // descriptor: {
  //   type: 'timeseries',
  //   sizeX: 12,
  //   sizeY: 6,
  //   minSizeX: 6,
  //   minSizeY: 4,
  //   resources: [
  //     { url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js' }
  //   ],
  //   templateHtml: '<div class="chart-container"><canvas id="lineChart"></canvas></div>',
  //   templateCss: '.chart-container { padding: 10px; }',
  //   settingsSchema: {
  //     schema: {
  //       type: 'object',
  //       properties: {
  //         showLegend: { type: 'boolean', title: 'Show Legend', default: true },
  //         lineWidth: { type: 'number', title: 'Line Width', default: 2 }
  //       }
  //     }
  //   },
  //   defaultConfig: {
  //     showLegend: true,
  //     lineWidth: 2
  //   }
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // WIDGET SETTINGS TEMPLATE
  // ══════════════════════════════════════════════════════════════════════════
   
  @Column({ type: 'jsonb', nullable: true })
  settingsTemplate?: {
    showTitle?: boolean;
    backgroundColor?: string;
    color?: string;
    padding?: string;
    settings?: Record<string, any>;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════════════════════════════════════
   
  @Column({ default: false })
  system: boolean;  // System widgets can't be deleted

  @Column({ default: false })
  deprecated: boolean;  // Mark as deprecated (hide in UI but keep for old dashboards)

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['chart', 'temperature', 'analytics']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
