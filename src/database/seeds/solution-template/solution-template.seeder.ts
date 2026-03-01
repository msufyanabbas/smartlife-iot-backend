// src/database/seeds/solution-template/solution-template.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SolutionTemplateCategory } from '@common/enums/index.enum';
import { SolutionTemplate, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SolutionTemplateSeeder implements ISeeder {
  private readonly logger = new Logger(SolutionTemplateSeeder.name);

  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly solutionTemplateRepository: Repository<SolutionTemplate>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting solution template seeding...');

    // Fetch users and tenants for associations
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 10 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️ No users or tenants found. Please seed them first.');
      return;
    }

    const solutionTemplates: Partial<SolutionTemplate>[] = [
      {
        name: 'Smart Factory Monitoring',
        description: 'Complete IoT solution for manufacturing floor monitoring with real-time machine health tracking, predictive maintenance, and production analytics.',
        category: SolutionTemplateCategory.SMART_FACTORY,
        icon: 'factory',
        previewImage: 'https://cdn.smartlife.sa/templates/factory.png',
        author: 'IoT Platform Team',
        rating: 4.8,
        installs: 1523,
        version: '2.1.0',
        features: [
          'Real-time machine monitoring',
          'Predictive maintenance alerts',
          'OEE tracking',
          'Energy consumption monitoring',
        ],
        tags: ['manufacturing', 'industry-4.0', 'oee'],
        devices: 50,
        dashboards: 5,
        rules: 12,
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [{ type: 'Machine Sensor', count: 50 }],
          dashboards: [{ name: 'Factory Overview' }],
          rules: [{ type: 'Predictive Alert' }],
        },
      },
      {
        name: 'Smart Home Automation',
        description: 'Comprehensive home automation template with climate control, security monitoring, and energy management.',
        category: SolutionTemplateCategory.SMART_HOME,
        icon: 'home',
        previewImage: 'https://cdn.smartlife.sa/templates/home.png',
        author: 'IoT Platform Team',
        rating: 4.9,
        installs: 3456,
        version: '3.0.2',
        features: [
          'Climate control',
          'Security & surveillance',
          'Energy monitoring',
        ],
        tags: ['home-automation', 'smart-home', 'security'],
        devices: 25,
        dashboards: 3,
        rules: 15,
        isPremium: false,
        isSystem: true,
        configuration: {
          devices: [{ type: 'Smart Thermostat', count: 5 }],
          dashboards: [{ name: 'Home Hub' }],
        },
      },
      {
        name: 'Building Management System',
        description: 'Enterprise building management with HVAC control, occupancy monitoring, and energy optimization.',
        category: SolutionTemplateCategory.SMART_BUILDING,
        icon: 'building',
        previewImage: 'https://cdn.smartlife.sa/templates/building.png',
        author: 'IoT Platform Team',
        rating: 4.7,
        installs: 892,
        version: '1.8.5',
        features: [
          'HVAC optimization',
          'Occupancy sensing',
          'Energy analytics',
        ],
        tags: ['building-management', 'hvac', 'energy'],
        devices: 75,
        dashboards: 7,
        rules: 20,
        isPremium: true,
        isSystem: true,
      },
      {
        name: 'Precision Agriculture',
        description: 'Agricultural IoT solution with soil monitoring, irrigation automation, and crop health analytics.',
        category: SolutionTemplateCategory.AGRICULTURE,
        icon: 'agriculture',
        previewImage: 'https://cdn.smartlife.sa/templates/agriculture.png',
        author: 'IoT Platform Team',
        rating: 4.5,
        installs: 678,
        version: '2.3.1',
        features: [
          'Soil moisture monitoring',
          'Automated irrigation',
          'Crop health tracking',
        ],
        tags: ['agriculture', 'farming', 'irrigation'],
        devices: 40,
        dashboards: 4,
        rules: 18,
        isPremium: false,
        isSystem: true,
      },
      {
        name: 'Healthcare Monitoring',
        description: 'Healthcare facility monitoring with patient tracking and equipment monitoring.',
        category: SolutionTemplateCategory.HEALTHCARE,
        icon: 'hospital',
        previewImage: 'https://cdn.smartlife.sa/templates/healthcare.png',
        author: 'IoT Platform Team',
        rating: 4.9,
        installs: 567,
        version: '2.0.0',
        features: [
          'Patient vital monitoring',
          'Equipment tracking',
          'Alert management',
        ],
        tags: ['healthcare', 'hospital', 'patient-monitoring'],
        devices: 60,
        dashboards: 6,
        rules: 25,
        isPremium: true,
        isSystem: true,
      },
      {
        name: 'Fleet & Logistics Tracking',
        description: 'Complete fleet management solution with vehicle tracking and route optimization.',
        category: SolutionTemplateCategory.LOGISTICS,
        icon: 'truck',
        previewImage: 'https://cdn.smartlife.sa/templates/logistics.png',
        author: 'IoT Platform Team',
        rating: 4.6,
        installs: 945,
        version: '1.9.2',
        features: [
          'Real-time GPS tracking',
          'Route optimization',
          'Fuel monitoring',
        ],
        tags: ['logistics', 'fleet', 'tracking'],
        devices: 100,
        dashboards: 6,
        rules: 22,
        isPremium: true,
        isSystem: true,
      },
      {
        name: 'Custom Manufacturing Template',
        description: 'User-created template for specialized manufacturing process monitoring.',
        category: SolutionTemplateCategory.SMART_FACTORY,
        icon: 'custom',
        previewImage: 'https://cdn.smartlife.sa/templates/custom.png',
        author: users[0].name,
        rating: 4.2,
        installs: 23,
        version: '1.0.0',
        features: [
          'Custom device integration',
          'Process monitoring',
        ],
        tags: ['custom', 'manufacturing'],
        devices: 20,
        dashboards: 2,
        rules: 8,
        isPremium: false,
        isSystem: false,
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        configuration: {
          devices: [{ type: 'Custom Sensor', count: 10 }],
        }
      },
    ];

    let createdCount = 0;
    let skippedCount = 0;

    for (const templateData of solutionTemplates) {
      if (!templateData.name) {
        this.logger.warn('⚠️ Skipping template entry with missing name.');
        continue;
      }

      const existing = await this.solutionTemplateRepository.findOne({
        where: { name: templateData.name },
      });

      if (!existing) {
        const template = this.solutionTemplateRepository.create(templateData);
        await this.solutionTemplateRepository.save(template);
        this.logger.log(
          `✅ Created solution template: ${templateData.name.padEnd(30)} | Category: ${templateData.category} | ${templateData.isSystem ? 'System' : 'User'}`,
        );
        createdCount++;
      } else {
        this.logger.log(`⏭️  Solution template already exists: ${templateData.name}`);
        skippedCount++;
      }
    }

    this.logger.log(`🎉 Solution template seeding completed! Created: ${createdCount}, Skipped: ${skippedCount}`);
  }
}
