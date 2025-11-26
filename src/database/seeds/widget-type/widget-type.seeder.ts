import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WidgetTypeCategory } from '@modules/widgets/entities/widget-type.entity';
import { WidgetType } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class WidgetTypeSeeder implements ISeeder {
  constructor(
    @InjectRepository(WidgetType)
    private readonly widgetTypeRepository: Repository<WidgetType>,
  ) {}

  async seed(): Promise<void> {
    const widgetTypes = [
      {
        name: 'Line Chart',
        description:
          'Time-series line chart for displaying historical data trends',
        category: WidgetTypeCategory.CHARTS,
        bundleFqn: 'charts',
        image: 'https://example.com/widgets/line-chart.png',
        descriptor: {
          type: 'timeseries' as const,
          sizeX: 6,
          sizeY: 4,
          minSizeX: 4,
          minSizeY: 3,
          defaultConfig: {
            showLegend: true,
            showTooltip: true,
            smoothCurve: false,
          },
        },
        tags: ['chart', 'timeseries', 'line'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Gauge',
        description:
          'Circular gauge widget for displaying single value with min/max thresholds',
        category: WidgetTypeCategory.GAUGES,
        bundleFqn: 'gauges',
        image: 'https://example.com/widgets/gauge.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 3,
          sizeY: 3,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: {
            min: 0,
            max: 100,
            units: '%',
            showValue: true,
          },
        },
        tags: ['gauge', 'circular', 'indicator'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Data Table',
        description: 'Tabular view of device data with sorting and filtering',
        category: WidgetTypeCategory.TABLES,
        bundleFqn: 'tables',
        image: 'https://example.com/widgets/table.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 8,
          sizeY: 6,
          minSizeX: 4,
          minSizeY: 4,
          defaultConfig: {
            showPagination: true,
            pageSize: 10,
            sortable: true,
            filterable: true,
          },
        },
        tags: ['table', 'grid', 'data'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Map Widget',
        description: 'Interactive map for displaying device locations',
        category: WidgetTypeCategory.MAPS,
        bundleFqn: 'maps',
        image: 'https://example.com/widgets/map.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 8,
          sizeY: 6,
          minSizeX: 6,
          minSizeY: 4,
          defaultConfig: {
            provider: 'openstreetmap',
            defaultZoom: 10,
            showMarkers: true,
          },
        },
        tags: ['map', 'location', 'geospatial'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Value Card',
        description: 'Simple card displaying a single metric value',
        category: WidgetTypeCategory.CARDS,
        bundleFqn: 'cards',
        image: 'https://example.com/widgets/card.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 2,
          sizeY: 2,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: {
            showIcon: true,
            showLabel: true,
            showTrend: false,
          },
        },
        tags: ['card', 'metric', 'value'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Alarm List',
        description: 'List of active and historical alarms',
        category: WidgetTypeCategory.ALARM_WIDGETS,
        bundleFqn: 'alarms',
        image: 'https://example.com/widgets/alarm-list.png',
        descriptor: {
          type: 'alarm' as const,
          sizeX: 6,
          sizeY: 5,
          minSizeX: 4,
          minSizeY: 4,
          defaultConfig: {
            showStatus: true,
            showSeverity: true,
            enableAcknowledge: true,
          },
        },
        tags: ['alarm', 'alert', 'notification'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Switch Control',
        description: 'Toggle switch for device control',
        category: WidgetTypeCategory.CONTROL_WIDGETS,
        bundleFqn: 'controls',
        image: 'https://example.com/widgets/switch.png',
        descriptor: {
          type: 'rpc' as const,
          sizeX: 2,
          sizeY: 2,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: {
            showLabel: true,
            onValue: true,
            offValue: false,
          },
        },
        tags: ['control', 'switch', 'toggle'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Bar Chart',
        description: 'Vertical or horizontal bar chart for comparing values',
        category: WidgetTypeCategory.CHARTS,
        bundleFqn: 'charts',
        image: 'https://example.com/widgets/bar-chart.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 6,
          sizeY: 4,
          minSizeX: 4,
          minSizeY: 3,
          defaultConfig: {
            orientation: 'vertical',
            showValues: true,
            showLegend: true,
          },
        },
        tags: ['chart', 'bar', 'comparison'],
        system: true,
        deprecated: false,
      },
      {
        name: 'Input Form',
        description: 'Form input for entering device data',
        category: WidgetTypeCategory.INPUT_WIDGETS,
        bundleFqn: 'inputs',
        image: 'https://example.com/widgets/input.png',
        descriptor: {
          type: 'rpc' as const,
          sizeX: 4,
          sizeY: 3,
          minSizeX: 3,
          minSizeY: 2,
          defaultConfig: {
            inputType: 'text',
            validation: true,
            submitButton: true,
          },
        },
        tags: ['input', 'form', 'entry'],
        system: true,
        deprecated: false,
      },
      {
        name: 'State Label',
        description: 'Display device state with color coding',
        category: WidgetTypeCategory.CARDS,
        bundleFqn: 'cards',
        image: 'https://example.com/widgets/state.png',
        descriptor: {
          type: 'latest' as const,
          sizeX: 2,
          sizeY: 2,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: {
            showIcon: true,
            colorByState: true,
          },
        },
        tags: ['state', 'status', 'indicator'],
        system: true,
        deprecated: false,
      },
    ];

    for (const widgetTypeData of widgetTypes) {
      const existing = await this.widgetTypeRepository.findOne({
        where: { name: widgetTypeData.name },
      });

      if (!existing) {
        const widgetType = this.widgetTypeRepository.create(widgetTypeData);
        await this.widgetTypeRepository.save(widgetType);
        console.log(
          `✅ Created widget type: ${widgetTypeData.name} (${widgetTypeData.category})`,
        );
      } else {
        console.log(`⏭️  Widget type already exists: ${widgetTypeData.name}`);
      }
    }

    console.log('🎉 Widget type seeding completed!');
  }
}
