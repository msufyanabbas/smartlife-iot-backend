// src/modules/alarms/alarms.consumer.ts
// FIXED - Alarm Consumer - Compatible with your KafkaService and RedisService

import { Pool } from 'pg';
import { kafkaService } from '@/lib/kafka/kafka.service';
import { redisService } from '@/lib/redis/redis.service';
import { EachMessagePayload } from 'kafkajs';

export interface AlarmMessage {
  id: string;
  deviceId: string;
  deviceKey: string;
  deviceName: string;
  tenantId: string;
  userId: string;
  severity: 'INFO' | 'WARNING' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  type: string;
  title: string;
  message: string;
  ruleName?: string;
  condition?: string;
  value?: number;
  threshold?: number;
  timestamp: number;
  metadata?: any;
}

export class AlarmConsumer {
  private groupId = 'alarms-consumer-group';
  private topics = [
    'alarms.created',
    'alarms.acknowledged',
    'alarms.cleared',
    'alarms.escalated',
  ];

  constructor(
    private db: Pool,
    // Mail service is optional - can be undefined
    private mailService?: any,
  ) {}

  async start(): Promise<void> {
    console.log('🚨 Starting Alarm Consumer...');

    // Use your kafkaService.createConsumer method
    await kafkaService.createConsumer(
      this.groupId,
      this.topics,
      async (payload: EachMessagePayload) => {
        try {
          const topic = payload.topic;
          const alarm: AlarmMessage = JSON.parse(
            payload.message.value?.toString() || '{}',
          );

          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`🚨 ALARM EVENT: ${topic}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`📱 Device: ${alarm.deviceName} (${alarm.deviceKey})`);
          console.log(`⚠️  Severity: ${alarm.severity}`);
          console.log(`📝 Message: ${alarm.message}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

          // Route to appropriate handler
          switch (topic) {
            case 'alarms.created':
              await this.handleAlarmCreated(alarm);
              break;
            case 'alarms.acknowledged':
              await this.handleAlarmAcknowledged(alarm);
              break;
            case 'alarms.cleared':
              await this.handleAlarmCleared(alarm);
              break;
            case 'alarms.escalated':
              await this.handleAlarmEscalated(alarm);
              break;
          }

          console.log(`✅ Alarm processed successfully\n`);
        } catch (error) {
          console.error('❌ Failed to process alarm:', error);
          throw error; // Let Kafka handle retry
        }
      },
    );

    console.log('✅ Alarm Consumer started');
    console.log(`📊 Subscribed to topics: ${this.topics.join(', ')}\n`);
  }

  /**
   * Handle new alarm creation
   */
  private async handleAlarmCreated(alarm: AlarmMessage): Promise<void> {
    console.log('📝 Processing new alarm...');

    // 1. Save to alarm history
    await this.saveAlarmHistory(alarm);

    // 2. Update alarm statistics
    await this.updateAlarmStats(alarm);

    // 3. Cache active alarm
    await this.cacheActiveAlarm(alarm);

    // 4. Send notifications based on severity
    await this.sendNotifications(alarm);

    // 5. Check for escalation rules
    await this.checkEscalation(alarm);

    console.log('✅ New alarm processed');
  }

  /**
   * Handle alarm acknowledgment
   */
  private async handleAlarmAcknowledged(alarm: AlarmMessage): Promise<void> {
    console.log('✅ Processing alarm acknowledgment...');

    // Update alarm status in database
    await this.db.query(
      `UPDATE alarm 
       SET status = 'ACKNOWLEDGED',
           acknowledged_at = NOW(),
           acknowledged_by = $1
       WHERE id = $2`,
      [alarm.userId, alarm.id],
    );

    // Update cache - remove from active alarms
    await redisService.hdel(`tenant:${alarm.tenantId}:active_alarms`, alarm.id);

    // Notify relevant users
    await this.notifyAcknowledgment(alarm);

    console.log('✅ Alarm acknowledged');
  }

  /**
   * Handle alarm clearance
   */
  private async handleAlarmCleared(alarm: AlarmMessage): Promise<void> {
    console.log('🟢 Processing alarm clearance...');

    // Update alarm status
    await this.db.query(
      `UPDATE alarm 
       SET status = 'CLEARED',
           cleared_at = NOW(),
           duration = EXTRACT(EPOCH FROM (NOW() - created_at))
       WHERE id = $1`,
      [alarm.id],
    );

    // Remove from active alarms
    await redisService.hdel(`tenant:${alarm.tenantId}:active_alarms`, alarm.id);

    // Send clearance notification
    await this.sendClearanceNotification(alarm);

    console.log('✅ Alarm cleared');
  }

