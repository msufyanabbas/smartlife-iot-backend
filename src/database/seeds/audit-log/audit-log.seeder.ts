// src/database/seeders/audit-log.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';
import { User, Device, Alarm, Tenant, AuditLog, Customer } from '@modules/index.entities';
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
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  private mapAlarmSeverityToAuditSeverity(alarmSeverity: string): AuditSeverity {
    switch (alarmSeverity.toUpperCase()) {
      case 'CRITICAL':
        return AuditSeverity.CRITICAL;
      case 'ERROR':
      case 'MAJOR':
        return AuditSeverity.ERROR;
      case 'WARNING':
      case 'MINOR':
        return AuditSeverity.WARNING;
      case 'INFO':
      default:
        return AuditSeverity.INFO;
    }
  }

  async seed(): Promise<void> {
    console.log('🌱 Starting audit log seeding...');

    try {
      // Check if audit logs already exist
      const existingCount = await this.auditLogRepository.count();
      if (existingCount > 0) {
        console.log(`⚠️  Found ${existingCount} existing audit logs. Skipping seeding.`);
        return;
      }

      // Fetch entities - REMOVE relations since User doesn't have tenant relation
      const tenants = await this.tenantRepository.find({ take: 10 });
      const users = await this.userRepository.find({ take: 20 }); // ✅ Removed relations
      const devices = await this.deviceRepository.find({ take: 20 }); // ✅ Removed relations
      const alarms = await this.alarmRepository.find({ take: 10 });
      const customers = await this.customerRepository.find({ take: 5 });

      // Validation checks
      if (tenants.length === 0) {
        console.log('❌ No tenants found. Please seed tenants first.');
        return;
      }

      if (users.length === 0) {
        console.log('⚠️  No users found. Creating limited audit logs.');
      }

      console.log(`📊 Found ${tenants.length} tenants, ${users.length} users, ${devices.length} devices`);

      // Helper functions
      const getRandomItem = <T>(array: T[]): T | undefined => {
        return array.length > 0
          ? array[Math.floor(Math.random() * array.length)]
          : undefined;
      };

      const getRandomDate = (daysAgo: number): Date => {
        const date = new Date();
        date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
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
        '192.168.2.15',
        '10.10.10.100',
      ];

      const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'PostmanRuntime/7.32.3',
        'SmartLifeApp/1.0.0',
      ];

      const auditLogs: Partial<AuditLog>[] = [];

      // ============================================
      // USER-RELATED AUDIT LOGS
      // ============================================
      console.log('📝 Creating user-related audit logs...');
      
      for (const user of users) {
        // Use user.tenantId directly instead of user.tenant.id
        const tenantId = user.tenantId || getRandomItem(tenants)?.id;
        if (!tenantId) continue;

        const customer = getRandomItem(customers);

        // Login events (multiple per user)
        const loginCount = Math.floor(Math.random() * 5) + 3;
        for (let i = 0; i < loginCount; i++) {
          auditLogs.push({
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.LOGIN,
            entityType: AuditEntityType.USER,
            entityId: user.id,
            entityName: user.email,
            description: `User logged in successfully`,
            metadata: {
              method: 'email',
              rememberMe: Math.random() > 0.5,
              deviceType: ['web', 'mobile', 'tablet'][Math.floor(Math.random() * 3)],
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(30),
            success: true,
          });
        }

        // Failed login attempts (occasionally)
        if (Math.random() > 0.6) {
          const failedAttempts = Math.floor(Math.random() * 3) + 1;
          for (let i = 0; i < failedAttempts; i++) {
            auditLogs.push({
              userId: user.id,
              userName: user.name,
              userEmail: user.email,
              tenantId: tenantId,
              customerId: customer?.id,
              action: AuditAction.LOGIN_FAILED,
              entityType: AuditEntityType.USER,
              entityId: user.id,
              entityName: user.email,
              description: `Failed login attempt - Invalid credentials`,
              metadata: {
                reason: 'Invalid password',
                attemptCount: i + 1,
              },
              ipAddress: getRandomItem(ipAddresses),
              userAgent: getRandomItem(userAgents),
              severity: AuditSeverity.WARNING,
              timestamp: getRandomDate(30),
              success: false,
              errorMessage: 'Invalid email or password',
            });
          }
        }

        // User created
        auditLogs.push({
          userId: getRandomItem(users)?.id,
          userName: getRandomItem(users)?.name,
          userEmail: getRandomItem(users)?.email,
          tenantId: tenantId,
          customerId: customer?.id,
          action: AuditAction.CREATE,
          entityType: AuditEntityType.USER,
          entityId: user.id,
          entityName: user.email,
          description: `User account created`,
          metadata: {
            role: user.role,
            status: user.status,
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(90),
          success: true,
        });

        // User updates (occasionally)
        if (Math.random() > 0.5) {
          auditLogs.push({
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.UPDATE,
            entityType: AuditEntityType.USER,
            entityId: user.id,
            entityName: user.email,
            description: `User profile updated`,
            changes: {
              before: {
                name: user.name,
                phoneNumber: '+966501234567',
              },
              after: {
                name: user.name,
                phoneNumber: '+966509876543',
              },
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(45),
            success: true,
          });
        }

        // Password change (occasionally)
        if (Math.random() > 0.7) {
          auditLogs.push({
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.PASSWORD_CHANGE,
            entityType: AuditEntityType.USER,
            entityId: user.id,
            entityName: user.email,
            description: `Password changed successfully`,
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.WARNING,
            timestamp: getRandomDate(60),
            success: true,
          });
        }

        // Email verification
        if (Math.random() > 0.8) {
          auditLogs.push({
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.EMAIL_VERIFY,
            entityType: AuditEntityType.USER,
            entityId: user.id,
            entityName: user.email,
            description: `Email verified successfully`,
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(90),
            success: true,
          });
        }

        // Logout events
        const logoutCount = Math.floor(Math.random() * 3) + 1;
        for (let i = 0; i < logoutCount; i++) {
          auditLogs.push({
            userId: user.id,
            userName: user.name,
            userEmail: user.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.LOGOUT,
            entityType: AuditEntityType.USER,
            entityId: user.id,
            entityName: user.email,
            description: `User logged out`,
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(30),
            success: true,
          });
        }
      }

      // ============================================
      // DEVICE-RELATED AUDIT LOGS
      // ============================================
      console.log('🔌 Creating device-related audit logs...');

      for (const device of devices) {
        const user = getRandomItem(users);
        const tenantId = device.tenantId || getRandomItem(tenants)?.id;
        if (!tenantId) continue;

        const customer = getRandomItem(customers);

        // Device creation
        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenantId,
          customerId: customer?.id,
          action: AuditAction.CREATE,
          entityType: AuditEntityType.DEVICE,
          entityId: device.id,
          entityName: device.name,
          description: `Device "${device.name}" created`,
          metadata: {
            deviceType: device.type,
            deviceKey: device.deviceKey,
            protocol: 'MQTT',
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(120),
          success: true,
        });

        // Device connections (multiple)
        const connectionCount = Math.floor(Math.random() * 10) + 5;
        for (let i = 0; i < connectionCount; i++) {
          auditLogs.push({
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.DEVICE_CONNECT,
            entityType: AuditEntityType.DEVICE,
            entityId: device.id,
            entityName: device.name,
            description: `Device "${device.name}" connected`,
            metadata: {
              protocol: 'MQTT',
              clientId: `${device.deviceKey}`,
              keepAlive: 60,
              qos: 1,
            },
            ipAddress: getRandomItem(ipAddresses),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(30),
            success: true,
          });
        }

        // Device updates
        if (Math.random() > 0.4) {
          auditLogs.push({
            userId: user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.UPDATE,
            entityType: AuditEntityType.DEVICE,
            entityId: device.id,
            entityName: device.name,
            description: `Device "${device.name}" configuration updated`,
            changes: {
              before: {
                status: device.status || 'inactive',
                label: device.name || 'Old Label',
              },
              after: {
                status: 'active',
                label: device.name || 'Updated Label',
              },
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(60),
            success: true,
          });
        }

        // Device disconnections
        const disconnectCount = Math.floor(Math.random() * 5) + 2;
        for (let i = 0; i < disconnectCount; i++) {
          auditLogs.push({
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.DEVICE_DISCONNECT,
            entityType: AuditEntityType.DEVICE,
            entityId: device.id,
            entityName: device.name,
            description: `Device "${device.name}" disconnected`,
            metadata: {
              reason: ['Connection timeout', 'Client disconnected', 'Network error'][
                Math.floor(Math.random() * 3)
              ],
              duration: Math.floor(Math.random() * 3600) + 60,
            },
            severity: AuditSeverity.WARNING,
            timestamp: getRandomDate(30),
            success: true,
          });
        }

        // Device commands (occasionally)
        if (Math.random() > 0.6) {
          const commands = ['turnOn', 'turnOff', 'setBrightness', 'setTemperature', 'reset'];
          auditLogs.push({
            userId: user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: tenantId,
            customerId: customer?.id,
            action: AuditAction.DEVICE_COMMAND,
            entityType: AuditEntityType.DEVICE,
            entityId: device.id,
            entityName: device.name,
            description: `Command sent to device "${device.name}"`,
            metadata: {
              command: getRandomItem(commands),
              parameters: { value: Math.floor(Math.random() * 100) },
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: getRandomDate(14),
            success: Math.random() > 0.1,
            errorMessage: Math.random() > 0.9 ? 'Device not responding' : undefined,
          });
        }
      }

      // ============================================
      // ALARM-RELATED AUDIT LOGS
      // ============================================
      console.log('🚨 Creating alarm-related audit logs...');

      for (const alarm of alarms) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        const customer = getRandomItem(customers);

        // Alarm triggered
        auditLogs.push({
          tenantId: tenant.id,
          customerId: customer?.id,
          action: AuditAction.ALARM_TRIGGER,
          entityType: AuditEntityType.ALARM,
          entityId: alarm.id,
          entityName: alarm.name,
          description: `Alarm "${alarm.name}" triggered: ${alarm.message || alarm.name}`,
          metadata: {
            severity: alarm.severity,
            deviceId: alarm.deviceId,
            currentValue: alarm.currentValue,
            threshold: alarm.rule?.value,
            condition: alarm.rule?.condition,
          },
          severity: this.mapAlarmSeverityToAuditSeverity(alarm.severity),
          timestamp: alarm.triggeredAt || getRandomDate(14),
          success: true,
        });

        // Alarm acknowledged
        if (alarm.acknowledgedAt) {
          auditLogs.push({
            userId: alarm.acknowledgedBy || user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: tenant.id,
            customerId: customer?.id,
            action: AuditAction.ALARM_ACKNOWLEDGE,
            entityType: AuditEntityType.ALARM,
            entityId: alarm.id,
            entityName: alarm.name,
            description: `Alarm "${alarm.name}" acknowledged`,
            metadata: {
              severity: alarm.severity,
              acknowledgedAt: alarm.acknowledgedAt,
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: alarm.acknowledgedAt,
            success: true,
          });
        }

        // Alarm cleared
        if (alarm.clearedAt) {
          auditLogs.push({
            userId: alarm.createdBy || user?.id,
            userName: user?.name,
            userEmail: user?.email,
            tenantId: tenant.id,
            customerId: customer?.id,
            action: AuditAction.ALARM_CLEAR,
            entityType: AuditEntityType.ALARM,
            entityId: alarm.id,
            entityName: alarm.name,
            description: `Alarm "${alarm.name}" cleared`,
            metadata: {
              severity: alarm.severity,
              clearedAt: alarm.clearedAt,
            },
            ipAddress: getRandomItem(ipAddresses),
            userAgent: getRandomItem(userAgents),
            severity: AuditSeverity.INFO,
            timestamp: alarm.clearedAt,
            success: true,
          });
        }
      }

      // ============================================
      // OTHER SYSTEM EVENTS
      // ============================================
      console.log('⚙️  Creating system-related audit logs...');

      // Settings changes
      for (let i = 0; i < 8; i++) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenant.id,
          action: AuditAction.SETTINGS_CHANGE,
          entityType: AuditEntityType.SETTINGS,
          description: `System settings updated`,
          changes: {
            before: {
              notificationEnabled: Math.random() > 0.5,
              alertThreshold: 75,
              emailNotifications: true,
            },
            after: {
              notificationEnabled: Math.random() > 0.5,
              alertThreshold: 80,
              emailNotifications: Math.random() > 0.5,
            },
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(90),
          success: true,
        });
      }

      // API Key operations
      for (let i = 0; i < 6; i++) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenant.id,
          action: AuditAction.API_KEY_CREATE,
          entityType: AuditEntityType.API_KEY,
          entityId: `key-${Math.random().toString(36).substring(2, 15)}`,
          entityName: `Integration Key ${i + 1}`,
          description: `API key created for integration`,
          metadata: {
            keyName: `Integration Key ${i + 1}`,
            permissions: ['read', 'write', 'telemetry'][
              Math.floor(Math.random() * 3)
            ],
            expiresIn: ['30 days', '90 days', '1 year', 'never'][
              Math.floor(Math.random() * 4)
            ],
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(120),
          success: true,
        });
      }

      // File operations
      for (let i = 0; i < 10; i++) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        const fileName = `document-${i + 1}.${['pdf', 'csv', 'xlsx', 'jpg'][Math.floor(Math.random() * 4)]}`;
        
        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenant.id,
          action: AuditAction.FILE_UPLOAD,
          entityType: AuditEntityType.FILE,
          entityId: `file-${Math.random().toString(36).substring(2, 15)}`,
          entityName: fileName,
          description: `File "${fileName}" uploaded`,
          metadata: {
            fileName,
            fileSize: Math.floor(Math.random() * 5000000) + 10000,
            mimeType: fileName.endsWith('pdf')
              ? 'application/pdf'
              : fileName.endsWith('csv')
                ? 'text/csv'
                : fileName.endsWith('xlsx')
                  ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                  : 'image/jpeg',
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(60),
          success: true,
        });
      }

      // Notifications
      for (let i = 0; i < 15; i++) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        const notificationType = ['email', 'sms', 'push'][Math.floor(Math.random() * 3)];
        const isSuccess = Math.random() > 0.15;

        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenant.id,
          action: AuditAction.NOTIFICATION_SENT,
          entityType: AuditEntityType.NOTIFICATION,
          description: `${notificationType.toUpperCase()} notification ${isSuccess ? 'sent' : 'failed'}`,
          metadata: {
            type: notificationType,
            subject: ['System Alert', 'Device Update', 'Alarm Triggered', 'Weekly Report'][
              Math.floor(Math.random() * 4)
            ],
            recipient: user?.email,
          },
          severity: isSuccess ? AuditSeverity.INFO : AuditSeverity.WARNING,
          timestamp: getRandomDate(14),
          success: isSuccess,
          errorMessage: isSuccess ? undefined : `Failed to send ${notificationType} notification`,
        });
      }

      // Subscription events
      for (let i = 0; i < 5; i++) {
        const user = getRandomItem(users);
        const tenant = getRandomItem(tenants);
        if (!tenant) continue;

        auditLogs.push({
          userId: user?.id,
          userName: user?.name,
          userEmail: user?.email,
          tenantId: tenant.id,
          action: AuditAction.SUBSCRIPTION_CREATE,
          entityType: AuditEntityType.SUBSCRIPTION,
          entityId: `sub-${Math.random().toString(36).substring(2, 15)}`,
          entityName: ['Basic Plan', 'Pro Plan', 'Enterprise Plan'][Math.floor(Math.random() * 3)],
          description: `Subscription created`,
          metadata: {
            plan: ['basic', 'pro', 'enterprise'][Math.floor(Math.random() * 3)],
            billingCycle: ['monthly', 'yearly'][Math.floor(Math.random() * 2)],
            amount: [99, 299, 999][Math.floor(Math.random() * 3)],
          },
          ipAddress: getRandomItem(ipAddresses),
          userAgent: getRandomItem(userAgents),
          severity: AuditSeverity.INFO,
          timestamp: getRandomDate(180),
          success: true,
        });
      }

      // Save all audit logs in batches
      console.log(`💾 Saving ${auditLogs.length} audit log entries...`);
      
      const batchSize = 100;
      let saved = 0;

      for (let i = 0; i < auditLogs.length; i += batchSize) {
        const batch = auditLogs.slice(i, i + batchSize);
        const entities = this.auditLogRepository.create(batch);
        await this.auditLogRepository.save(entities);
        saved += batch.length;
        
        if (saved % 500 === 0) {
          console.log(`   📝 Saved ${saved}/${auditLogs.length} audit logs...`);
        }
      }

      console.log(`✅ Successfully created ${saved} audit log entries`);
      console.log('🎉 Audit log seeding completed!');
      
      // Print statistics
      const stats = {
        total: saved,
        byEntityType: {} as Record<string, number>,
        byAction: {} as Record<string, number>,
        bySeverity: {} as Record<string, number>,
      };

      for (const log of auditLogs) {
        stats.byEntityType[log.entityType!] = (stats.byEntityType[log.entityType!] || 0) + 1;
        stats.byAction[log.action!] = (stats.byAction[log.action!] || 0) + 1;
        stats.bySeverity[log.severity!] = (stats.bySeverity[log.severity!] || 0) + 1;
      }

      console.log('\n📊 Audit Log Statistics:');
      console.log(`   Total: ${stats.total}`);
      console.log('   By Entity Type:', stats.byEntityType);
      console.log('   By Action:', stats.byAction);
      console.log('   By Severity:', stats.bySeverity);

    } catch (error) {
      console.error('❌ Error seeding audit logs:', error);
      throw error;
    }
  }
}