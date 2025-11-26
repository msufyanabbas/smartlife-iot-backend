import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IntegrationType,
  IntegrationStatus,
} from '@modules/integrations/entities/integration.entity';
import { Integration, User } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class IntegrationSeeder implements ISeeder {
  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
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

    // Helper function to generate random date in the past
    const generatePastDate = (daysAgo: number): Date => {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      date.setHours(date.getHours() - Math.floor(Math.random() * 24));
      return date;
    };

    const integrations = [
      {
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
          apiKey: 'aws_iot_api_key_xxxxxxxxxxx',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        messagesProcessed: 125847,
        lastActivity: new Date(),
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
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
          username: 'azure-iot-user',
          password: 'azure_password_encrypted',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer token',
          },
        },
        messagesProcessed: 98234,
        lastActivity: generatePastDate(0),
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
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
        },
        messagesProcessed: 3456,
        lastActivity: generatePastDate(0),
        userId: users[0].id,
        tenantId: users[0].tenantId,
      },
      {
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
        },
        messagesProcessed: 8924,
        lastActivity: generatePastDate(0),
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Factory MQTT Broker',
        type: IntegrationType.MQTT,
        protocol: 'MQTT',
        description: 'Local MQTT broker for factory floor sensors and devices',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'mqtt.factory.local',
          port: 1883,
          username: 'factory_mqtt_user',
          password: 'mqtt_password_encrypted',
          topic: 'factory/sensors/#',
        },
        messagesProcessed: 456789,
        lastActivity: new Date(),
        userId: users[1]?.id || users[0].id,
        tenantId: users[1]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Google Cloud Pub/Sub',
        type: IntegrationType.CLOUD,
        protocol: 'gRPC',
        description:
          'Google Cloud Pub/Sub for real-time messaging and data streaming',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'pubsub.googleapis.com',
          port: 443,
          apiKey: 'gcp_service_account_key_json',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        messagesProcessed: 234567,
        lastActivity: generatePastDate(0),
        userId: users[2]?.id || users[0].id,
        tenantId: users[2]?.tenantId || users[0].tenantId,
      },
      {
        name: 'Email Notification Service',
        type: IntegrationType.NOTIFICATION,
        protocol: 'SMTP',
        description: 'SMTP email service for alert notifications and reports',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'smtp.gmail.com',
          port: 587,
          username: 'notifications@example.com',
          password: 'smtp_password_encrypted',
        },
        messagesProcessed: 12456,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Twilio SMS Gateway',
        type: IntegrationType.NOTIFICATION,
        protocol: 'HTTPS',
        description: 'Twilio integration for SMS alerts and notifications',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://api.twilio.com/2010-04-01/Accounts/ACXXXXXXXXXXXXXXXXX/Messages.json',
          method: 'POST',
          username: 'ACXXXXXXXXXXXXXXXXX',
          password: 'twilio_auth_token',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        messagesProcessed: 5678,
        lastActivity: generatePastDate(1),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Data Warehouse Sync',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description: 'Webhook for syncing telemetry data to data warehouse',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://datawarehouse.example.com/api/ingest',
          method: 'POST',
          apiKey: 'dw_api_key_secret',
          headers: {
            'Content-Type': 'application/json',
            'X-Warehouse-Token': 'warehouse_token',
          },
        },
        messagesProcessed: 789456,
        lastActivity: new Date(),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Warehouse MQTT Broker',
        type: IntegrationType.MQTT,
        protocol: 'MQTT',
        description: 'MQTT broker for warehouse inventory tracking devices',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'warehouse-mqtt.local',
          port: 1883,
          username: 'warehouse_user',
          password: 'warehouse_mqtt_password',
          topic: 'warehouse/inventory/#',
        },
        messagesProcessed: 34567,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
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
        },
        messagesProcessed: 1234,
        lastActivity: generatePastDate(15),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'IBM Watson IoT Platform',
        type: IntegrationType.CLOUD,
        protocol: 'MQTT',
        description: 'IBM Watson IoT Platform for AI-driven analytics',
        status: IntegrationStatus.INACTIVE,
        enabled: false,
        configuration: {
          url: 'orgid.messaging.internetofthings.ibmcloud.com',
          port: 8883,
          username: 'watson_user',
          password: 'watson_password',
          apiKey: 'watson_api_key',
        },
        messagesProcessed: 0,
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Microsoft Teams Notifications',
        type: IntegrationType.NOTIFICATION,
        protocol: 'HTTPS',
        description: 'Send notifications to Microsoft Teams channels',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://outlook.office.com/webhook/xxxxx/IncomingWebhook/yyyyy',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        messagesProcessed: 6789,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'PagerDuty Integration',
        type: IntegrationType.NOTIFICATION,
        protocol: 'HTTPS',
        description:
          'PagerDuty integration for incident management and on-call alerting',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://events.pagerduty.com/v2/enqueue',
          method: 'POST',
          apiKey: 'pagerduty_integration_key',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Token token=pagerduty_api_token',
          },
        },
        messagesProcessed: 2345,
        lastActivity: generatePastDate(1),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'HiveMQ Cloud MQTT',
        type: IntegrationType.MQTT,
        protocol: 'MQTT',
        description: 'HiveMQ Cloud broker for scalable MQTT messaging',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'xxxxx.s1.eu.hivemq.cloud',
          port: 8883,
          username: 'hivemq_user',
          password: 'hivemq_password',
          topic: 'devices/#',
        },
        messagesProcessed: 567890,
        lastActivity: new Date(),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Datadog Monitoring Webhook',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description:
          'Send metrics and events to Datadog for monitoring and observability',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://api.datadoghq.com/api/v1/events',
          method: 'POST',
          apiKey: 'datadog_api_key',
          headers: {
            'Content-Type': 'application/json',
            'DD-API-KEY': 'datadog_api_key',
          },
        },
        messagesProcessed: 45678,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Grafana Webhook',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description: 'Webhook integration for Grafana alerting',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'https://grafana.example.com/api/alerts/webhook',
          method: 'POST',
          apiKey: 'grafana_service_account_token',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer grafana_token',
          },
        },
        messagesProcessed: 3456,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Failed Cloud Integration',
        type: IntegrationType.CLOUD,
        protocol: 'HTTPS',
        description: 'Cloud integration that is currently experiencing errors',
        status: IntegrationStatus.ERROR,
        enabled: true,
        configuration: {
          url: 'https://cloud.problematic-service.com/api',
          port: 443,
          apiKey: 'api_key_may_be_invalid',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        messagesProcessed: 12345,
        lastActivity: generatePastDate(3),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'Webhook Test Endpoint',
        type: IntegrationType.WEBHOOK,
        protocol: 'HTTPS',
        description: 'Test webhook for development and debugging purposes',
        status: IntegrationStatus.INACTIVE,
        enabled: false,
        configuration: {
          url: 'https://webhook.site/unique-test-id',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        },
        messagesProcessed: 543,
        lastActivity: generatePastDate(7),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
      {
        name: 'ThingsBoard Integration',
        type: IntegrationType.CLOUD,
        protocol: 'MQTT',
        description:
          'ThingsBoard IoT platform integration for device management',
        status: IntegrationStatus.ACTIVE,
        enabled: true,
        configuration: {
          url: 'thingsboard.example.com',
          port: 1883,
          username: 'thingsboard_device_token',
          topic: 'v1/devices/me/telemetry',
        },
        messagesProcessed: 78901,
        lastActivity: generatePastDate(0),
        userId: getRandomItem(users).id,
        tenantId: getRandomItem(users).tenantId,
      },
    ];

    for (const integrationData of integrations) {
      const existing = await this.integrationRepository.findOne({
        where: { name: integrationData.name, userId: integrationData.userId },
      });

      if (!existing) {
        const integration = this.integrationRepository.create(integrationData);
        await this.integrationRepository.save(integration);
        console.log(
          `✅ Created integration: ${integrationData.name} (${integrationData.type} - ${integrationData.status})`,
        );
      } else {
        console.log(`⏭️  Integration already exists: ${integrationData.name}`);
      }
    }

    console.log('🎉 Integration seeding completed!');
  }
}
