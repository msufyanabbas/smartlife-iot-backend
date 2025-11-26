import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Automation, User, Device, Tenant } from '@modules/index.entities';
import {
  TriggerType,
  ActionType,
  AutomationStatus,
} from '../../../modules/automation/entities/automation.entity';
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
  ) {}

  async seed(): Promise<void> {
    // Fetch entities
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 15 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    // Helper functions
    const getRandomItem = <T>(array: T[]): T | undefined => {
      return array.length > 0
        ? array[Math.floor(Math.random() * array.length)]
        : undefined;
    };

    const getRandomDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(
        Math.floor(Math.random() * 24),
        Math.floor(Math.random() * 60),
        Math.floor(Math.random() * 60),
      );
      return date;
    };

    const automations: Partial<Automation>[] = [
      // Temperature Control Automations
      {
        name: 'Turn on AC when temperature is high',
        description:
          'Automatically turn on air conditioning when temperature exceeds 28°C',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[0]?.id,
          attribute: 'temperature',
          operator: 'gt',
          value: 28,
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[1]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: Math.floor(Math.random() * 50) + 10,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 7)),
        status: AutomationStatus.ACTIVE,
        userId: users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Turn off heater when temperature is comfortable',
        description: 'Turn off heating when temperature reaches 22°C',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[0]?.id,
          attribute: 'temperature',
          operator: 'gte',
          value: 22,
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[2]?.id || devices[0]?.id,
          command: 'turnOff',
        },
        executionCount: Math.floor(Math.random() * 30) + 5,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 5)),
        status: AutomationStatus.ACTIVE,
        userId: users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Lighting Automations
      {
        name: 'Turn on lights at sunset',
        description: 'Automatically turn on outdoor lights at 6:00 PM',
        enabled: true,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 18 * * *', // Cron: 6:00 PM daily
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[3]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: Math.floor(Math.random() * 100) + 30,
        lastTriggered: getRandomDate(1),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Turn off lights at sunrise',
        description: 'Automatically turn off outdoor lights at 6:00 AM',
        enabled: true,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 6 * * *', // Cron: 6:00 AM daily
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[3]?.id || devices[0]?.id,
          command: 'turnOff',
        },
        executionCount: Math.floor(Math.random() * 100) + 30,
        lastTriggered: getRandomDate(0),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Motion-activated lighting',
        description: 'Turn on lights when motion is detected',
        enabled: true,
        trigger: {
          type: TriggerType.STATE,
          device: devices[4]?.id || devices[0]?.id,
          attribute: 'motion',
          operator: 'eq',
          value: true,
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[3]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: Math.floor(Math.random() * 200) + 50,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 3)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Security Automations
      {
        name: 'Security alert on door open',
        description: 'Send notification when door is opened after hours',
        enabled: true,
        trigger: {
          type: TriggerType.STATE,
          device: devices[5]?.id || devices[0]?.id,
          attribute: 'doorStatus',
          operator: 'eq',
          value: 'open',
        },
        action: {
          type: ActionType.NOTIFICATION,
          target: 'security-team',
          command: 'sendNotification',
          message: 'Door opened after hours - security alert',
        },
        executionCount: Math.floor(Math.random() * 20) + 2,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 10)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Lock doors at night',
        description: 'Automatically lock all doors at 11:00 PM',
        enabled: true,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 23 * * *', // Cron: 11:00 PM daily
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[5]?.id || devices[0]?.id,
          command: 'lock',
        },
        executionCount: Math.floor(Math.random() * 90) + 30,
        lastTriggered: getRandomDate(0),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Energy Management
      {
        name: 'Power saver mode',
        description: 'Reduce power consumption during peak hours',
        enabled: true,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 14 * * *', // Cron: 2:00 PM daily (peak hours)
        },
        action: {
          type: ActionType.SET_VALUE,
          target: devices[6]?.id || devices[0]?.id,
          command: 'setPowerMode',
          value: 'eco',
        },
        executionCount: Math.floor(Math.random() * 60) + 20,
        lastTriggered: getRandomDate(1),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'High power consumption alert',
        description: 'Send alert when power consumption exceeds 500W',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[6]?.id || devices[0]?.id,
          attribute: 'power',
          operator: 'gt',
          value: 500,
        },
        action: {
          type: ActionType.NOTIFICATION,
          target: 'energy-manager',
          command: 'sendNotification',
          message: 'High power consumption detected - exceeds 500W',
        },
        executionCount: Math.floor(Math.random() * 15) + 3,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 5)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Environmental Controls
      {
        name: 'Humidity control',
        description: 'Turn on dehumidifier when humidity exceeds 70%',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[7]?.id || devices[0]?.id,
          attribute: 'humidity',
          operator: 'gt',
          value: 70,
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[8]?.id || devices[0]?.id,
          command: 'turnOn',
        },
        executionCount: Math.floor(Math.random() * 40) + 10,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 4)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Air quality alert',
        description: 'Send notification when CO2 levels are high',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[8]?.id || devices[0]?.id,
          attribute: 'co2',
          operator: 'gt',
          value: 1000,
        },
        action: {
          type: ActionType.NOTIFICATION,
          target: 'facility-manager',
          command: 'sendNotification',
          message: 'CO2 levels exceed safe threshold - improve ventilation',
        },
        executionCount: Math.floor(Math.random() * 10) + 1,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 7)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Webhook Integrations
      {
        name: 'Update external system on device state change',
        description: 'Send webhook to external API when device status changes',
        enabled: true,
        trigger: {
          type: TriggerType.STATE,
          device: devices[9]?.id || devices[0]?.id,
          attribute: 'status',
          operator: 'eq',
          value: 'offline',
        },
        action: {
          type: ActionType.WEBHOOK,
          target: 'external-api',
          command: 'postWebhook',
          url: 'https://api.example.com/device-status',
        },
        executionCount: Math.floor(Math.random() * 25) + 5,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 6)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Scheduled Maintenance
      {
        name: 'Weekly maintenance reminder',
        description: 'Send maintenance reminder every Monday at 9:00 AM',
        enabled: true,
        trigger: {
          type: TriggerType.SCHEDULE,
          schedule: '0 9 * * 1', // Cron: 9:00 AM every Monday
        },
        action: {
          type: ActionType.NOTIFICATION,
          target: 'maintenance-team',
          command: 'sendNotification',
          message: 'Weekly maintenance check due',
        },
        executionCount: Math.floor(Math.random() * 20) + 4,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 7)),
        status: AutomationStatus.ACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Inactive/Error Automations
      {
        name: 'Disabled test automation',
        description: 'Test automation that is currently disabled',
        enabled: false,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: devices[10]?.id || devices[0]?.id,
          attribute: 'test',
          operator: 'gt',
          value: 100,
        },
        action: {
          type: ActionType.CONTROL,
          target: devices[10]?.id || devices[0]?.id,
          command: 'test',
        },
        executionCount: 0,
        status: AutomationStatus.INACTIVE,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      {
        name: 'Failed automation',
        description: 'Automation with error state due to missing device',
        enabled: true,
        trigger: {
          type: TriggerType.THRESHOLD,
          device: 'non-existent-device-id',
          attribute: 'temperature',
          operator: 'gt',
          value: 50,
        },
        action: {
          type: ActionType.CONTROL,
          target: 'non-existent-target-id',
          command: 'turnOff',
        },
        executionCount: 5,
        lastTriggered: getRandomDate(Math.floor(Math.random() * 3)),
        status: AutomationStatus.ERROR,
        userId: getRandomItem(users)?.id || users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
      // Event-based Automations
      {
        name: 'Emergency shutdown protocol',
        description: 'Trigger emergency shutdown on fire alarm',
        enabled: true,
        trigger: {
          type: TriggerType.EVENT,
          device: devices[11]?.id || devices[0]?.id,
          attribute: 'fireAlarm',
          operator: 'eq',
          value: true,
        },
        action: {
          type: ActionType.CONTROL,
          target: 'all-devices',
          command: 'emergencyShutdown',
        },
        executionCount: 0,
        status: AutomationStatus.ACTIVE,
        userId: users[0].id,
        tenantId: getRandomItem(tenants)?.id,
      },
    ];

    let created = 0;
    let skipped = 0;

    for (const automationData of automations) {
      const existing = await this.automationRepository.findOne({
        where: { name: automationData.name, userId: automationData.userId },
      });

      if (!existing) {
        const automation = this.automationRepository.create(automationData);
        await this.automationRepository.save(automation);
        console.log(
          `✅ Created automation: ${automationData.name} (${automationData.status})`,
        );
        created++;
      } else {
        console.log(`⏭️  Automation already exists: ${automationData.name}`);
        skipped++;
      }
    }

    console.log(`\n📊 Summary: ${created} created, ${skipped} skipped`);
    console.log('🎉 Automation seeding completed!');
  }
}
