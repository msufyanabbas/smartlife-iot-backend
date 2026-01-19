// src/database/seeders/notification.seeder.ts
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
    // ✅ Fetch users with tenant and customer information
    const users = await this.userRepository.find({
      take: 10,
      relations: ['tenant', 'customer'], // Load relations
    });

    if (users.length === 0) {
      console.log('⚠️  No users found. Please seed users first.');
      return;
    }

    console.log(`📧 Seeding notifications for ${users.length} users...`);

    // Helper functions
    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generatePastDate = (hoursAgo: number): Date => {
      const date = new Date();
      date.setHours(date.getHours() - hoursAgo);
      return date;
    };

    // ✅ Organize users by role for better testing
    const tenantAdmins = users.filter((u) => u.role === 'tenant_admin');
    const customerAdmins = users.filter((u) => u.role === 'customer_admin');
    const customerUsers = users.filter((u) => u.role === 'customer_user');
    const regularUsers = users.filter(
      (u) => u.role === 'user' || u.role === 'tenant_admin',
    );

    console.log(
      `👥 User distribution: ${tenantAdmins.length} tenant admins, ${customerAdmins.length} customer admins, ${customerUsers.length} customer users`,
    );

    const notifications = [
      // ============================================
      // CRITICAL ALARMS - Multiple users
      // ============================================
      {
        userId: users[0].id,
        tenantId: users[0].tenantId, // ✅ Required
        customerId: users[0].customerId, // ✅ Can be null
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
        tenantId: users[0].tenantId,
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
        tenantId: users[1]?.tenantId || users[0].tenantId,
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

      // ============================================
      // SYSTEM NOTIFICATIONS
      // ============================================
      {
        userId: users[0].id,
        tenantId: users[0].tenantId,
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

      // ============================================
      // REPORTS
      // ============================================
      {
        userId: users[0].id,
        tenantId: users[0].tenantId,
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

      // ============================================
      // USER NOTIFICATIONS
      // ============================================
      {
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
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

      // ============================================
      // WEBHOOK NOTIFICATIONS
      // ============================================
      {
        userId: users[0].id,
        tenantId: users[0].tenantId,
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

      // ============================================
      // FAILED NOTIFICATION (for testing retry)
      // ============================================
      {
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        customerId: getRandomItem(users).customerId,
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
        retryCount: 1, // ✅ Has retries remaining
        maxRetries: 3,
      },

      // ============================================
      // SCHEDULED NOTIFICATION (future)
      // ============================================
      {
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
        customerId: getRandomItem(users).customerId,
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
    ];

    // ✅ Generate random notifications for remaining users
    const additionalNotifications: any = [];
    
    for (let i = 0; i < Math.min(10, users.length); i++) {
      const user = getRandomItem(users);
      
      additionalNotifications.push({
        userId: user.id,
        tenantId: user.tenantId,
        customerId: user.customerId,
        type: getRandomItem(Object.values(NotificationType)),
        channel: NotificationChannel.IN_APP,
        priority: getRandomItem(Object.values(NotificationPriority)),
        status: getRandomItem([
          NotificationStatus.DELIVERED,
          NotificationStatus.READ,
        ]),
        title: `Random Notification ${i + 1}`,
        message: `This is a test notification for ${user.name}`,
        isRead: Math.random() > 0.5,
        readAt: Math.random() > 0.5 ? generatePastDate(24) : null,
        sentAt: generatePastDate(Math.floor(Math.random() * 72)),
        deliveredAt: generatePastDate(Math.floor(Math.random() * 72)),
        retryCount: 0,
        maxRetries: 3,
      });
    }

    const allNotifications = [...notifications, ...additionalNotifications];

    // ✅ Save all notifications
    let created = 0;
    for (const notificationData of allNotifications) {
      try {
        const notification =
          this.notificationRepository.create(notificationData);
        await this.notificationRepository.save(notification);
        created++;
        
        if (created % 5 === 0) {
          console.log(`   📧 Created ${created}/${allNotifications.length} notifications...`);
        }
      } catch (error) {
        console.error(
          `❌ Failed to create notification: ${notificationData.title}`,
          error.message,
        );
      }
    }

    console.log(`\n✅ Successfully created ${created} notifications!`);
    console.log(`\n📊 Notification Breakdown:`);
    
    // Print statistics
    const stats = {
      total: created,
      unread: allNotifications.filter((n) => !n.isRead).length,
      byType: {} as Record<string, number>,
      byChannel: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
    };

    allNotifications.forEach((n) => {
      stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
      stats.byChannel[n.channel] = (stats.byChannel[n.channel] || 0) + 1;
      stats.byStatus[n.status] = (stats.byStatus[n.status] || 0) + 1;
    });

    console.log(`   Total: ${stats.total}`);
    console.log(`   Unread: ${stats.unread}`);
    console.log(`   By Type:`, stats.byType);
    console.log(`   By Channel:`, stats.byChannel);
    console.log(`   By Status:`, stats.byStatus);
    
    console.log('\n🎉 Notification seeding completed!');
  }
}