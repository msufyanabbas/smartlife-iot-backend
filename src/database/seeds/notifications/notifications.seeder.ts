// src/database/seeds/notification/notification.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationType,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
} from '@common/enums/index.enum';
import { Notification, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class NotificationSeeder implements ISeeder {
  private readonly logger = new Logger(NotificationSeeder.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting notification seeding...');

    // Check if notifications already exist
    const existingNotifications = await this.notificationRepository.count();
    if (existingNotifications > 0) {
      this.logger.log(
        `⏭️  Notifications already seeded (${existingNotifications} records). Skipping...`,
      );
      return;
    }

    // Fetch users and tenants
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    this.logger.log(`📧 Seeding notifications for ${users.length} users...`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generatePastDate = (hoursAgo: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hoursAgo);
      return date;
    };

    const generateFutureDate = (hoursFromNow: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() + hoursFromNow);
      return date;
    };

    // ════════════════════════════════════════════════════════════════
    // NOTIFICATION DATA
    // ════════════════════════════════════════════════════════════════

    const notifications: Partial<Notification>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. CRITICAL ALARM - Temperature Alert
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
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

      // ════════════════════════════════════════════════════════════════
      // 2. DEVICE OFFLINE - Push Notification
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
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
          lastSeen: generatePastDate(0.33).toISOString(),
          location: 'Warehouse A',
        },
        recipientDeviceToken: 'fcm-token-user1-device1',
        isRead: false,
        sentAt: generatePastDate(0.3),
        deliveredAt: generatePastDate(0.3),
        retryCount: 0,
        maxRetries: 3,
      },

      // ════════════════════════════════════════════════════════════════
      // 3. LOW BATTERY - SMS
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
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

      // ════════════════════════════════════════════════════════════════
      // 4. SYSTEM MAINTENANCE - In-App
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
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

      // ════════════════════════════════════════════════════════════════
      // 5. WEEKLY REPORT - Email
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        type: NotificationType.REPORT,
        channel: NotificationChannel.EMAIL,
        priority: NotificationPriority.NORMAL,
        status: NotificationStatus.DELIVERED,
        title: 'Weekly Device Performance Report',
        message: 'Your weekly device performance report is ready',
        htmlContent: `
          <div style="font-family: Arial, sans-serif;">
            <h2>Weekly Performance Report</h2>
            <p>Hi ${users[0].name || 'User'},</p>
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

      // ════════════════════════════════════════════════════════════════
      // 6. USER NOTIFICATION - Team Member Added
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
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

      // ════════════════════════════════════════════════════════════════
      // 7. WEBHOOK NOTIFICATION - Humidity Alert
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
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

      // ════════════════════════════════════════════════════════════════
      // 8. FAILED NOTIFICATION (for testing retry)
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
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
        retryCount: 1,
        maxRetries: 3,
      },

      // ════════════════════════════════════════════════════════════════
      // 9. SCHEDULED NOTIFICATION (future)
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
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
        scheduledFor: generateFutureDate(1), // 1 hour from now
        retryCount: 0,
        maxRetries: 3,
      },

      // ════════════════════════════════════════════════════════════════
      // 10. EXPIRING NOTIFICATION (for cleanup testing)
      // ════════════════════════════════════════════════════════════════
      {
        userId: users[0].id,
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        type: NotificationType.SYSTEM,
        channel: NotificationChannel.IN_APP,
        priority: NotificationPriority.LOW,
        status: NotificationStatus.DELIVERED,
        title: 'Temporary Notification',
        message: 'This notification will expire in 24 hours',
        isRead: false,
        sentAt: generatePastDate(1),
        deliveredAt: generatePastDate(1),
        expiresAt: generateFutureDate(24), // Expires in 24 hours
        retryCount: 0,
        maxRetries: 3,
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL NOTIFICATIONS
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const notificationData of notifications) {
      try {
        const notification = this.notificationRepository.create(notificationData);
        await this.notificationRepository.save(notification);

        const statusTag =
          notification.status === NotificationStatus.READ
            ? '✅ READ'
            : notification.status === NotificationStatus.FAILED
              ? '❌ FAILED'
              : notification.status === NotificationStatus.PENDING
                ? '⏳ PENDING'
                : '📧 SENT';

        const priorityTag =
          notification.priority === NotificationPriority.URGENT
            ? '🚨 URGENT'
            : notification.priority === NotificationPriority.HIGH
              ? '⚠️  HIGH'
              : '📌 NORMAL';

        this.logger.log(
          `✅ Created: ${notification.title.substring(0, 40).padEnd(42)} | ${notification.channel.padEnd(8)} | ${priorityTag} | ${statusTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed notification '${notificationData.title}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      unread: notifications.filter((n) => !n.isRead).length,
      byType: {} as Record<string, number>,
      byChannel: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      byPriority: {} as Record<string, number>,
    };

    notifications.forEach((n) => {
      if (n.type) summary.byType[n.type] = (summary.byType[n.type] || 0) + 1;
      if (n.channel)
        summary.byChannel[n.channel] = (summary.byChannel[n.channel] || 0) + 1;
      if (n.status)
        summary.byStatus[n.status] = (summary.byStatus[n.status] || 0) + 1;
      if (n.priority)
        summary.byPriority[n.priority] = (summary.byPriority[n.priority] || 0) + 1;
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Notification seeding complete! Created ${createdCount}/${notifications.length} notifications.`,
    );
    this.logger.log('');
    this.logger.log('📊 Notification Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   Unread: ${summary.unread}`);
    this.logger.log('');
    this.logger.log('   By Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(15)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Channel:');
    Object.entries(summary.byChannel).forEach(([channel, count]) =>
      this.logger.log(`     - ${channel.padEnd(15)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Status:');
    Object.entries(summary.byStatus).forEach(([status, count]) =>
      this.logger.log(`     - ${status.padEnd(15)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Priority:');
    Object.entries(summary.byPriority).forEach(([priority, count]) =>
      this.logger.log(`     - ${priority.padEnd(15)}: ${count}`),
    );
  }
}