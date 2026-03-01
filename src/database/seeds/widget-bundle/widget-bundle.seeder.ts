// src/database/seeds/widget-bundle/widget-bundle.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { WidgetBundle, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class WidgetBundleSeeder implements ISeeder {
  constructor(
    @InjectRepository(WidgetBundle)
    private readonly widgetBundleRepository: Repository<WidgetBundle>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    console.log('📦 Seeding widget bundles...');

    // Get first tenant (for tenant-specific bundles)
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const widgetBundles: Partial<WidgetBundle>[] = [
      // ════════════════════════════════════════════════════════════════
      // SYSTEM BUNDLES (tenantId: null)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined, // null = system bundle
        title: 'Charts',
        description: 'Comprehensive collection of chart widgets for data visualization',
        image: 'https://example.com/bundles/charts.png',
        order: 1,
        system: true,
        additionalInfo: { author: 'SmartLife', category: 'Visualization' },
      },
      {
        tenantId: undefined,
        title: 'Cards',
        description: 'Card widgets for displaying key metrics and indicators',
        image: 'https://example.com/bundles/cards.png',
        order: 2,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Maps',
        description: 'Map widgets for location tracking and geospatial data',
        image: 'https://example.com/bundles/maps.png',
        order: 3,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Gauges',
        description: 'Gauge widgets for real-time monitoring of sensor values',
        image: 'https://example.com/bundles/gauges.png',
        order: 4,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Control Widgets',
        description: 'Interactive controls for device management and commands',
        image: 'https://example.com/bundles/controls.png',
        order: 5,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Alarm Widgets',
        description: 'Alarm management and notification widgets',
        image: 'https://example.com/bundles/alarms.png',
        order: 6,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Tables',
        description: 'Data tables and grids for structured information display',
        image: 'https://example.com/bundles/tables.png',
        order: 7,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Input Widgets',
        description: 'Form inputs and data entry widgets',
        image: 'https://example.com/bundles/inputs.png',
        order: 8,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Navigation',
        description: 'Navigation and state management widgets',
        image: 'https://example.com/bundles/navigation.png',
        order: 9,
        system: true,
      },
      {
        tenantId: undefined,
        title: 'Analytics',
        description: 'Advanced analytics and business intelligence widgets',
        image: 'https://example.com/bundles/analytics.png',
        order: 10,
        system: true,
      },

      // ════════════════════════════════════════════════════════════════
      // TENANT-SPECIFIC BUNDLES
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: tenant.id,
        title: tenant.name + ' Custom Widgets',
        description: 'Bespoke widgets developed specifically for ' + tenant.name,
        image: 'https://example.com/bundles/custom.png',
        order: 100,
        system: false,
        additionalInfo: { customFor: tenant.name, status: 'active' },
      },
    ];

    for (const bundleData of widgetBundles) {
      const existing = await this.widgetBundleRepository.findOne({
        where: {
          title: bundleData.title,
          tenantId: bundleData.tenantId ? bundleData.tenantId : IsNull()
        },
      });

      if (!existing) {
        const bundle = this.widgetBundleRepository.create(bundleData);
        await this.widgetBundleRepository.save(bundle);
        console.log(
          `✅ Created ${bundleData.tenantId ? 'tenant' : 'system'} widget bundle: ${bundleData.title}`,
        );
      } else {
        console.log(`⏭️  Widget bundle already exists: ${bundleData.title}`);
      }
    }

    console.log(`🎉 Widget bundle seeding completed! (${widgetBundles.length} bundles)`);
  }
}
