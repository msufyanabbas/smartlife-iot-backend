// src/database/seeders/audit-log.seeder.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';
import { User, Device, Tenant, Customer, AuditLog } from '@modules/index.entities';
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
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async seed(): Promise<void> {
    console.log('📋 Seeding audit logs...');

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

    // Get first device
    const device = await this.deviceRepository.findOne({
      where: { tenantId: tenant.id },
      order: { createdAt: 'ASC' },
    });

    const getMinutesAgo = (minutes: number): Date => {
      const date = new Date();
      date.setMinutes(date.getMinutes() - minutes);
      return date;
    };

    const auditLogsData: Partial<AuditLog>[] = [
      // 1. User Login (Success)
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        action: AuditAction.LOGIN,
        entityType: AuditEntityType.USER,
        entityId: user.id,
        entityName: user.email,
        description: `User logged in successfully`,
        metadata: {
          method: 'email',
          rememberMe: true,
          deviceType: 'web',
        },
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        severity: AuditSeverity.INFO,
        timestamp: getMinutesAgo(30),
        success: true,
      },

      // 2. Device Created
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        action: AuditAction.CREATE,
        entityType: AuditEntityType.DEVICE,
        entityId: device?.id,
        entityName: device?.name || 'Temperature Sensor',
        description: `Device "${device?.name || 'Temperature Sensor'}" created`,
        metadata: {
          deviceType: device?.type || 'sensor',
          deviceKey: device?.deviceKey,
          protocol: 'MQTT',
        },
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        severity: AuditSeverity.INFO,
        timestamp: getMinutesAgo(120),
        success: true,
      },

      // 3. Failed Login Attempt
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        action: AuditAction.LOGIN_FAILED,
        entityType: AuditEntityType.USER,
        entityId: user.id,
        entityName: user.email,
        description: `Failed login attempt - Invalid credentials`,
        metadata: {
          reason: 'Invalid password',
          attemptCount: 1,
        },
        ipAddress: '203.0.113.45',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        severity: AuditSeverity.WARNING,
        timestamp: getMinutesAgo(240),
        success: false,
        errorMessage: 'Invalid email or password',
      },

      // 4. Settings Changed
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        action: AuditAction.SETTINGS_CHANGE,
        entityType: AuditEntityType.SETTINGS,
        description: `System settings updated`,
        changes: {
          before: {
            notificationEnabled: true,
            alertThreshold: 75,
            emailNotifications: true,
          },
          after: {
            notificationEnabled: true,
            alertThreshold: 80,
            emailNotifications: false,
          },
        },
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        severity: AuditSeverity.INFO,
        timestamp: getMinutesAgo(360),
        success: true,
      },

      // 5. Device Command Sent
      {
        tenantId: tenant.id,
        customerId: customer?.id,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        action: AuditAction.DEVICE_COMMAND,
        entityType: AuditEntityType.DEVICE,
        entityId: device?.id,
        entityName: device?.name || 'Temperature Sensor',
        description: `Command sent to device "${device?.name || 'Temperature Sensor'}"`,
        metadata: {
          command: 'setBrightness',
          parameters: { value: 75 },
        },
        ipAddress: '192.168.1.100',
        userAgent: 'SmartLifeApp/1.0.0',
        severity: AuditSeverity.INFO,
        timestamp: getMinutesAgo(60),
        success: true,
      },
    ];

    for (const logData of auditLogsData) {
      const existing = await this.auditLogRepository.findOne({
        where: {
          userId: logData.userId,
          action: logData.action,
          entityType: logData.entityType,
          timestamp: logData.timestamp,
        },
      });

      if (!existing) {
        const auditLog = this.auditLogRepository.create(logData);
        await this.auditLogRepository.save(auditLog);
        console.log(
          `✅ Created audit log: ${logData.action} - ${logData.entityType} (${logData.success ? 'SUCCESS' : 'FAILED'})`,
        );
      } else {
        console.log(
          `⏭️  Audit log already exists: ${logData.action} - ${logData.entityType}`,
        );
      }
    }

    console.log('🎉 Audit log seeding completed! (5 logs created)');
  }
}