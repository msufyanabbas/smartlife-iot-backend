// src/database/seeders/automation.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Automation, User, Device, Tenant, Customer } from '@modules/index.entities';
import { TriggerType, ActionType, AutomationStatus } from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AutomationSeeder implements ISeeder {
  constructor(
    @InjectRepository(Automation)
    private readonly automationRepository: Repository<Automation>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async seed(): Promise<void> {
    console.log('🤖 Seeding automations...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get first user
    const user = await this.userRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    if (!user) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Get first customer
    const customer = await this.customerRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    // Get devices
    const devices = await this.deviceRepository.find({
      where: { tenantId: tenant.id },
      take: 5,
    });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    const getRandomDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      return date;
    };

    const automationsData: Partial<Automation>[] = [
      // 1. Temperature Control - THRESHOLD Trigger
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Turn on AC when temperature is high',
        description: 'Automatically turn on air conditioning when temperature exceeds 28°C',
        enabled: true,
        status: AutomationStatus.ACTIVE,
        trigger: {
          type: TriggerType.THRESHOLD,
          deviceId: devices[0]?.id,
          telemetryKey: 'temperature',
          operator: 'gte',
          value: 28,
          debounce: 60,
        },
        action: {
          type: ActionType.CONTROL,
          deviceId: devices[1]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: 15,
        lastTriggered: getRandomDate(2),
        lastExecuted: getRandomDate(2),
        tags: ['hvac', 'cooling', 'temperature'],
        settings: {
          cooldown: 300,
          maxExecutionsPerDay: 10,
          activeHours: {
            start: '08:00',
            end: '22:00',
          },
        },
      },

      // 2. Lighting - SCHEDULE Trigger
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Turn on lights at sunset',
        description: 'Automatically turn on outdoor lights at 6:00 PM',
        enabled: true,
        status: AutomationStatus.ACTIVE,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 18 * * *', // 6:00 PM daily
        },
        action: {
          type: ActionType.CONTROL,
          deviceId: devices[2]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: 45,
        lastTriggered: getRandomDate(1),
        lastExecuted: getRandomDate(1),
        tags: ['lighting', 'outdoor', 'schedule'],
      },

      // 3. Security - STATE Trigger
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Motion-activated lighting',
        description: 'Turn on lights when motion is detected',
        enabled: true,
        status: AutomationStatus.ACTIVE,
        trigger: {
          type: TriggerType.STATE,
          deviceId: devices[3]?.id || devices[0]?.id,
          attributeKey: 'motion',
          operator: 'eq',
          value: true,
        },
        action: {
          type: ActionType.CONTROL,
          deviceId: devices[2]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: 120,
        lastTriggered: getRandomDate(0),
        lastExecuted: getRandomDate(0),
        tags: ['security', 'lighting', 'motion'],
        settings: {
          cooldown: 60,
          activeDays: [1, 2, 3, 4, 5], // Mon-Fri
        },
      },

      // 4. Alert - NOTIFICATION Action
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'High power consumption alert',
        description: 'Send alert when power consumption exceeds 500W',
        enabled: true,
        status: AutomationStatus.ACTIVE,
        trigger: {
          type: TriggerType.THRESHOLD,
          deviceId: devices[4]?.id || devices[0]?.id,
          telemetryKey: 'power',
          operator: 'gt',
          value: 500,
        },
        action: {
          type: ActionType.NOTIFICATION,
          message: 'High power consumption detected - exceeds 500W',
          recipients: [user.email],
        },
        executionCount: 8,
        lastTriggered: getRandomDate(3),
        lastExecuted: getRandomDate(3),
        tags: ['energy', 'alert', 'power'],
        settings: {
          cooldown: 600,
          maxExecutionsPerDay: 5,
        },
      },

      // 5. Webhook Integration - WEBHOOK Action
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        name: 'Update external system on device offline',
        description: 'Send webhook to external API when device goes offline',
        enabled: true,
        status: AutomationStatus.ACTIVE,
        trigger: {
          type: TriggerType.STATE,
          deviceId: devices[0]?.id,
          attributeKey: 'status',
          operator: 'eq',
          value: 'offline',
        },
        action: {
          type: ActionType.WEBHOOK,
          webhookUrl: 'https://api.example.com/device-status',
          webhookMethod: 'POST',
          webhookHeaders: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer API_KEY',
          },
          webhookBody: {
            deviceId: '{{deviceId}}',
            status: '{{status}}',
            timestamp: '{{timestamp}}',
          },
        },
        executionCount: 3,
        lastTriggered: getRandomDate(5),
        lastExecuted: getRandomDate(5),
        tags: ['integration', 'webhook', 'monitoring'],
        settings: {
          retryOnFailure: true,
          maxRetries: 3,
        },
      },
    ];

    for (const automationData of automationsData) {
      const existing = await this.automationRepository.findOne({
        where: {
          name: automationData.name,
          tenantId: automationData.tenantId,
        },
      });

      if (!existing) {
        const automation = this.automationRepository.create(automationData);
        await this.automationRepository.save(automation);
        console.log(
          `✅ Created automation: ${automationData.name} (${automationData.status})`,
        );
      } else {
        console.log(
          `⏭️  Automation already exists: ${automationData.name}`,
        );
      }
    }

    console.log('🎉 Automation seeding completed! (5 automations created)');
  }
}