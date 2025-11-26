import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum WidgetTypeCategory {
  ALARM_WIDGETS = 'alarm_widgets',
  ANALYTICS = 'analytics',
  CARDS = 'cards',
  CHARTS = 'charts',
  CONTROL_WIDGETS = 'control_widgets',
  DATE = 'date',
  GAUGES = 'gauges',
  GPIO_WIDGETS = 'gpio_widgets',
  INPUT_WIDGETS = 'input_widgets',
  MAPS = 'maps',
  NAVIGATION = 'navigation',
  TABLES = 'tables',
  WEATHER = 'weather',
  OTHER = 'other',
}

@Entity('widget_types')
export class WidgetType extends BaseEntity {
  @Column({ unique: true })
  @Index()
  name: string;

  @Column({ nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: WidgetTypeCategory,
    default: WidgetTypeCategory.OTHER,
  })
  @Index()
  category: WidgetTypeCategory;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  // Bundle FQN (Fully Qualified Name) like ThingsBoard
  @Column({ nullable: true })
  bundleFqn?: string;

  // Widget image/icon
  @Column({ nullable: true })
  image?: string;

  @Column({ type: 'text', nullable: true })
  iconUrl?: string;

  // Widget descriptor (full configuration like ThingsBoard)
  @Column({ type: 'jsonb' })
  descriptor: {
    // Widget type
    type: 'timeseries' | 'latest' | 'rpc' | 'alarm' | 'static';

    // Size constraints
    sizeX: number;
    sizeY: number;
    minSizeX?: number;
    minSizeY?: number;
    maxSizeX?: number;
    maxSizeY?: number;

    // Resources (JS, CSS)
    resources?: Array<{
      url: string;
      isModule?: boolean;
    }>;

    // Template HTML
    templateHtml?: string;

    // Template CSS
    templateCss?: string;

    // Controller JS
    controllerScript?: string;

    // Settings schema
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

    // Action sources
    actionSources?: Record<
      string,
      {
        name: string;
        multiple?: boolean;
      }
    >;

    // Default configuration
    defaultConfig?: Record<string, any>;
  };

  // Widget settings template
  @Column({ type: 'jsonb', nullable: true })
  settingsTemplate?: {
    showTitle?: boolean;
    backgroundColor?: string;
    color?: string;
    padding?: string;
    settings?: Record<string, any>;
  };

  // Tags for filtering
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  // System widget (can't be deleted)
  @Column({ default: false })
  system: boolean;

  // Deprecated flag
  @Column({ default: false })
  deprecated: boolean;

  // Additional info
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
