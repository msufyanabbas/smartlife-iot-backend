// src/database/seeds/automation/automation.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Automation,
  User,
  Device,
  Tenant,
  Customer,
} from '@modules/index.entities';
import {
  AutomationStatus,
  AutomationTriggerType,
  AutomationActionType,
  AutomationConditionOperator,
  AutomationConditionSource,
} from '@common/enums/index.enum';
import { ISeeder } from '../seeder.interface';

/**
 * Seeds four reference automations, one per trigger family.
 *
 * All are seeded DISABLED: they watch every device in the tenant (no
 * trigger.deviceId), so enabling them by default would have a freshly seeded
 * environment firing notifications and raising alarms on the first telemetry
 * frame. Enable one with POST /automations/:id/toggle.
 */
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

    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });
    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    const user = await this.userRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });
    if (!user) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    const customer = await this.customerRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    const base = {
      tenantId: tenant.id,
      customerId: customer?.id,
      userId: user.id,
      enabled: false,
      status: AutomationStatus.INACTIVE,
    };

    const automationsData: Partial<Automation>[] = [
      // 1. TELEMETRY trigger -> notification + alarm
      {
        ...base,
        name: 'High Temperature Alert',
        description: 'Send notification and raise an alarm when temperature exceeds 40 C',
        trigger: {
          type: AutomationTriggerType.TELEMETRY,
          telemetryKey: 'temperature',
        },
        conditions: [
          {
            key: 'temperature',
            operator: AutomationConditionOperator.GT,
            value: 40,
            type: AutomationConditionSource.TELEMETRY,
            logic: 'AND',
          },
        ],
        actions: [
          {
            type: AutomationActionType.SEND_NOTIFICATION,
            order: 1,
            config: {
              title: '🌡️ High Temperature Alert',
              message:
                'Temperature sensor reading: {{telemetry.temperature}}°C exceeded threshold of 40°C',
              channels: ['in_app', 'email'],
            },
          },
          {
            type: AutomationActionType.CREATE_ALARM,
            order: 2,
            config: {
              alarmName: 'High Temperature',
              severity: 'critical',
            },
          },
        ],
        settings: { cooldown: 300 },
        tags: ['temperature', 'alert'],
      },

      // 2. DEVICE_STATUS trigger -> notification
      {
        ...base,
        name: 'Device Offline Alert',
        description: 'Send notification when any device goes offline',
        trigger: {
          type: AutomationTriggerType.DEVICE_STATUS,
          targetStatus: 'offline',
        },
        conditions: [],
        actions: [
          {
            type: AutomationActionType.SEND_NOTIFICATION,
            order: 1,
            config: {
              title: '📴 Device Offline',
              message: 'Device {{device.name}} has gone offline',
              channels: ['in_app'],
            },
          },
        ],
        tags: ['monitoring', 'offline'],
      },

      // 3. TELEMETRY trigger -> notification
      {
        ...base,
        name: 'Low Battery Warning',
        description: 'Alert when battery level drops below 20%',
        trigger: {
          type: AutomationTriggerType.TELEMETRY,
          telemetryKey: 'battery',
        },
        conditions: [
          {
            key: 'battery',
            operator: AutomationConditionOperator.LT,
            value: 20,
            type: AutomationConditionSource.TELEMETRY,
            logic: 'AND',
          },
        ],
        actions: [
          {
            type: AutomationActionType.SEND_NOTIFICATION,
            order: 1,
            config: {
              title: '🔋 Low Battery Warning',
              message:
                'Battery level is {{telemetry.battery}}% — please replace battery',
              channels: ['in_app'],
            },
          },
        ],
        settings: { cooldown: 3600, maxExecutionsPerDay: 5 },
        tags: ['battery', 'maintenance'],
      },

      // 4. ALARM trigger -> webhook
      {
        ...base,
        name: 'Webhook on Critical Alarm',
        description: 'Send webhook when a critical alarm is created',
        trigger: {
          type: AutomationTriggerType.ALARM,
          alarmSeverity: 'critical',
        },
        conditions: [],
        actions: [
          {
            type: AutomationActionType.WEBHOOK,
            order: 1,
            config: {
              url: 'https://webhook.site/your-id',
              method: 'POST',
              body: {
                alarm: '{{alarm.name}}',
                severity: '{{alarm.severity}}',
                deviceId: '{{alarm.deviceId}}',
              },
            },
          },
        ],
        tags: ['integration', 'webhook'],
      },
    ];

    let created = 0;
    for (const data of automationsData) {
      const existing = await this.automationRepository.findOne({
        where: { name: data.name, tenantId: data.tenantId },
      });

      if (existing) {
        console.log(`⏭️  Automation already exists: ${data.name}`);
        continue;
      }

      await this.automationRepository.save(
        this.automationRepository.create(data),
      );
      created++;
      console.log(`✅ Created automation: ${data.name} (disabled)`);
    }

    console.log(
      `🎉 Automation seeding completed! (${created} created, ` +
        `${automationsData.length - created} already present)`,
    );
  }
}