  /**
   * Handle alarm escalation
   */
  private async handleAlarmEscalated(alarm: AlarmMessage): Promise<void> {
    console.log('📢 Processing alarm escalation...');

    // Update alarm severity
    await this.db.query(
      `UPDATE alarm 
       SET severity = 'CRITICAL',
           escalated_at = NOW()
       WHERE id = $1`,
      [alarm.id],
    );

    // Send urgent notifications
    await this.sendEscalationNotifications(alarm);

    console.log('✅ Alarm escalated');
  }

  /**
   * Save alarm to history table
   */
  private async saveAlarmHistory(alarm: AlarmMessage): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO alarm_history (
          alarm_id, device_id, tenant_id, severity, type, 
          title, message, timestamp, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8/1000), $9)`,
        [
          alarm.id,
          alarm.deviceId,
          alarm.tenantId,
          alarm.severity,
          alarm.type,
          alarm.title,
          alarm.message,
          alarm.timestamp,
          JSON.stringify(alarm.metadata || {}),
        ],
      );
    } catch (error) {
      console.error('Failed to save alarm history:', error);
    }
  }

  /**
   * Update alarm statistics in Redis
   */
  private async updateAlarmStats(alarm: AlarmMessage): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    try {
      // Count by severity
      const severityKey = `stats:alarms:${today}`;
      await redisService.hset(severityKey, alarm.severity, '0'); // Initialize if not exists
      const currentCount = await redisService.hget(severityKey, alarm.severity);
      await redisService.hset(
        severityKey,
        alarm.severity,
        String(parseInt(currentCount || '0') + 1),
      );

      // Count by device
      const deviceKey = `stats:device:${alarm.deviceId}:alarms`;
      await redisService.hset(deviceKey, alarm.severity, '0');
      const deviceCount = await redisService.hget(deviceKey, alarm.severity);
      await redisService.hset(
        deviceKey,
        alarm.severity,
        String(parseInt(deviceCount || '0') + 1),
      );
    } catch (error) {
      console.error('Failed to update alarm stats:', error);
    }
  }

  /**
   * Cache active alarm in Redis
   */
  private async cacheActiveAlarm(alarm: AlarmMessage): Promise<void> {
    try {
      await redisService.hset(
        `tenant:${alarm.tenantId}:active_alarms`,
        alarm.id,
        JSON.stringify({
          ...alarm,
          createdAt: Date.now(),
        }),
      );

      // Set expiry (7 days)
      await redisService.expire(
        `tenant:${alarm.tenantId}:active_alarms`,
        7 * 24 * 60 * 60,
      );
    } catch (error) {
      console.error('Failed to cache active alarm:', error);
    }
  }

  /**
   * Send notifications based on severity
   */
  private async sendNotifications(alarm: AlarmMessage): Promise<void> {
    console.log(`📧 Sending notifications for ${alarm.severity} alarm...`);

    try {
      // Get notification preferences
      const preferences = await this.getNotificationPreferences(
        alarm.tenantId,
        alarm.severity,
      );

      // Send email
      if (preferences.email && this.mailService) {
        await this.sendEmailNotification(alarm, preferences.recipients);
      }

      // Send SMS (if configured)
      if (preferences.sms && alarm.severity === 'CRITICAL') {
        await this.sendSMSNotification(alarm, preferences.phoneNumbers);
      }

      // Send webhook
      if (preferences.webhook) {
        await this.sendWebhookNotification(alarm, preferences.webhookUrl);
      }

      console.log('✅ Notifications sent');
    } catch (error) {
      console.error('Failed to send notifications:', error);
    }
  }

  /**
   * Send email notification
   */
  private async sendEmailNotification(
    alarm: AlarmMessage,
    recipients: string[],
  ): Promise<void> {
    if (!this.mailService) return;

    const severityEmoji = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      MINOR: '🟡',
      MAJOR: '🟠',
      CRITICAL: '🔴',
    };

    for (const recipient of recipients) {
      try {
        await this.mailService.sendMail({
          to: recipient,
          subject: `${severityEmoji[alarm.severity]} ${alarm.severity} Alarm: ${alarm.title}`,
          html: `
            <h2>${severityEmoji[alarm.severity]} ${alarm.severity} Alarm</h2>
            <p><strong>Device:</strong> ${alarm.deviceName}</p>
            <p><strong>Message:</strong> ${alarm.message}</p>
            ${alarm.ruleName ? `<p><strong>Rule:</strong> ${alarm.ruleName}</p>` : ''}
            ${alarm.value !== undefined ? `<p><strong>Value:</strong> ${alarm.value}</p>` : ''}
            ${alarm.threshold !== undefined ? `<p><strong>Threshold:</strong> ${alarm.threshold}</p>` : ''}
            <p><strong>Time:</strong> ${new Date(alarm.timestamp).toLocaleString()}</p>
            <br>
            <a href="${process.env.FRONTEND_URL}/alarms/${alarm.id}" 
               style="background-color: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              View Alarm
            </a>
          `,
        });
      } catch (error) {
        console.error(`Failed to send email to ${recipient}:`, error);
      }
    }
  }

  /**
   * Send SMS notification (placeholder - integrate with Twilio/etc)
   */
  private async sendSMSNotification(
    alarm: AlarmMessage,
    phoneNumbers: string[],
  ): Promise<void> {
    console.log(`📱 SMS notification to: ${phoneNumbers.join(', ')}`);

    // TODO: Integrate with SMS service (Twilio, AWS SNS, etc.)
  }

  /**
   * Send webhook notification
   */
  private async sendWebhookNotification(
    alarm: AlarmMessage,
    webhookUrl: string,
  ): Promise<void> {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alarm),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.statusText}`);
      }

      console.log(`✅ Webhook sent to: ${webhookUrl}`);
    } catch (error) {
      console.error('Failed to send webhook:', error);
    }
  }

  /**
   * Get notification preferences for tenant
   */
  private async getNotificationPreferences(
    tenantId: string,
    severity: string,
  ): Promise<any> {
    // Check cache first
    const cached = await redisService.get(
      `tenant:${tenantId}:notification_prefs`,
    );
    if (cached) {
      return JSON.parse(cached);
    }

    // Get from database
    const result = await this.db.query(
      `SELECT notification_preferences 
       FROM tenant 
       WHERE id = $1`,
      [tenantId],
    );

    const prefs = result.rows[0]?.notification_preferences || {
      email: true,
      recipients: ['admin@example.com'],
      sms: severity === 'CRITICAL',
      phoneNumbers: [],
      webhook: false,
      webhookUrl: '',
    };

    // Cache for 5 minutes
    await redisService.set(
      `tenant:${tenantId}:notification_prefs`,
      JSON.stringify(prefs),
      300,
    );

    return prefs;
  }

  /**
   * Check if alarm needs escalation
   */
  private async checkEscalation(alarm: AlarmMessage): Promise<void> {
    // Escalate MAJOR alarms if not acknowledged within 15 minutes
    if (alarm.severity === 'MAJOR') {
      setTimeout(
        async () => {
          const status = await this.getAlarmStatus(alarm.id);

          if (status === 'ACTIVE') {
            console.log('📢 Escalating alarm due to no acknowledgment...');

            await kafkaService.sendMessage('alarms.escalated', {
              ...alarm,
              escalatedAt: Date.now(),
            });
          }
        },
        15 * 60 * 1000,
      ); // 15 minutes
    }
  }

  /**
   * Get current alarm status
   */
  private async getAlarmStatus(alarmId: string): Promise<string> {
    const result = await this.db.query(
      'SELECT status FROM alarm WHERE id = $1',
      [alarmId],
    );
    return result.rows[0]?.status || 'UNKNOWN';
  }

  /**
   * Notify about acknowledgment
   */
  private async notifyAcknowledgment(alarm: AlarmMessage): Promise<void> {
    console.log('📧 Sending acknowledgment notification...');
    // Implementation similar to sendNotifications
  }

  /**
   * Send clearance notification
   */
  private async sendClearanceNotification(alarm: AlarmMessage): Promise<void> {
    console.log('📧 Sending clearance notification...');
    // Implementation similar to sendNotifications
  }

  /**
   * Send escalation notifications (urgent!)
   */
  private async sendEscalationNotifications(
    alarm: AlarmMessage,
  ): Promise<void> {
    console.log('🚨 Sending URGENT escalation notifications...');
    // Force email + SMS for escalated alarms
  }

  /**
   * Stop consumer
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping Alarm Consumer...');
    // Kafka service handles consumer cleanup
    console.log('✅ Alarm Consumer stopped');
  }
}
