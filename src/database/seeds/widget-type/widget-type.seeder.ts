// src/database/seeds/widget-type/widget-type.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { WidgetTypeCategory } from '@common/enums/index.enum';
import { WidgetType, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class WidgetTypeSeeder implements ISeeder {
  constructor(
    @InjectRepository(WidgetType)
    private readonly widgetTypeRepository: Repository<WidgetType>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    console.log('🧩 Seeding widget types...');

    // Get first tenant (for tenant-specific widgets)
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const widgetTypes: Partial<WidgetType>[] = [
      // ════════════════════════════════════════════════════════════════
      // SYSTEM WIDGETS (tenantId: null)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined, // System widget
        name: 'Line Chart',
        description: 'Time-series line chart for displaying historical data trends',
        category: WidgetTypeCategory.CHARTS,
        bundleFqn: 'charts',
        image: 'https://example.com/widgets/line-chart.png',
        iconUrl: 'https://example.com/icons/line-chart.svg',
        descriptor: {
          type: 'timeseries',
          sizeX: 6,
          sizeY: 4,
          minSizeX: 4,
          minSizeY: 3,
          resources: [
            { url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js' },
          ],
          settingsSchema: {
            schema: {
              type: 'object',
              title: 'Line Chart Settings',
              properties: {
                showLegend: { type: 'boolean', title: 'Show Legend', default: true },
                lineWidth: { type: 'number', title: 'Line Width', default: 2 },
                smoothCurve: { type: 'boolean', title: 'Smooth Curve', default: false },
              },
            },
          },
          defaultConfig: {
            showLegend: true,
            showTooltip: true,
            smoothCurve: false,
            lineWidth: 2,
          },
        },
        settingsTemplate: {
          showTitle: true,
          backgroundColor: '#ffffff',
          padding: '10px',
        },
        tags: ['chart', 'timeseries', 'line'],
        system: true,
        deprecated: false,
        additionalInfo: { version: '1.0.0', author: 'SmartLife' },
      },
      {
        tenantId: undefined,
        name: 'Gauge',
        description: 'Circular gauge widget for displaying single value',
        category: WidgetTypeCategory.GAUGES,
        bundleFqn: 'gauges',
        image: 'https://example.com/widgets/gauge.png',
        iconUrl: 'https://example.com/icons/gauge.svg',
        descriptor: {
          type: 'latest',
          sizeX: 3,
          sizeY: 3,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: { min: 0, max: 100, units: '%', showValue: true },
        },
        system: true,
        deprecated: false,
        tags: ['gauge', 'circular'],
        additionalInfo: { version: '1.0.0' },
      },
      {
        tenantId: undefined,
        name: 'Data Table',
        description: 'Tabular view of device data',
        category: WidgetTypeCategory.TABLES,
        bundleFqn: 'tables',
        image: 'https://example.com/widgets/table.png',
        iconUrl: 'https://example.com/icons/table.svg',
        descriptor: {
          type: 'latest',
          sizeX: 8,
          sizeY: 6,
          minSizeX: 4,
          minSizeY: 4,
          defaultConfig: { showPagination: true, pageSize: 10 },
        },
        system: true,
        deprecated: false,
        tags: ['table', 'grid'],
      },

      // ════════════════════════════════════════════════════════════════
      // TENANT-SPECIFIC WIDGETS
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: tenant.id,
        name: 'Company Weather Widget',
        description: 'Custom weather widget for ' + tenant.name,
        category: WidgetTypeCategory.WEATHER,
        bundleFqn: 'custom',
        image: 'https://example.com/widgets/weather.png',
        iconUrl: 'https://example.com/icons/weather.svg',
        descriptor: {
          type: 'latest',
          sizeX: 3,
          sizeY: 3,
          minSizeX: 2,
          minSizeY: 2,
          defaultConfig: { units: 'celsius', showForecast: true },
        },
        system: false,
        deprecated: false,
        tags: ['weather', 'custom', tenant.name.toLowerCase()],
        additionalInfo: { customFor: tenant.name },
      },
      {
        tenantId: tenant.id,
        name: 'Production KPI Analytics',
        description: 'Specific analytics for tenant operations',
        category: WidgetTypeCategory.ANALYTICS,
        bundleFqn: 'custom',
        image: 'https://example.com/widgets/analytics.png',
        iconUrl: 'https://example.com/icons/analytics.svg',
        descriptor: {
          type: 'latest',
          sizeX: 12,
          sizeY: 6,
          minSizeX: 8,
          minSizeY: 4,
          defaultConfig: { timeRange: '24h', refreshInterval: 30 },
        },
        system: false,
        deprecated: false,
        tags: ['analytics', 'production', 'kpi'],
      },
    ];

    for (const widgetTypeData of widgetTypes) {
      const existing = await this.widgetTypeRepository.findOne({
        where: {
          name: widgetTypeData.name,
          tenantId: widgetTypeData.tenantId ? widgetTypeData.tenantId : IsNull()
        },
      });

      if (!existing) {
        const widgetType = this.widgetTypeRepository.create(widgetTypeData);
        await this.widgetTypeRepository.save(widgetType);
        console.log(
          `✅ Created ${widgetTypeData.tenantId ? 'tenant' : 'system'} widget type: ${widgetTypeData.name}`,
        );
      } else {
        console.log(`⏭️  Widget type already exists: ${widgetTypeData.name}`);
      }
    }

    console.log(`🎉 Widget type seeding completed! (${widgetTypes.length} widget types)`);
  }
}
