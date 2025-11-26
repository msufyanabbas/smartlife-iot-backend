import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditAction,
  AuditEntityType,
  AuditSeverity,
} from '@modules/audit/entities/audit-log.entity';
import { User, Device, Alarm, Tenant, AuditLog } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class AuditLogSeeder implements ISeeder {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async seed(): Promise<void> {
    // Fetch entities
    const users = await this.userRepository.find({ take: 10 });
    const devices = await this.deviceRepository.find({ take: 10 });
    const alarms = await this.alarmRepository.find({ take: 5 });
    const tenants = await this.tenantRepository.find({ take: 3 });

    if (users.length === 0) {
      console.log(
        '⚠️  No users found. Creating audit logs without user associations.',
      );
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

    const ipAddresses = [
      '192.168.1.100',
      '192.168.1.105',
      '10.0.0.50',
      '172.16.0.25',
      '203.0.113.45',
      '198.51.100.89',
    ];

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'PostmanRuntime/7.32.3',
    ];

    const auditLogs: Partial<AuditLog>[] = [];

    // User-related audit logs
    for (const user of users.slice(0, 5)) {
      const tenant = getRandomItem(tenants);

      // Login
      auditLogs.push({
        userId: user.id,
        userName: `${user.name}`,
        userEmail: user.email,
        action: AuditAction.LOGIN,
        entityType: AuditEntityType.USER,
        entityId: user.id,
        entityName: user.email,
        description: `User logged in successfully`,
        metadata: {
          method: 'email',
          rememberMe: Math.random() > 0.5,
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 30)),
        success: true,
        tenantId: tenant?.id,
      });

      // Failed login attempts (occasionally)
      if (Math.random() > 0.7) {
        auditLogs.push({
          userId: user.id,
          userName: `${user.name}`,
          userEmail: user.email,
          action: AuditAction.LOGIN,
          entityType: AuditEntityType.USER,
          entityId: user.id,
          entityName: user.email,
          description: `Failed login attempt`,
          metadata: {
            reason: 'Invalid password',
            attemptCount: Math.floor(Math.random() * 3) + 1,
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.WARNING,
          timestamp: getRandomDate(Math.floor(Math.random() * 30)),
          success: false,
          errorMessage: 'Invalid credentials',
          tenantId: tenant?.id,
        });
      }

      // Password change
      if (Math.random() > 0.6) {
        auditLogs.push({
          userId: user.id,
          userName: `${user.name}`,
          userEmail: user.email,
          action: AuditAction.PASSWORD_CHANGE,
          entityType: AuditEntityType.USER,
          entityId: user.id,
          entityName: user.email,
          description: `User changed their password`,
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(Math.floor(Math.random() * 60)),
          success: true,
          tenantId: tenant?.id,
        });
      }

      // User update
      auditLogs.push({
        userId: user.id,
        userName: `${user.name}`,
        userEmail: user.email,
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.USER,
        entityId: user.id,
        entityName: user.email,
        description: `User profile updated`,
        changes: {
          before: {
            firstName: user.name,
            phoneNumber: '+966501234567',
          },
          after: {
            firstName: user.name,
            phoneNumber: '+966509876543',
          },
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 45)),
        success: true,
        tenantId: tenant?.id,
      });

      // Logout
      auditLogs.push({
        userId: user.id,
        userName: `${user.name}`,
        userEmail: user.email,
        action: AuditAction.LOGOUT,
        entityType: AuditEntityType.USER,
        entityId: user.id,
        entityName: user.email,
        description: `User logged out`,
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 30)),
        success: true,
        tenantId: tenant?.id,
      });
    }

    // Device-related audit logs
    for (const device of devices.slice(0, 8)) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      // Device creation
      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name}` : undefined,
        userEmail: user?.email,
        action: AuditAction.CREATE,
        entityType: AuditEntityType.DEVICE,
        entityId: device.id,
        entityName: device.name,
        description: `Device created`,
        metadata: {
          deviceType: device.type,
          protocol: 'MQTT',
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 90)),
        success: true,
        tenantId: tenant?.id || device.tenantId,
      });

      // Device connect
      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name} ` : undefined,
        userEmail: user?.email,
        action: AuditAction.DEVICE_CONNECT,
        entityType: AuditEntityType.DEVICE,
        entityId: device.id,
        entityName: device.name,
        description: `Device connected to the platform`,
        metadata: {
          protocol: 'MQTT',
          clientId: `device-${device.id}`,
          keepAlive: 60,
        },
        ipAddress: getRandomItem(ipAddresses),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 7)),
        success: true,
        tenantId: tenant?.id || device.tenantId,
      });

      // Device update
      if (Math.random() > 0.5) {
        auditLogs.push({
          userId: user?.id,
          userName: user ? `${user.name} ` : undefined,
          userEmail: user?.email,
          action: AuditAction.UPDATE,
          entityType: AuditEntityType.DEVICE,
          entityId: device.id,
          entityName: device.name,
          description: `Device configuration updated`,
          changes: {
            before: {
              status: 'inactive',
              firmware: 'v1.0.0',
            },
            after: {
              status: 'active',
              firmware: 'v1.1.0',
            },
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(Math.floor(Math.random() * 30)),
          success: true,
          tenantId: tenant?.id || device.tenantId,
        });
      }

      // Device disconnect (occasionally)
      if (Math.random() > 0.6) {
        auditLogs.push({
          userId: user?.id,
          userName: user ? `${user.name} ` : undefined,
          userEmail: user?.email,
          action: AuditAction.DEVICE_DISCONNECT,
          entityType: AuditEntityType.DEVICE,
          entityId: device.id,
          entityName: device.name,
          description: `Device disconnected from the platform`,
          metadata: {
            reason:
              Math.random() > 0.5
                ? 'Connection timeout'
                : 'Client disconnected',
            duration: Math.floor(Math.random() * 3600),
          },
          severity: AuditSeverity.WARNING,
          timestamp: getRandomDate(Math.floor(Math.random() * 5)),
          success: true,
          tenantId: tenant?.id || device.tenantId,
        });
      }
    }

    // Alarm-related audit logs
    for (const alarm of alarms) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      // Alarm triggered
      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name} ` : undefined,
        userEmail: user?.email,
        action: AuditAction.ALARM_TRIGGER,
        entityType: AuditEntityType.ALARM,
        entityId: alarm.id,
        entityName: alarm.name,
        description: `Alarm triggered: ${alarm.message || alarm.name}`,
        metadata: {
          severity: alarm.severity,
          deviceId: alarm.deviceId,
          currentValue: alarm.currentValue,
          threshold: alarm.rule.value,
        },
        severity:
          alarm.severity === 'critical'
            ? AuditSeverity.CRITICAL
            : alarm.severity === 'error'
              ? AuditSeverity.ERROR
              : alarm.severity === 'warning'
                ? AuditSeverity.WARNING
                : AuditSeverity.INFO,
        timestamp:
          alarm.triggeredAt || getRandomDate(Math.floor(Math.random() * 7)),
        success: true,
        tenantId: tenant?.id || alarm.userId,
      });

      // Alarm acknowledged
      if (alarm.acknowledgedAt) {
        auditLogs.push({
          userId: alarm.acknowledgedBy || user?.id,
          userName: user ? `${user.name} ` : undefined,
          userEmail: user?.email,
          action: AuditAction.ALARM_ACKNOWLEDGE,
          entityType: AuditEntityType.ALARM,
          entityId: alarm.id,
          entityName: alarm.name,
          description: `Alarm acknowledged by user`,
          metadata: {
            severity: alarm.severity,
            acknowledgedAt: alarm.acknowledgedAt,
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: alarm.acknowledgedAt,
          success: true,
          tenantId: tenant?.id || alarm.userId,
        });
      }
    }

    // Settings changes
    for (let i = 0; i < 5; i++) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name} ` : undefined,
        userEmail: user?.email,
        action: AuditAction.SETTINGS_CHANGE,
        entityType: AuditEntityType.SETTINGS,
        description: `System settings updated`,
        changes: {
          before: {
            notificationEnabled: true,
            alertThreshold: 75,
          },
          after: {
            notificationEnabled: true,
            alertThreshold: 80,
          },
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 60)),
        success: true,
        tenantId: tenant?.id,
      });
    }

    // API Key operations
    for (let i = 0; i < 3; i++) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      // API Key creation
      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name}` : undefined,
        userEmail: user?.email,
        action: AuditAction.API_KEY_CREATE,
        entityType: AuditEntityType.API_KEY,
        entityId: `key-${Math.random().toString(36).substring(2, 15)}`,
        entityName: `API Key ${i + 1}`,
        description: `API key created`,
        metadata: {
          keyName: `Integration Key ${i + 1}`,
          permissions: ['read', 'write'],
          expiresIn: '30 days',
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 60)),
        success: true,
        tenantId: tenant?.id,
      });
    }

    // File operations
    for (let i = 0; i < 4; i++) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name} ` : undefined,
        userEmail: user?.email,
        action: AuditAction.FILE_UPLOAD,
        entityType: AuditEntityType.FILE,
        entityId: `file-${Math.random().toString(36).substring(2, 15)}`,
        entityName: `document-${i + 1}.pdf`,
        description: `File uploaded`,
        metadata: {
          fileName: `document-${i + 1}.pdf`,
          fileSize: Math.floor(Math.random() * 5000000) + 10000,
          mimeType: 'application/pdf',
        },
        ipAddress: getRandomItem(ipAddresses),
        userAgent: getRandomItem(userAgents),
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 30)),
        success: true,
        tenantId: tenant?.id,
      });
    }

    // Notification sent
    for (let i = 0; i < 10; i++) {
      const user = getRandomItem(users);
      const tenant = getRandomItem(tenants);

      auditLogs.push({
        userId: user?.id,
        userName: user ? `${user.name} ` : undefined,
        userEmail: user?.email,
        action: AuditAction.NOTIFICATION_SENT,
        entityType: AuditEntityType.NOTIFICATION,
        description: `Notification sent to user`,
        metadata: {
          type: ['email', 'sms', 'push'][Math.floor(Math.random() * 3)],
          subject: 'System Alert',
          recipient: user?.email,
        },
        severity: AuditSeverity.INFO,
        timestamp: getRandomDate(Math.floor(Math.random() * 7)),
        success: Math.random() > 0.1, // 90% success rate
        errorMessage:
          Math.random() > 0.9 ? 'Failed to send notification' : undefined,
        tenantId: tenant?.id,
      });
    }

    // Save audit logs
    let created = 0;
    for (const logData of auditLogs) {
      const log = this.auditLogRepository.create(logData);
      await this.auditLogRepository.save(log);
      created++;
    }

    console.log(`✅ Created ${created} audit log entries`);
    console.log('🎉 Audit log seeding completed!');
  }
}
