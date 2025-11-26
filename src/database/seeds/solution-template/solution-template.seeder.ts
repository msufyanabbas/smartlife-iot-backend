import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TemplateCategory } from '@modules/solution-templates/entities/solution-template.entity';
import { SolutionTemplate, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class SolutionTemplateSeeder implements ISeeder {
  constructor(
    @InjectRepository(SolutionTemplate)
    private readonly solutionTemplateRepository: Repository<SolutionTemplate>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async seed(): Promise<void> {
    // Fetch all users first
    const users = await this.userRepository.find({ take: 10 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const solutionTemplates = [
      {
        name: 'Smart Factory Monitoring',
        description:
          'Complete IoT solution for manufacturing floor monitoring with real-time machine health tracking, predictive maintenance, and production analytics.',
        category: TemplateCategory.SMART_FACTORY,
        icon: 'factory',
        rating: 4.8,
        installs: 1523,
        version: '2.1.0',
        author: 'IoT Platform Team',
        features: [
          'Real-time machine monitoring',
          'Predictive maintenance alerts',
          'Production line analytics',
          'OEE tracking',
          'Downtime analysis',
          'Energy consumption monitoring',
        ],
        devices: 50,
        dashboards: 5,
        rules: 12,
        tags: [
          'manufacturing',
          'industry-4.0',
          'predictive-maintenance',
          'oee',
        ],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/smart-factory.png',
      },
      {
        name: 'Smart Home Automation',
        description:
          'Comprehensive home automation template with climate control, security monitoring, energy management, and scene automation.',
        category: TemplateCategory.SMART_HOME,
        icon: 'home',
        rating: 4.9,
        installs: 3456,
        version: '3.0.2',
        author: 'IoT Platform Team',
        features: [
          'Climate control automation',
          'Security & surveillance',
          'Energy monitoring',
          'Scene automation',
          'Voice control integration',
          'Mobile app support',
        ],
        devices: 25,
        dashboards: 3,
        rules: 15,
        tags: ['home-automation', 'smart-home', 'energy-saving', 'security'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/smart-home.png',
      },
      {
        name: 'Building Management System',
        description:
          'Enterprise building management with HVAC control, occupancy monitoring, energy optimization, and facility maintenance tracking.',
        category: TemplateCategory.SMART_BUILDING,
        icon: 'building',
        rating: 4.7,
        installs: 892,
        version: '1.8.5',
        author: 'IoT Platform Team',
        features: [
          'HVAC optimization',
          'Occupancy sensing',
          'Energy analytics',
          'Maintenance scheduling',
          'Access control integration',
          'Environmental monitoring',
        ],
        devices: 75,
        dashboards: 7,
        rules: 20,
        tags: [
          'building-management',
          'hvac',
          'energy-efficiency',
          'facilities',
        ],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/smart-building.png',
      },
      {
        name: 'Smart City Infrastructure',
        description:
          'City-wide IoT infrastructure for traffic management, smart lighting, waste management, and environmental monitoring.',
        category: TemplateCategory.SMART_CITY,
        icon: 'city',
        rating: 4.6,
        installs: 234,
        version: '1.5.0',
        author: 'IoT Platform Team',
        features: [
          'Traffic flow monitoring',
          'Smart street lighting',
          'Waste management optimization',
          'Air quality monitoring',
          'Parking management',
          'Public transport tracking',
        ],
        devices: 500,
        dashboards: 10,
        rules: 35,
        tags: [
          'smart-city',
          'traffic',
          'sustainability',
          'public-infrastructure',
        ],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/smart-city.png',
      },
      {
        name: 'Precision Agriculture',
        description:
          'Agricultural IoT solution with soil monitoring, irrigation automation, weather tracking, and crop health analytics.',
        category: TemplateCategory.AGRICULTURE,
        icon: 'agriculture',
        rating: 4.5,
        installs: 678,
        version: '2.3.1',
        author: 'IoT Platform Team',
        features: [
          'Soil moisture monitoring',
          'Automated irrigation',
          'Weather station integration',
          'Crop health monitoring',
          'Pest detection alerts',
          'Yield prediction',
        ],
        devices: 40,
        dashboards: 4,
        rules: 18,
        tags: ['agriculture', 'farming', 'irrigation', 'precision-agriculture'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/agriculture.png',
      },
      {
        name: 'Healthcare Monitoring',
        description:
          'Healthcare facility monitoring with patient tracking, equipment monitoring, environmental control, and alert management.',
        category: TemplateCategory.HEALTHCARE,
        icon: 'hospital',
        rating: 4.9,
        installs: 567,
        version: '2.0.0',
        author: 'IoT Platform Team',
        features: [
          'Patient vital monitoring',
          'Equipment tracking',
          'Environmental monitoring',
          'Alert management',
          'Compliance reporting',
          'Staff tracking',
        ],
        devices: 60,
        dashboards: 6,
        rules: 25,
        tags: ['healthcare', 'hospital', 'patient-monitoring', 'medical'],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/healthcare.png',
      },
      {
        name: 'Energy Management',
        description:
          'Comprehensive energy monitoring and management solution with consumption tracking, cost optimization, and renewable energy integration.',
        category: TemplateCategory.ENERGY,
        icon: 'energy',
        rating: 4.7,
        installs: 1234,
        version: '2.2.3',
        author: 'IoT Platform Team',
        features: [
          'Real-time consumption monitoring',
          'Cost analysis',
          'Peak demand management',
          'Solar integration',
          'Carbon footprint tracking',
          'Automated reporting',
        ],
        devices: 35,
        dashboards: 5,
        rules: 16,
        tags: ['energy', 'power', 'renewable', 'sustainability'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/energy.png',
      },
      {
        name: 'Fleet & Logistics Tracking',
        description:
          'Complete fleet management solution with vehicle tracking, route optimization, fuel monitoring, and maintenance scheduling.',
        category: TemplateCategory.LOGISTICS,
        icon: 'truck',
        rating: 4.6,
        installs: 945,
        version: '1.9.2',
        author: 'IoT Platform Team',
        features: [
          'Real-time GPS tracking',
          'Route optimization',
          'Fuel monitoring',
          'Driver behavior analysis',
          'Maintenance alerts',
          'Delivery management',
        ],
        devices: 100,
        dashboards: 6,
        rules: 22,
        tags: ['logistics', 'fleet', 'tracking', 'transportation'],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/logistics.png',
      },
      {
        name: 'Smart Retail Analytics',
        description:
          'Retail analytics platform with foot traffic monitoring, inventory tracking, customer behavior analysis, and sales optimization.',
        category: TemplateCategory.RETAIL,
        icon: 'store',
        rating: 4.8,
        installs: 1678,
        version: '2.4.0',
        author: 'IoT Platform Team',
        features: [
          'Foot traffic analysis',
          'Heat mapping',
          'Inventory monitoring',
          'Queue management',
          'Customer behavior tracking',
          'Sales analytics',
        ],
        devices: 45,
        dashboards: 5,
        rules: 14,
        tags: ['retail', 'analytics', 'customer-experience', 'inventory'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/retail.png',
      },
      {
        name: 'Water Management System',
        description:
          'Water infrastructure monitoring with leak detection, quality monitoring, consumption tracking, and distribution optimization.',
        category: TemplateCategory.WATER,
        icon: 'water',
        rating: 4.5,
        installs: 432,
        version: '1.7.1',
        author: 'IoT Platform Team',
        features: [
          'Leak detection',
          'Water quality monitoring',
          'Flow measurement',
          'Pressure monitoring',
          'Consumption analytics',
          'Distribution optimization',
        ],
        devices: 80,
        dashboards: 6,
        rules: 19,
        tags: ['water', 'utilities', 'leak-detection', 'quality-monitoring'],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/water.png',
      },
      {
        name: 'Climate Monitoring Station',
        description:
          'Environmental monitoring solution with weather tracking, air quality monitoring, and climate data analytics.',
        category: TemplateCategory.CLIMATE,
        icon: 'cloud',
        rating: 4.7,
        installs: 789,
        version: '2.1.4',
        author: 'IoT Platform Team',
        features: [
          'Weather monitoring',
          'Air quality tracking',
          'Temperature & humidity',
          'Wind speed & direction',
          'Precipitation measurement',
          'Data visualization',
        ],
        devices: 15,
        dashboards: 3,
        rules: 10,
        tags: ['climate', 'weather', 'environment', 'air-quality'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/climate.png',
      },
      {
        name: 'Smart Campus Solution',
        description:
          'Educational campus IoT platform with classroom automation, energy management, security, and facility monitoring.',
        category: TemplateCategory.EDUCATION,
        icon: 'school',
        rating: 4.6,
        installs: 534,
        version: '1.6.0',
        author: 'IoT Platform Team',
        features: [
          'Classroom automation',
          'Attendance tracking',
          'Energy optimization',
          'Security monitoring',
          'Facility management',
          'Asset tracking',
        ],
        devices: 65,
        dashboards: 5,
        rules: 17,
        tags: ['education', 'campus', 'classroom', 'security'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/education.png',
      },
      {
        name: 'Industrial Safety Monitor',
        description:
          'Safety monitoring system for industrial environments with gas detection, temperature monitoring, and emergency alerts.',
        category: TemplateCategory.SMART_FACTORY,
        icon: 'shield',
        rating: 4.9,
        installs: 1123,
        version: '2.5.1',
        author: 'IoT Platform Team',
        features: [
          'Gas leak detection',
          'Temperature monitoring',
          'Emergency alerts',
          'Worker safety tracking',
          'Compliance reporting',
          'Incident management',
        ],
        devices: 55,
        dashboards: 4,
        rules: 24,
        tags: ['safety', 'industrial', 'compliance', 'emergency'],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/safety.png',
      },
      {
        name: 'Greenhouse Automation',
        description:
          'Automated greenhouse management with climate control, irrigation, lighting, and plant health monitoring.',
        category: TemplateCategory.AGRICULTURE,
        icon: 'greenhouse',
        rating: 4.8,
        installs: 456,
        version: '1.8.0',
        author: 'IoT Platform Team',
        features: [
          'Climate control',
          'Automated irrigation',
          'Lighting control',
          'CO2 monitoring',
          'Plant health tracking',
          'Growth analytics',
        ],
        devices: 30,
        dashboards: 4,
        rules: 13,
        tags: ['greenhouse', 'agriculture', 'automation', 'horticulture'],
        isPremium: false,
        isSystem: true,
        previewImage: 'https://example.com/templates/greenhouse.png',
      },
      {
        name: 'Cold Chain Monitoring',
        description:
          'Temperature-controlled logistics with real-time monitoring, alert management, and compliance reporting for cold chain.',
        category: TemplateCategory.LOGISTICS,
        icon: 'snowflake',
        rating: 4.7,
        installs: 678,
        version: '2.0.3',
        author: 'IoT Platform Team',
        features: [
          'Temperature monitoring',
          'Humidity tracking',
          'Location tracking',
          'Alert management',
          'Compliance reporting',
          'Chain of custody',
        ],
        devices: 50,
        dashboards: 4,
        rules: 16,
        tags: ['cold-chain', 'logistics', 'temperature', 'compliance'],
        isPremium: true,
        isSystem: true,
        previewImage: 'https://example.com/templates/cold-chain.png',
      },
      {
        name: 'Custom Manufacturing Template',
        description:
          'User-created template for specialized manufacturing process monitoring',
        category: TemplateCategory.SMART_FACTORY,
        icon: 'custom',
        rating: 4.2,
        installs: 23,
        version: '1.0.0',
        author: users[0].name,
        features: [
          'Custom device integration',
          'Process monitoring',
          'Quality control',
        ],
        devices: 20,
        dashboards: 2,
        rules: 8,
        tags: ['custom', 'manufacturing', 'process-control'],
        isPremium: false,
        isSystem: false,
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
    ];

    for (const templateData of solutionTemplates) {
      const existing = await this.solutionTemplateRepository.findOne({
        where: { name: templateData.name },
      });

      if (!existing) {
        const template = this.solutionTemplateRepository.create(templateData);
        await this.solutionTemplateRepository.save(template);
        console.log(
          `✅ Created solution template: ${templateData.name} (${templateData.category} - ${templateData.isPremium ? 'Premium' : 'Free'})`,
        );
      } else {
        console.log(
          `⏭️  Solution template already exists: ${templateData.name}`,
        );
      }
    }

    console.log('🎉 Solution template seeding completed!');
  }
}
