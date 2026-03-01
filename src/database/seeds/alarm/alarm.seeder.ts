// src/database/seeders/alarm.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlarmSeverity, AlarmCondition, AlarmStatus } from '@common/enums/index.enum';
import { Alarm, User, Device, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AlarmSeeder implements ISeeder {
  constructor(
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    console.log('🚨 Seeding alarms...');

    // Get first tenant
    const tenant = await this.tenantRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
    });

    if (!tenant) {
      console.log('⚠️  No tenants found. Please seed tenants first.');
      return;
    }

    // Get users from this tenant
    const users = await this.userRepository.find({
      where: { tenantId: tenant.id },
      take: 5,
    });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    // Get devices from this tenant
    const devices = await this.deviceRepository.find({
      where: { tenantId: tenant.id },
      take: 5,
      relations: ['customer'],
    });

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    const alarmsData = [
      // 1. CRITICAL - High Temperature (ACTIVE)
      {
        tenantId: tenant.id,
        customerId: devices[0]?.customerId,
        name: 'High Temperature Alert',
        description: 'Temperature exceeded safe operating threshold',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.ACTIVE,
        deviceId: devices[0]?.id,
        rule: {
          telemetryKey: 'temperature',
          condition: AlarmCondition.GREATER_THAN,
          value: 75,
          duration: 300,
        },
        currentValue: 82.5,
        message: 'Temperature is greater than 75°C. Current value: 82.5°C',
        triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        lastTriggeredAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
        triggerCount: 3,
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          sms: true,
          push: true,
        },
        recipients: {
          userIds: [users[0].id],
          emails: [users[0].email, 'alert@example.com'],
          phones: ['+966501234567'],
        },
        tags: ['temperature', 'critical', 'hardware'],
      },

      // 2. WARNING - Low Battery (ACKNOWLEDGED)
      {
        tenantId: tenant.id,
        customerId: devices[1]?.customerId || devices[0]?.customerId,
        name: 'Low Battery Warning',
        description: 'Device battery level is critically low',
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACKNOWLEDGED,
        deviceId: devices[1]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'battery',
          condition: AlarmCondition.LESS_THAN,
          value: 20,
          duration: 60,
        },
        currentValue: 15.2,
        message: 'Battery is less than 20%. Current value: 15.2%',
        triggeredAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
        lastTriggeredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        acknowledgedAt: new Date(Date.now() - 23 * 60 * 60 * 1000), // Ack'd 23h ago
        acknowledgedBy: users[0].id,
        triggerCount: 1,
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          push: true,
        },
        recipients: {
          userIds: [users[0].id],
          emails: [users[0].email],
        },
        tags: ['battery', 'power', 'warning'],
      },

      // 3. ERROR - Humidity Out of Range (CLEARED)
      {
        tenantId: tenant.id,
        customerId: devices[2]?.customerId || devices[0]?.customerId,
        name: 'Humidity Out of Range',
        description: 'Humidity levels outside acceptable range',
        severity: AlarmSeverity.ERROR,
        status: AlarmStatus.CLEARED,
        deviceId: devices[2]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'humidity',
          condition: AlarmCondition.OUTSIDE,
          value: 30,
          value2: 70,
          duration: 180,
        },
        currentValue: 85.3,
        message: 'Humidity is outside range 30-70%. Current value: 85.3%',
        triggeredAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days ago
        lastTriggeredAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        clearedAt: new Date(Date.now() - 46 * 60 * 60 * 1000), // Cleared 46h ago
        triggerCount: 2,
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
        },
        recipients: {
          userIds: [users[1]?.id || users[0].id],
          emails: [users[1]?.email || users[0].email],
        },
        tags: ['humidity', 'environment'],
      },

      // 4. CRITICAL - Device Offline (RESOLVED)
      {
        tenantId: tenant.id,
        customerId: devices[3]?.customerId || devices[0]?.customerId,
        name: 'Device Offline',
        description: 'Device has not reported data in expected timeframe',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.RESOLVED,
        deviceId: devices[3]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'lastSeen',
          condition: AlarmCondition.GREATER_THAN,
          value: 600,
          duration: 0,
        },
        currentValue: 1200,
        message: 'Device offline for 1200 seconds',
        triggeredAt: new Date(Date.now() - 72 * 60 * 60 * 1000), // 3 days ago
        lastTriggeredAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
        acknowledgedAt: new Date(Date.now() - 71 * 60 * 60 * 1000),
        acknowledgedBy: users[0].id,
        resolvedAt: new Date(Date.now() - 70 * 60 * 60 * 1000), // Resolved 70h ago
        resolvedBy: users[0].id,
        resolutionNote: 'Device was rebooted and came back online',
        triggerCount: 5,
        isEnabled: true,
        autoClear: false,
        notifications: {
          email: true,
          sms: true,
          push: true,
          webhook: 'https://webhook.site/alert',
        },
        recipients: {
          userIds: [users[0].id],
          emails: [users[0].email],
          phones: ['+966501234567'],
        },
        tags: ['connectivity', 'critical', 'offline'],
      },

      // 5. INFO - System Status (CLEARED)
      {
        tenantId: tenant.id,
        customerId: devices[4]?.customerId || devices[0]?.customerId,
        name: 'System Status Check',
        description: 'Info alarm for normal system status',
        severity: AlarmSeverity.INFO,
        status: AlarmStatus.CLEARED,
        deviceId: devices[4]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'status',
          condition: AlarmCondition.EQUAL,
          value: 1,
          duration: 0,
        },
        currentValue: 1,
        message: 'System status normal',
        triggeredAt: new Date(Date.now() - 96 * 60 * 60 * 1000), // 4 days ago
        lastTriggeredAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // Last trigger 1h ago
        clearedAt: new Date(Date.now() - 55 * 60 * 1000), // Cleared 55 min ago
        triggerCount: 10,
        isEnabled: true,
        autoClear: true,
        notifications: {
          push: true,
        },
        recipients: {
          userIds: [users[0].id],
        },
        tags: ['info', 'status'],
      },
    ];

    for (const alarmData of alarmsData) {
      const existing = await this.alarmRepository.findOne({
        where: {
          name: alarmData.name,
          tenantId: alarmData.tenantId,
        },
      });

      if (!existing) {
        const alarm = this.alarmRepository.create(alarmData);
        await this.alarmRepository.save(alarm);
        console.log(
          `✅ Created alarm: ${alarmData.name} (${alarmData.severity} - ${alarmData.status})`,
        );
      } else {
        console.log(`⏭️  Alarm already exists: ${alarmData.name}`);
      }
    }

    console.log('🎉 Alarm seeding completed! (5 alarms created)');
  }
}