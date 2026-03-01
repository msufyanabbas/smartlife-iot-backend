// src/database/seeds/integration/integration.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IntegrationType,
  IntegrationStatus,
} from '@common/enums/index.enum';
import { Integration, User, Tenant } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class IntegrationSeeder implements ISeeder {
  private readonly logger = new Logger(IntegrationSeeder.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting integration seeding...');

    // Check if integrations already exist
    const existingIntegrations = await this.integrationRepository.count();
    if (existingIntegrations > 0) {
      this.logger.log(
        `⏭️  Integrations already seeded (${existingIntegrations} records). Skipping...`,
      );
      return;
    }

    // Fetch required entities
    const users = await this.userRepository.find({ take: 10 });
    const tenants = await this.tenantRepository.find({ take: 5 });

    if (users.length === 0 || tenants.length === 0) {
      this.logger.warn('⚠️  No users or tenants found. Please seed them first.');
      return;
    }

    this.logger.log(`📊 Found ${users.length} users, ${tenants.length} tenants`);

    // ════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ════════════════════════════════════════════════════════════════

    const getRandomItem = <T>(array: T[]): T => {
      return array[Math.floor(Math.random() * array.length)];
    };

    const generatePastDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(date.getHours() - Math.floor(Math.random() * 24));
      return date;
    };

    // ════════════════════════════════════════════════════════════════
    // INTEGRATION DATA
    // ════════════════════════════════════════════════════════════════

    const integrations: Partial<Integration>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. AWS IoT Core Integration
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        name: 'AWS IoT Core Integration',
        type: IntegrationType.CLOUD,
        protocol: 'MQTT',
        description:
          'Primary cloud integration with AWS IoT Core for device management and data ingestion',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'a3example1234-ats.iot.us-east-1.amazonaws.com',
          port: 8883,
          headers: {
            'Content-Type': 'application/json',
          },
          useTls: true,
          timeout: 30000,
          retryAttempts: 3,
          retryDelay: 1000,
        },
        messagesProcessed: 125847,
        messagesSucceeded: 124989,
        messagesFailed: 858,
        lastActivity: new Date(),
        lastSuccess: new Date(),
        consecutiveFailures: 0,
        tags: ['cloud', 'aws', 'iot-core', 'production'],
      },

      // ════════════════════════════════════════════════════════════════
      // 2. Azure IoT Hub
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        name: 'Azure IoT Hub',
        type: IntegrationType.CLOUD,
        protocol: 'AMQP',
        description:
          'Microsoft Azure IoT Hub for enterprise device connectivity',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'riyadh-iot-hub.azure-devices.net',
          port: 5671,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token',
          },
          useTls: true,
          timeout: 30000,
          retryAttempts: 3,
        },
        messagesProcessed: 98234,
        messagesSucceeded: 97891,
        messagesFailed: 343,
        lastActivity: generatePastDate(0),
        lastSuccess: generatePastDate(0),
        consecutiveFailures: 0,
        tags: ['cloud', 'azure', 'iot-hub', 'enterprise'],
      },

      // ════════════════════════════════════════════════════════════════
      // 3. Critical Alerts Webhook
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[0].tenantId || tenants[0].id,
        customerId: users[0].customerId,
        userId: users[0].id,
        name: 'Critical Alerts Webhook',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description:
          'Webhook endpoint for critical system alerts and notifications',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://alerts.example.com/api/webhook/critical',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': 'webhook_api_key_secret',
            'User-Agent': 'IoT-Platform/1.0',
          },
          timeout: 10000,
          retryAttempts: 5,
          retryDelay: 2000,
        },
        messagesProcessed: 3456,
        messagesSucceeded: 3445,
        messagesFailed: 11,
        lastActivity: generatePastDate(0),
        lastSuccess: generatePastDate(0),
        consecutiveFailures: 0,
        rateLimiting: {
          enabled: true,
          maxRequests: 100,
          windowSeconds: 60,
          currentCount: 0,
          windowStart: new Date(),
        },
        tags: ['webhook', 'alerts', 'critical'],
      },

      // ════════════════════════════════════════════════════════════════
      // 4. Slack Notifications
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        name: 'Slack Notifications',
        type: IntegrationType.NOTIFICATION,
        protocol: 'HTTPS',
        description:
          'Send notifications to Slack channels for team collaboration',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 5000,
          retryAttempts: 3,
        },
        messagesProcessed: 8924,
        messagesSucceeded: 8901,
        messagesFailed: 23,
        lastActivity: generatePastDate(0),
        lastSuccess: generatePastDate(0),
        consecutiveFailures: 0,
        tags: ['notification', 'slack', 'collaboration'],
      },

      // ════════════════════════════════════════════════════════════════
      // 5. Factory MQTT Broker
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[1]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[1]?.customerId || users[0].customerId,
        userId: users[1]?.id || users[0].id,
        name: 'Factory MQTT Broker',
        type: IntegrationType.MQTT,
        protocol: 'MQTT',
        description: 'Local MQTT broker for factory floor sensors and devices',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          broker: 'mqtt.factory.local',
          port: 1883,
          topic: 'factory/sensors/#',
          qos: 1,
          clientId: 'factory-integration-001',
          timeout: 15000,
          retryAttempts: 5,
        },
        messagesProcessed: 456789,
        messagesSucceeded: 455234,
        messagesFailed: 1555,
        lastActivity: new Date(),
        lastSuccess: new Date(),
        consecutiveFailures: 0,
        tags: ['mqtt', 'factory', 'sensors', 'local'],
      },

      // ════════════════════════════════════════════════════════════════
      // 6. Email Notification Service
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: users[2]?.tenantId || users[0].tenantId || tenants[0].id,
        customerId: users[2]?.customerId || users[0].customerId,
        userId: users[2]?.id || users[0].id,
        name: 'Email Notification Service',
        type: IntegrationType.NOTIFICATION,
        protocol: 'SMTP',
        description: 'SMTP email service for alert notifications and reports',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'smtp.gmail.com',
          port: 587,
          timeout: 30000,
          retryAttempts: 3,
        },
        messagesProcessed: 12456,
        messagesSucceeded: 12402,
        messagesFailed: 54,
        lastActivity: generatePastDate(0),
        lastSuccess: generatePastDate(0),
        consecutiveFailures: 0,
        tags: ['notification', 'email', 'smtp'],
      },

      // ════════════════════════════════════════════════════════════════
      // 7. Twilio SMS Gateway
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Twilio SMS Gateway',
        type: IntegrationType.NOTIFICATION,
        protocol: 'HTTPS',
        description: 'Twilio integration for SMS alerts and notifications',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://api.twilio.com/2010-04-01/Accounts/ACXXXXXXXXXXXXXXXXX/Messages.json',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 10000,
          retryAttempts: 3,
        },
        messagesProcessed: 5678,
        messagesSucceeded: 5632,
        messagesFailed: 46,
        lastActivity: generatePastDate(1),
        lastSuccess: generatePastDate(1),
        consecutiveFailures: 0,
        rateLimiting: {
          enabled: true,
          maxRequests: 50,
          windowSeconds: 60,
        },
        tags: ['notification', 'sms', 'twilio'],
      },

      // ════════════════════════════════════════════════════════════════
      // 8. Data Warehouse Sync
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Data Warehouse Sync',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description: 'Webhook for syncing telemetry data to data warehouse',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://datawarehouse.example.com/api/ingest',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Warehouse-Token': 'warehouse_token',
          },
          timeout: 60000,
          retryAttempts: 5,
          retryDelay: 5000,
        },
        messagesProcessed: 789456,
        messagesSucceeded: 786234,
        messagesFailed: 3222,
        lastActivity: new Date(),
        lastSuccess: new Date(),
        consecutiveFailures: 0,
        tags: ['webhook', 'data-warehouse', 'analytics'],
      },

      // ════════════════════════════════════════════════════════════════
      // 9. Legacy System Webhook (INACTIVE)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Legacy System Webhook',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTP',
        description: 'Webhook integration with legacy ERP system',
        status: IntegrationStatus.INACTIVE,
        enabled: false,
        configuration: {
          url: 'http://legacy-erp.internal/api/webhook',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Legacy-Auth': 'legacy_token',
          },
          timeout: 30000,
        },
        messagesProcessed: 1234,
        messagesSucceeded: 1189,
        messagesFailed: 45,
        lastActivity: generatePastDate(15),
        lastSuccess: generatePastDate(15),
        consecutiveFailures: 0,
        tags: ['webhook', 'legacy', 'deprecated'],
      },

      // ════════════════════════════════════════════════════════════════
      // 10. Failed Cloud Integration (ERROR STATE)
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: getRandomItem(users).tenantId || tenants[0].id,
        customerId: getRandomItem(users).customerId,
        userId: getRandomItem(users).id,
        name: 'Failed Cloud Integration',
        type: IntegrationType.CLOUD,
        protocol: 'HTTPS',
        description: 'Cloud integration that is currently experiencing errors',
        status: IntegrationStatus.ERROR,
        enabled: true,
        configuration: {
          url: 'https://cloud.problematic-service.com/api',
          port: 443,
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
          retryAttempts: 3,
        },
        messagesProcessed: 12345,
        messagesSucceeded: 11234,
        messagesFailed: 1111,
        lastActivity: generatePastDate(3),
        lastSuccess: generatePastDate(5),
        lastFailure: generatePastDate(3),
        lastError: 'Connection timeout: Unable to reach cloud service endpoint',
        consecutiveFailures: 15,
        errorHistory: [
          {
            timestamp: generatePastDate(3),
            error: 'Connection timeout',
            statusCode: 504,
          },
          {
            timestamp: generatePastDate(3),
            error: 'Service unavailable',
            statusCode: 503,
          },
        ],
        tags: ['cloud', 'error', 'needs-attention'],
      },
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL INTEGRATIONS
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const integrationData of integrations) {
      try {
        const integration = this.integrationRepository.create(integrationData);
        await this.integrationRepository.save(integration);

        const statusTag =
          integration.status === IntegrationStatus.ACTIVE
            ? '✅ ACTIVE'
            : integration.status === IntegrationStatus.ERROR
              ? '❌ ERROR'
              : '⏸️  INACTIVE';

        const enabledTag = integration.enabled ? '' : '🔒 DISABLED';

        this.logger.log(
          `✅ Created: ${integration.name.substring(0, 35).padEnd(37)} | ` +
          `${integration.type.padEnd(15)} | ${statusTag} ${enabledTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed integration '${integrationData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      byType: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      enabled: integrations.filter(i => i.enabled).length,
      disabled: integrations.filter(i => !i.enabled).length,
      withRateLimit: integrations.filter(i => i.rateLimiting?.enabled).length,
      totalMessages: integrations.reduce((sum, i) => sum + (i.messagesProcessed || 0), 0),
    };

    integrations.forEach((i) => {
      if (i.type) {
        summary.byType[i.type] = (summary.byType[i.type] || 0) + 1;
      }
      if (i.status) {
        summary.byStatus[i.status] = (summary.byStatus[i.status] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Integration seeding complete! Created ${createdCount}/${integrations.length} integrations.`,
    );
    this.logger.log('');
    this.logger.log('📊 Integration Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   Enabled: ${summary.enabled}`);
    this.logger.log(`   Disabled: ${summary.disabled}`);
    this.logger.log(`   With Rate Limiting: ${summary.withRateLimit}`);
    this.logger.log(`   Total Messages Processed: ${summary.totalMessages.toLocaleString()}`);
    this.logger.log('');
    this.logger.log('   By Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(20)}: ${count}`),
    );
    this.logger.log('');
    this.logger.log('   By Status:');
    Object.entries(summary.byStatus).forEach(([status, count]) =>
      this.logger.log(`     - ${status.padEnd(20)}: ${count}`),
    );
  }
}