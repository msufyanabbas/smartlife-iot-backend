import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AlarmSeverity,
  AlarmStatus,
  AlarmCondition,
} from '@modules/alarms/entities/alarm.entity';
import { Alarm, User, Device } from '@modules/index.entities';
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
  ) {}

  async seed(): Promise<void> {
    // Fetch all users and devices first
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 15 });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    if (devices.length === 0) {
      console.log('⚠️  No devices found. Please seed devices first.');
      return;
    }

    // Helper function to get random item from array
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    // Helper function to get multiple random items
    const getRandomItems = <T>(array: T[], count: number): T[] => {
      const shuffled = [...array].sort(() => 0.5 - Math.random());
      return shuffled.slice(0, Math.min(count, array.length));
    };

    const alarms = [
      {
        name: 'High Temperature Alert',
        description: 'Temperature exceeded safe operating threshold',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.ACTIVE,
        userId: users[0].id,
        deviceId: devices[0]?.id,
        rule: {
          telemetryKey: 'temperature',
          condition: AlarmCondition.GREATER_THAN,
          value: 75,
          duration: 300,
        },
        currentValue: 82.5,
        message: 'Temperature is greater than 75°C. Current value: 82.5°C',
        triggeredAt: new Date('2025-11-05T08:30:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          sms: true,
          push: true,
        },
        recipients: {
          userIds: getRandomItems(users, 2).map((u) => u.id),
          emails: [users[0].email, 'alert@example.com'],
          phones: ['+966501234567'],
        },
        triggerCount: 3,
        lastTriggeredAt: new Date('2025-11-05T08:30:00Z'),
        tags: ['temperature', 'critical', 'hardware'],
      },
      {
        name: 'Low Battery Warning',
        description: 'Device battery level is critically low',
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACKNOWLEDGED,
        userId: users[1]?.id || users[0].id,
        deviceId: devices[1]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'battery',
          condition: AlarmCondition.LESS_THAN,
          value: 20,
          duration: 60,
        },
        currentValue: 15.2,
        message: 'Battery is less than 20%. Current value: 15.2%',
        triggeredAt: new Date('2025-11-04T14:20:00Z'),
        acknowledgedAt: new Date('2025-11-04T14:45:00Z'),
        acknowledgedBy: users[0].id,
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          push: true,
        },
        recipients: {
          userIds: [users[1]?.id || users[0].id],
          emails: [users[1]?.email || users[0].email],
        },
        triggerCount: 1,
        lastTriggeredAt: new Date('2025-11-04T14:20:00Z'),
        tags: ['battery', 'power', 'warning'],
      },
      {
        name: 'Humidity Out of Range',
        description: 'Humidity levels outside acceptable range',
        severity: AlarmSeverity.ERROR,
        status: AlarmStatus.CLEARED,
        userId: users[2]?.id || users[0].id,
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
        triggeredAt: new Date('2025-11-03T10:15:00Z'),
        clearedAt: new Date('2025-11-03T12:30:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
        },
        recipients: {
          userIds: [users[2]?.id || users[0].id],
          emails: [users[2]?.email || users[0].email],
        },
        triggerCount: 2,
        lastTriggeredAt: new Date('2025-11-03T10:15:00Z'),
        tags: ['humidity', 'environment'],
      },
      {
        name: 'Device Offline',
        description: 'Device has not reported data in expected timeframe',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.RESOLVED,
        userId: users[0].id,
        deviceId: devices[3]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'lastSeen',
          condition: AlarmCondition.GREATER_THAN,
          value: 600,
          duration: 0,
        },
        currentValue: 1200,
        message: 'Device offline for 1200 seconds',
        triggeredAt: new Date('2025-11-02T16:00:00Z'),
        acknowledgedAt: new Date('2025-11-02T16:15:00Z'),
        acknowledgedBy: users[0].id,
        resolvedAt: new Date('2025-11-02T17:30:00Z'),
        resolvedBy: users[0].id,
        resolutionNote: 'Device was rebooted and came back online',
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
        triggerCount: 5,
        lastTriggeredAt: new Date('2025-11-02T16:00:00Z'),
        tags: ['connectivity', 'critical', 'offline'],
      },
      {
        name: 'Pressure Threshold Exceeded',
        description: 'System pressure exceeded maximum safe limit',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.ACTIVE,
        userId: getRandomItem(users).id,
        deviceId: devices[4]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'pressure',
          condition: AlarmCondition.GREATER_THAN_OR_EQUAL,
          value: 100,
          duration: 120,
        },
        currentValue: 105.8,
        message:
          'Pressure is greater than or equal to 100 PSI. Current value: 105.8 PSI',
        triggeredAt: new Date('2025-11-05T09:00:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          sms: true,
          push: true,
        },
        recipients: {
          userIds: getRandomItems(users, 2).map((u) => u.id),
          emails: getRandomItems(users, 2)
            .map((u) => u.email)
            .concat(['safety@example.com']),
          phones: ['+966501234567', '+966501234568'],
        },
        triggerCount: 1,
        lastTriggeredAt: new Date('2025-11-05T09:00:00Z'),
        tags: ['pressure', 'safety', 'critical'],
      },
      {
        name: 'Normal Operation Check',
        description: 'Info alarm for normal system status',
        severity: AlarmSeverity.INFO,
        status: AlarmStatus.CLEARED,
        userId: getRandomItem(users).id,
        deviceId: devices[5]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'status',
          condition: AlarmCondition.EQUAL,
          value: 1,
          duration: 0,
        },
        currentValue: 1,
        message: 'System status normal',
        triggeredAt: new Date('2025-11-01T08:00:00Z'),
        clearedAt: new Date('2025-11-01T08:05:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: false,
          push: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
        },
        triggerCount: 10,
        lastTriggeredAt: new Date('2025-11-05T08:00:00Z'),
        tags: ['info', 'status'],
      },
      {
        name: 'Vibration Anomaly',
        description: 'Unusual vibration levels detected',
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACTIVE,
        userId: getRandomItem(users).id,
        deviceId: devices[6]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'vibration',
          condition: AlarmCondition.BETWEEN,
          value: 50,
          value2: 100,
          duration: 60,
        },
        currentValue: 75.5,
        message: 'Vibration is between 50-100 Hz. Current value: 75.5 Hz',
        triggeredAt: new Date('2025-11-05T07:30:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
          emails: ['maintenance@example.com'],
        },
        triggerCount: 2,
        lastTriggeredAt: new Date('2025-11-05T07:30:00Z'),
        tags: ['vibration', 'mechanical', 'maintenance'],
        metadata: {
          sensor: 'accelerometer-01',
          location: 'motor-assembly',
        },
      },
      {
        name: 'Network Latency High',
        description: 'Network response time exceeds acceptable threshold',
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACKNOWLEDGED,
        userId: getRandomItem(users).id,
        deviceId: devices[7]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'latency',
          condition: AlarmCondition.GREATER_THAN,
          value: 500,
          duration: 300,
        },
        currentValue: 750,
        message: 'Latency is greater than 500ms. Current value: 750ms',
        triggeredAt: new Date('2025-11-04T18:00:00Z'),
        acknowledgedAt: new Date('2025-11-04T18:10:00Z'),
        acknowledgedBy: getRandomItem(users).id,
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          push: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
          emails: ['network@example.com'],
        },
        triggerCount: 4,
        lastTriggeredAt: new Date('2025-11-04T18:00:00Z'),
        tags: ['network', 'performance', 'latency'],
      },
      {
        name: 'CO2 Level Alert',
        description: 'Carbon dioxide levels exceed safe threshold',
        severity: AlarmSeverity.ERROR,
        status: AlarmStatus.ACTIVE,
        userId: getRandomItem(users).id,
        deviceId: devices[8]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'co2',
          condition: AlarmCondition.GREATER_THAN,
          value: 1000,
          duration: 180,
        },
        currentValue: 1250,
        message: 'CO2 is greater than 1000 ppm. Current value: 1250 ppm',
        triggeredAt: new Date('2025-11-05T10:15:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
          sms: true,
          push: true,
        },
        recipients: {
          userIds: getRandomItems(users, 2).map((u) => u.id),
          emails: ['safety@example.com', users[0].email],
          phones: ['+966501234567'],
        },
        triggerCount: 1,
        lastTriggeredAt: new Date('2025-11-05T10:15:00Z'),
        tags: ['air-quality', 'co2', 'safety'],
        metadata: {
          room: 'server-room-01',
          floor: 3,
        },
      },
      {
        name: 'Power Consumption Spike',
        description: 'Unusual increase in power consumption detected',
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.CLEARED,
        userId: getRandomItem(users).id,
        deviceId: devices[9]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'power',
          condition: AlarmCondition.GREATER_THAN,
          value: 500,
          duration: 120,
        },
        currentValue: 650,
        message: 'Power is greater than 500W. Current value: 650W',
        triggeredAt: new Date('2025-11-04T12:00:00Z'),
        clearedAt: new Date('2025-11-04T13:30:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          email: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
          emails: ['energy@example.com'],
        },
        triggerCount: 3,
        lastTriggeredAt: new Date('2025-11-04T12:00:00Z'),
        tags: ['power', 'energy', 'consumption'],
      },
      {
        name: 'Memory Usage Critical',
        description: 'Device memory usage at critical level',
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.RESOLVED,
        userId: getRandomItem(users).id,
        deviceId: devices[10]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'memoryUsage',
          condition: AlarmCondition.GREATER_THAN_OR_EQUAL,
          value: 90,
          duration: 300,
        },
        currentValue: 95.5,
        message:
          'Memory usage is greater than or equal to 90%. Current value: 95.5%',
        triggeredAt: new Date('2025-11-03T15:00:00Z'),
        acknowledgedAt: new Date('2025-11-03T15:05:00Z'),
        acknowledgedBy: getRandomItem(users).id,
        resolvedAt: new Date('2025-11-03T16:00:00Z'),
        resolvedBy: getRandomItem(users).id,
        resolutionNote: 'Cleared cache and restarted services',
        isEnabled: true,
        autoClear: false,
        notifications: {
          email: true,
          push: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
          emails: ['devops@example.com'],
        },
        triggerCount: 2,
        lastTriggeredAt: new Date('2025-11-03T15:00:00Z'),
        tags: ['memory', 'performance', 'system'],
      },
      {
        name: 'Signal Strength Low',
        description: 'Wireless signal strength below acceptable level',
        severity: AlarmSeverity.INFO,
        status: AlarmStatus.ACTIVE,
        userId: getRandomItem(users).id,
        deviceId: devices[11]?.id || devices[0]?.id,
        rule: {
          telemetryKey: 'signalStrength',
          condition: AlarmCondition.LESS_THAN_OR_EQUAL,
          value: -70,
          duration: 60,
        },
        currentValue: -75,
        message:
          'Signal strength is less than or equal to -70 dBm. Current value: -75 dBm',
        triggeredAt: new Date('2025-11-05T11:00:00Z'),
        isEnabled: true,
        autoClear: true,
        notifications: {
          push: true,
        },
        recipients: {
          userIds: [getRandomItem(users).id],
        },
        triggerCount: 8,
        lastTriggeredAt: new Date('2025-11-05T11:00:00Z'),
        tags: ['signal', 'connectivity', 'wireless'],
        metadata: {
          protocol: 'WiFi',
          frequency: '2.4GHz',
        },
      },
    ];

    for (const alarmData of alarms) {
      const existing = await this.alarmRepository.findOne({
        where: { name: alarmData.name, userId: alarmData.userId },
      });

      if (!existing) {
        const alarm = this.alarmRepository.create(alarmData);
        await this.alarmRepository.save(alarm);
        console.log(
          `✅ Created alarm: ${alarmData.name} (${alarmData.severity})`,
        );
      } else {
        console.log(`⏭️  Alarm already exists: ${alarmData.name}`);
      }
    }

    console.log('🎉 Alarm seeding completed!');
  }
}
