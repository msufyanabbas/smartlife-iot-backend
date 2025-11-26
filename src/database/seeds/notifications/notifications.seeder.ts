import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationType,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '@modules/notifications/entities/notification.entity';
import { Notification, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class NotificationSeeder implements ISeeder {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
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

    // Helper function to generate past date
    const generatePastDate = (hoursAgo: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hoursAgo);
      return date;
    };

    const notifications = [
      {
        userId: users[0].id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.URGENT,
        status: NotificationStatus.READ,
        title: 'Critical Temperature Alert',
        message:
          'Temperature sensor in Server Room exceeded safe threshold (82.5°C)',
        htmlContent: `
          <div style="font-family: Arial, sans-serif;">
            <h2 style="color: #DC2626;">Critical Temperature Alert</h2>
            <p>Temperature sensor in <strong>Server Room</strong> exceeded safe threshold.</p>
            <p><strong>Current Temperature:</strong> 82.5°C</p>
            <p><strong>Threshold:</strong> 75°C</p>
            <p><strong>Device:</strong> Temperature Sensor #001</p>
            <p>Please investigate immediately.</p>
          </div>
        `,
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-temp-001',
        action: {
          label: 'View Alarm Details',
          url: '/alarms/alarm-temp-001',
          type: 'button' as const,
        },
        metadata: {
          deviceId: 'device-001',
          sensorType: 'temperature',
          threshold: 75,
          currentValue: 82.5,
        },
        recipientEmail: users[0].email,
        isRead: true,
        readAt: generatePastDate(1),
        sentAt: generatePastDate(2),
        deliveredAt: generatePastDate(2),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[0].id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.PUSH,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.DELIVERED,
        title: 'Device Offline',
        message: 'Gateway Device #A-205 has not reported data in 20 minutes',
        relatedEntityType: 'device',
        relatedEntityId: 'device-a-205',
        action: {
          label: 'Check Device Status',
          url: '/devices/device-a-205',
          type: 'link' as const,
        },
        metadata: {
          deviceId: 'device-a-205',
          lastSeen: generatePastDate(0.33),
          location: 'Warehouse A',
        },
        recipientDeviceToken: 'fcm-token-user1-device1',
        isRead: false,
        sentAt: generatePastDate(0.3),
        deliveredAt: generatePastDate(0.3),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[1]?.id || users[0].id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.SMS,
        priority: NotificationPriority.URGENT,
        status: NotificationStatus.SENT,
        title: 'Low Battery Warning',
        message: 'Battery level critically low (15%) on Sensor #B-102',
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-battery-001',
        metadata: {
          deviceId: 'device-b-102',
          batteryLevel: 15,
          threshold: 20,
        },
        recipientPhone: '+966501234567',
        isRead: false,
        sentAt: generatePastDate(0.5),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[0].id,
        type: NotificationType.SYSTEM,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.READ,
        title: 'System Maintenance Scheduled',
        message:
          'Scheduled system maintenance on November 10, 2025 from 02:00 AM to 04:00 AM',
        htmlContent: `
          <div>
            <h3>Scheduled Maintenance Notice</h3>
            <p>Our systems will undergo scheduled maintenance:</p>
            <ul>
              <li><strong>Date:</strong> November 10, 2025</li>
              <li><strong>Time:</strong> 02:00 AM - 04:00 AM (AST)</li>
              <li><strong>Expected Downtime:</strong> 2 hours</li>
            </ul>
            <p>During this time, you may experience intermittent service disruptions.</p>
          </div>
        `,
        action: {
          label: 'View Maintenance Schedule',
          url: '/system/maintenance',
          type: 'link' as const,
        },
        isRead: true,
        readAt: generatePastDate(12),
        scheduledFor: new Date('2025-11-10T02:00:00Z'),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[0].id,
        type: NotificationType.REPORT,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.DELIVERED,
        title: 'Weekly Device Performance Report',
        message: 'Your weekly device performance report is ready',
        htmlContent: `
          <div style="font-family: Arial, sans-serif;">
            <h2>Weekly Performance Report</h2>
            <p>Hi ${users[0].name},</p>
            <p>Your weekly device performance report for October 28 - November 3, 2025 is now available.</p>
            <h3>Summary:</h3>
            <ul>
              <li>Total Devices: 48</li>
              <li>Online Devices: 45 (93.75%)</li>
              <li>Offline Devices: 3 (6.25%)</li>
              <li>Alarms Triggered: 12</li>
              <li>Data Points Collected: 1,234,567</li>
            </ul>
          </div>
        `,
        action: {
          label: 'View Full Report',
          url: '/reports/weekly/2025-w44',
          type: 'button' as const,
        },
        metadata: {
          reportType: 'weekly_performance',
          weekNumber: 44,
          year: 2025,
        },
        recipientEmail: users[0].email,
        isRead: false,
        sentAt: generatePastDate(24),
        deliveredAt: generatePastDate(24),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[1]?.id || users[0].id,
        type: NotificationType.USER,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.READ,
        title: 'New Team Member Added',
        message: 'Sarah Johnson has been added to your team',
        relatedEntityType: 'user',
        relatedEntityId: 'user-sarah-johnson',
        action: {
          label: 'View Team',
          url: '/team/members',
          type: 'link' as const,
        },
        metadata: {
          newUserId: 'user-sarah-johnson',
          role: 'operator',
        },
        isRead: true,
        readAt: generatePastDate(48),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[0].id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.WEBHOOK,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.DELIVERED,
        title: 'Humidity Out of Range',
        message: 'Humidity sensor reading outside acceptable range (85.3%)',
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-humidity-001',
        metadata: {
          deviceId: 'device-c-301',
          humidity: 85.3,
          minThreshold: 30,
          maxThreshold: 70,
        },
        webhookUrl: 'https://hooks.example.com/iot-alerts',
        isRead: false,
        sentAt: generatePastDate(3),
        deliveredAt: generatePastDate(3),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: users[2]?.id || users[0].id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.READ,
        title: 'Device Firmware Update Available',
        message: 'Firmware version 2.5.0 is available for 12 of your devices',
        htmlContent: `
          <div>
            <h2>Firmware Update Available</h2>
            <p>A new firmware version is available for your devices:</p>
            <p><strong>Version:</strong> 2.5.0<br>
            <strong>Release Date:</strong> November 1, 2025<br>
            <strong>Devices Eligible:</strong> 12</p>
            <h3>What's New:</h3>
            <ul>
              <li>Improved battery efficiency</li>
              <li>Enhanced security features</li>
              <li>Bug fixes and stability improvements</li>
            </ul>
          </div>
        `,
        action: {
          label: 'Update Devices',
          url: '/devices/firmware-update',
          type: 'button' as const,
        },
        metadata: {
          firmwareVersion: '2.5.0',
          eligibleDevices: 12,
        },
        recipientEmail: users[2]?.email || users[0].email,
        isRead: true,
        readAt: generatePastDate(72),
        sentAt: generatePastDate(72),
        deliveredAt: generatePastDate(72),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.SYSTEM,
        channel: NotificationChannel.PUSH,
        priority: NotificationPriority.LOW,
        status: NotificationStatus.DELIVERED,
        title: 'Storage Usage Notice',
        message: 'Your storage usage is at 75% capacity',
        metadata: {
          storageUsed: 75,
          storageTotal: 100,
          unit: 'GB',
        },
        action: {
          label: 'Manage Storage',
          url: '/settings/storage',
          type: 'link' as const,
        },
        recipientDeviceToken: 'fcm-token-random-device',
        isRead: false,
        sentAt: generatePastDate(6),
        deliveredAt: generatePastDate(6),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.FAILED,
        title: 'Network Latency High',
        message: 'Network latency exceeds 500ms threshold',
        htmlContent:
          '<div><h2>Network Alert</h2><p>High latency detected on device network.</p></div>',
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-latency-001',
        recipientEmail: 'invalid-email@nonexistent-domain-xyz.com',
        isRead: false,
        sentAt: generatePastDate(4),
        failedAt: generatePastDate(4),
        errorMessage: 'SMTP error: Recipient email address not found',
        retryCount: 3,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.PENDING,
        title: 'Device Configuration Updated',
        message:
          'Configuration for Device #D-405 has been updated successfully',
        relatedEntityType: 'device',
        relatedEntityId: 'device-d-405',
        action: {
          label: 'View Device',
          url: '/devices/device-d-405',
          type: 'link' as const,
        },
        isRead: false,
        scheduledFor: new Date(Date.now() + 3600000), // 1 hour from now
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.REPORT,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.LOW,
        status: NotificationStatus.DELIVERED,
        title: 'Monthly Analytics Report',
        message: 'Your monthly analytics report for October 2025 is ready',
        htmlContent: `
          <div>
            <h2>Monthly Analytics Report - October 2025</h2>
            <p>Your comprehensive monthly analytics report is now available.</p>
            <h3>Key Metrics:</h3>
            <ul>
              <li>Total Uptime: 99.8%</li>
              <li>Data Processed: 15.2 TB</li>
              <li>Average Response Time: 245ms</li>
              <li>Critical Alerts: 8</li>
            </ul>
          </div>
        `,
        action: {
          label: 'Download Report',
          url: '/reports/monthly/2025-10/download',
          type: 'button' as const,
        },
        metadata: {
          reportType: 'monthly_analytics',
          month: 10,
          year: 2025,
        },
        recipientEmail: getRandomItem(users).email,
        isRead: false,
        sentAt: generatePastDate(168), // 1 week ago
        deliveredAt: generatePastDate(168),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.SMS,
        priority: NotificationPriority.URGENT,
        status: NotificationStatus.DELIVERED,
        title: 'CO2 Level Critical',
        message: 'CO2 levels exceed safe threshold (1250 ppm) in Server Room',
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-co2-001',
        metadata: {
          deviceId: 'device-co2-sensor-01',
          co2Level: 1250,
          threshold: 1000,
          location: 'Server Room',
        },
        recipientPhone: '+966509876543',
        isRead: false,
        sentAt: generatePastDate(0.2),
        deliveredAt: generatePastDate(0.2),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.USER,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.READ,
        title: 'Password Changed Successfully',
        message: 'Your password was changed on November 4, 2025',
        metadata: {
          changeDate: '2025-11-04T10:30:00Z',
          ipAddress: '192.168.1.100',
        },
        isRead: true,
        readAt: generatePastDate(48),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.SYSTEM,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.DELIVERED,
        title: 'Security Alert: New Login Detected',
        message: 'New login from unrecognized device',
        htmlContent: `
          <div style="font-family: Arial, sans-serif;">
            <h2 style="color: #F59E0B;">Security Alert</h2>
            <p>We detected a new login to your account from an unrecognized device.</p>
            <h3>Login Details:</h3>
            <ul>
              <li><strong>Date:</strong> November 5, 2025 at 3:45 PM</li>
              <li><strong>Device:</strong> Chrome on Windows</li>
              <li><strong>Location:</strong> Riyadh, Saudi Arabia</li>
              <li><strong>IP Address:</strong> 192.168.1.55</li>
            </ul>
            <p>If this was you, you can safely ignore this message. If you don't recognize this activity, please secure your account immediately.</p>
          </div>
        `,
        action: {
          label: 'Review Login Activity',
          url: '/security/sessions',
          type: 'button' as const,
        },
        metadata: {
          ipAddress: '192.168.1.55',
          device: 'Chrome on Windows',
          location: 'Riyadh, Saudi Arabia',
        },
        recipientEmail: getRandomItem(users).email,
        isRead: false,
        sentAt: generatePastDate(2),
        deliveredAt: generatePastDate(2),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.DEVICE,
        channel: NotificationChannel.WEBHOOK,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.DELIVERED,
        title: 'Memory Usage Critical',
        message: 'Device memory usage at 95.5% - immediate action required',
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-memory-001',
        metadata: {
          deviceId: 'device-edge-01',
          memoryUsage: 95.5,
          threshold: 90,
        },
        webhookUrl: 'https://monitoring.example.com/webhooks/alerts',
        isRead: false,
        sentAt: generatePastDate(1),
        deliveredAt: generatePastDate(1),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.REPORT,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.PENDING,
        title: 'Scheduled: Energy Consumption Report',
        message:
          'Your weekly energy consumption report will be generated and sent tomorrow',
        metadata: {
          reportType: 'energy_consumption',
          period: 'weekly',
        },
        recipientEmail: getRandomItem(users).email,
        isRead: false,
        scheduledFor: new Date(Date.now() + 86400000), // 1 day from now
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.SYSTEM,
        channel: NotificationChannel.PUSH,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.DELIVERED,
        title: 'Backup Completed Successfully',
        message: 'Daily backup completed at 02:00 AM',
        metadata: {
          backupSize: '2.5 GB',
          backupTime: '02:00:00',
          backupDate: '2025-11-06',
        },
        recipientDeviceToken: 'fcm-token-backup-notification',
        isRead: false,
        sentAt: generatePastDate(4),
        deliveredAt: generatePastDate(4),
        retryCount: 0,
        maxRetries: 3,
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.ALARM,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.HIGH,
        status: NotificationStatus.SENT,
        title: 'Vibration Anomaly Detected',
        message: 'Unusual vibration levels (75.5 Hz) detected on Machine A-12',
        htmlContent: `
          <div>
            <h2 style="color: #F59E0B;">Vibration Anomaly Alert</h2>
            <p>Unusual vibration levels detected on <strong>Machine A-12</strong>.</p>
            <p><strong>Current Reading:</strong> 75.5 Hz</p>
            <p><strong>Normal Range:</strong> 50-100 Hz</p>
            <p>Maintenance inspection recommended.</p>
          </div>
        `,
        relatedEntityType: 'alarm',
        relatedEntityId: 'alarm-vibration-001',
        action: {
          label: 'Schedule Maintenance',
          url: '/maintenance/schedule',
          type: 'button' as const,
        },
        recipientEmail: getRandomItem(users).email,
        isRead: false,
        sentAt: generatePastDate(0.5),
        retryCount: 0,
        maxRetries: 3,
        expiresAt: new Date(Date.now() + 604800000), // 7 days from now
      },
      {
        userId: getRandomItem(users).id,
        type: NotificationType.USER,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.LOW,
        status: NotificationStatus.READ,
        title: 'Profile Updated',
        message: 'Your profile information has been updated successfully',
        isRead: true,
        readAt: generatePastDate(96),
        retryCount: 0,
        maxRetries: 3,
      },
    ];

    for (const notificationData of notifications) {
      const notification = this.notificationRepository.create(notificationData);
      await this.notificationRepository.save(notification);
      console.log(
        `✅ Created notification: ${notificationData.title} (${notificationData.type} - ${notificationData.status})`,
      );
    }

    console.log('🎉 Notification seeding completed!');
  }
}
