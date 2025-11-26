import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WidgetBundle } from '@modules/widgets/entities/widget-bundle.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class WidgetBundleSeeder implements ISeeder {
  constructor(
    @InjectRepository(WidgetBundle)
    private readonly widgetBundleRepository: Repository<WidgetBundle>,
  ) {}

  async seed(): Promise<void> {
    const widgetBundles = [
      {
        title: 'Charts',
        description:
          'Comprehensive collection of chart widgets for data visualization',
        image: 'https://example.com/bundles/charts.png',
        order: 1,
        system: true,
      },
      {
        title: 'Cards',
        description: 'Card widgets for displaying key metrics and indicators',
        image: 'https://example.com/bundles/cards.png',
        order: 2,
        system: true,
      },
      {
        title: 'Maps',
        description: 'Map widgets for location tracking and geospatial data',
        image: 'https://example.com/bundles/maps.png',
        order: 3,
        system: true,
      },
      {
        title: 'Gauges',
        description: 'Gauge widgets for real-time monitoring of sensor values',
        image: 'https://example.com/bundles/gauges.png',
        order: 4,
        system: true,
      },
      {
        title: 'Control Widgets',
        description: 'Interactive controls for device management and commands',
        image: 'https://example.com/bundles/controls.png',
        order: 5,
        system: true,
      },
      {
        title: 'Alarm Widgets',
        description: 'Alarm management and notification widgets',
        image: 'https://example.com/bundles/alarms.png',
        order: 6,
        system: true,
      },
      {
        title: 'Tables',
        description: 'Data tables and grids for structured information display',
        image: 'https://example.com/bundles/tables.png',
        order: 7,
        system: true,
      },
      {
        title: 'Input Widgets',
        description: 'Form inputs and data entry widgets',
        image: 'https://example.com/bundles/inputs.png',
        order: 8,
        system: true,
      },
      {
        title: 'Navigation',
        description: 'Navigation and state management widgets',
        image: 'https://example.com/bundles/navigation.png',
        order: 9,
        system: true,
      },
      {
        title: 'Analytics',
        description: 'Advanced analytics and business intelligence widgets',
        image: 'https://example.com/bundles/analytics.png',
        order: 10,
        system: true,
      },
    ];

    for (const bundleData of widgetBundles) {
      const existing = await this.widgetBundleRepository.findOne({
        where: { title: bundleData.title },
      });

      if (!existing) {
        const bundle = this.widgetBundleRepository.create(bundleData);
        await this.widgetBundleRepository.save(bundle);
        console.log(`✅ Created widget bundle: ${bundleData.title}`);
      } else {
        console.log(`⏭️  Widget bundle already exists: ${bundleData.title}`);
      }
    }

    console.log('🎉 Widget bundle seeding completed!');
  }
}
