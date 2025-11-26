// src/modules/audit/audit.consumer.ts
// FIXED - Audit Consumer - Compatible with your services

import { Pool } from 'pg';
import { kafkaService } from '@/lib/kafka/kafka.service';
import { redisService } from '@/lib/redis/redis.service';
import { EachMessagePayload } from 'kafkajs';

export interface AuditEvent {
  id: string;
  tenantId: string;
  userId?: string;
  userEmail?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: any;
  ipAddress?: string;
  userAgent?: string;
  timestamp: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export class AuditConsumer {
  private groupId = 'audit-consumer-group';
  private topics = [
    // User actions
    'audit.user.login',
    'audit.user.logout',
    'audit.user.created',
    'audit.user.updated',
    'audit.user.deleted',

    // Device actions
    'audit.device.created',
    'audit.device.updated',
    'audit.device.deleted',
    'audit.device.command',

    // Alarm actions
    'audit.alarm.created',
    'audit.alarm.acknowledged',
    'audit.alarm.cleared',

    // Settings changes
    'audit.settings.updated',
    'audit.rule.created',
    'audit.rule.updated',
    'audit.rule.deleted',

    // Security events
    'audit.security.login_failed',
    'audit.security.password_changed',
    'audit.security.permission_denied',
  ];

  constructor(private db: Pool) {}

  async start(): Promise<void> {
    console.log('📝 Starting Audit Consumer...');

    // Use your kafkaService.createConsumer method
    await kafkaService.createConsumer(
      this.groupId,
      this.topics,
      async (payload: EachMessagePayload) => {
        try {
          const event: AuditEvent = JSON.parse(
            payload.message.value?.toString() || '{}',
          );

          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`📝 AUDIT EVENT: ${event.action}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`👤 User: ${event.userEmail || 'System'}`);
          console.log(
            `📦 Resource: ${event.resource}${event.resourceId ? ` (${event.resourceId})` : ''}`,
          );
          console.log(`⚠️  Severity: ${event.severity}`);
          console.log(`🕐 Time: ${new Date(event.timestamp).toISOString()}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

          // Process audit event
          await this.processAuditEvent(event);

          console.log(`✅ Audit event logged\n`);
        } catch (error) {
          console.error('❌ Failed to process audit event:', error);
          throw error; // Let Kafka handle retry
        }
      },
    );

    console.log('✅ Audit Consumer started');
    console.log(`📊 Subscribed to ${this.topics.length} audit topics\n`);
  }

  /**
   * Process audit event
   */
  private async processAuditEvent(event: AuditEvent): Promise<void> {
    // 1. Save to audit log table
    await this.saveToAuditLog(event);

    // 2. Update audit statistics
    await this.updateAuditStats(event);

    // 3. Check for suspicious activity
    await this.checkSuspiciousActivity(event);

    // 4. Archive old logs (if needed)
    await this.archiveOldLogs(event.tenantId);
  }

  /**
   * Save audit event to database
   */
  private async saveToAuditLog(event: AuditEvent): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_log (
          id, tenant_id, user_id, user_email, action, resource, 
          resource_id, details, ip_address, user_agent, 
          severity, timestamp, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 
          to_timestamp($12/1000), NOW()
        )`,
        [
          event.id,
          event.tenantId,
          event.userId,
          event.userEmail,
          event.action,
          event.resource,
          event.resourceId,
          JSON.stringify(event.details || {}),
          event.ipAddress,
          event.userAgent,
          event.severity,
          event.timestamp,
        ],
      );

      console.log(`💾 Audit event saved to database`);
    } catch (error) {
      console.error('Failed to save audit event:', error);

      // Fallback: save to Redis if database fails
      await this.saveToRedisBackup(event);
    }
  }

  /**
   * Save to Redis as backup if database fails
   */
  private async saveToRedisBackup(event: AuditEvent): Promise<void> {
    try {
      const key = `audit:backup:${event.tenantId}:${Date.now()}`;
      await redisService.set(key, JSON.stringify(event), 86400); // 24 hours
      console.log(`💾 Audit event saved to Redis backup`);
    } catch (error) {
      console.error('Failed to save to Redis backup:', error);
    }
  }

  /**
   * Update audit statistics
   */
  private async updateAuditStats(event: AuditEvent): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    try {
      // Count by action type
      const actionsKey = `stats:audit:${today}:actions`;
      const currentActions =
        (await redisService.hget(actionsKey, event.action)) || '0';
      await redisService.hset(
        actionsKey,
        event.action,
        String(parseInt(currentActions) + 1),
      );

      // Count by user
      if (event.userId) {
        const usersKey = `stats:audit:${today}:users`;
        const currentUsers =
          (await redisService.hget(usersKey, event.userId)) || '0';
        await redisService.hset(
          usersKey,
          event.userId,
          String(parseInt(currentUsers) + 1),
        );
      }

      // Count by severity
      const severityKey = `stats:audit:${today}:severity`;
      const currentSeverity =
        (await redisService.hget(severityKey, event.severity)) || '0';
      await redisService.hset(
        severityKey,
        event.severity,
        String(parseInt(currentSeverity) + 1),
      );

      // Set expiry (30 days)
      await redisService.expire(actionsKey, 30 * 24 * 60 * 60);
      if (event.userId) {
        await redisService.expire(
          `stats:audit:${today}:users`,
          30 * 24 * 60 * 60,
        );
      }
      await redisService.expire(severityKey, 30 * 24 * 60 * 60);
    } catch (error) {
      console.error('Failed to update audit stats:', error);
    }
  }

  /**
   * Check for suspicious activity patterns
   */
  private async checkSuspiciousActivity(event: AuditEvent): Promise<void> {
    try {
      // Check for multiple failed login attempts
      if (event.action === 'audit.security.login_failed') {
        await this.checkFailedLogins(event);
      }

      // Check for unusual access patterns
      if (event.action === 'audit.security.permission_denied') {
        await this.checkUnauthorizedAccess(event);
      }

      // Check for mass deletions
      if (event.action.includes('deleted')) {
        await this.checkMassDeletion(event);
      }

      // Check for privilege escalation
      if (event.action === 'audit.user.updated' && event.details?.roleChanged) {
        await this.checkPrivilegeEscalation(event);
      }
    } catch (error) {
      console.error('Failed to check suspicious activity:', error);
    }
  }

  /**
   * Check for failed login attempts (brute force detection)
   */
  private async checkFailedLogins(event: AuditEvent): Promise<void> {
    if (!event.ipAddress) return;

    const key = `security:failed_logins:${event.ipAddress}`;
    const count = await redisService.increment(key);

    // Set expiry if this is first failed attempt
    if (count === 1) {
      await redisService.expire(key, 300); // 5 minutes window
    }

    // Alert if more than 5 failed attempts in 5 minutes
    if (count >= 5) {
      console.warn(`🚨 Potential brute force attack from ${event.ipAddress}`);

      await this.createSecurityAlarm({
        type: 'BRUTE_FORCE_ATTEMPT',
        severity: 'CRITICAL',
        message: `${count} failed login attempts from ${event.ipAddress}`,
        details: event,
      });

      // Block IP temporarily
      await this.blockIP(event.ipAddress, 3600); // 1 hour
    }
  }

  /**
   * Check for unauthorized access attempts
   */
  private async checkUnauthorizedAccess(event: AuditEvent): Promise<void> {
    if (!event.userId) return;

    const key = `security:unauthorized:${event.userId}`;
    const count = await redisService.increment(key);

    if (count === 1) {
      await redisService.expire(key, 3600); // 1 hour window
    }

    // Alert if more than 10 unauthorized attempts in 1 hour
    if (count >= 10) {
      console.warn(`🚨 Suspicious access pattern for user ${event.userEmail}`);

      await this.createSecurityAlarm({
        type: 'UNAUTHORIZED_ACCESS_PATTERN',
        severity: 'MAJOR',
        message: `${count} unauthorized access attempts by ${event.userEmail}`,
        details: event,
      });
    }
  }

  /**
   * Check for mass deletion activity
   */
  private async checkMassDeletion(event: AuditEvent): Promise<void> {
    if (!event.userId) return;

    const key = `security:deletions:${event.userId}:${event.resource}`;
    const count = await redisService.increment(key);

    if (count === 1) {
      await redisService.expire(key, 60); // 1 minute window
    }

    // Alert if more than 10 deletions in 1 minute
    if (count >= 10) {
      console.warn(`🚨 Mass deletion detected: ${event.userEmail}`);

      await this.createSecurityAlarm({
        type: 'MASS_DELETION',
        severity: 'MAJOR',
        message: `${count} ${event.resource} deleted in 1 minute by ${event.userEmail}`,
        details: event,
      });
    }
  }

  /**
   * Check for privilege escalation
   */
  private async checkPrivilegeEscalation(event: AuditEvent): Promise<void> {
    const oldRole = event.details?.oldRole;
    const newRole = event.details?.newRole;

    if (!oldRole || !newRole) return;

    // Define role hierarchy
    const roleHierarchy = ['USER', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN'];
    const oldLevel = roleHierarchy.indexOf(oldRole);
    const newLevel = roleHierarchy.indexOf(newRole);

    // Alert if role was elevated significantly
    if (newLevel > oldLevel + 1) {
      console.warn(`🚨 Privilege escalation: ${oldRole} → ${newRole}`);

      await this.createSecurityAlarm({
        type: 'PRIVILEGE_ESCALATION',
        severity: 'CRITICAL',
        message: `User role elevated from ${oldRole} to ${newRole}`,
        details: event,
      });
    }
  }

  /**
   * Create security alarm
   */
  private async createSecurityAlarm(alarm: any): Promise<void> {
    await kafkaService.sendMessage('alarms.created', {
      id: `security-${Date.now()}`,
      deviceId: 'system',
      deviceKey: 'security',
      tenantId: alarm.details.tenantId,
      userId: alarm.details.userId,
      severity: alarm.severity,
      type: alarm.type,
      title: 'Security Alert',
      message: alarm.message,
      timestamp: Date.now(),
      metadata: alarm.details,
    });
  }

  /**
   * Block IP address
   */
  private async blockIP(ipAddress: string, duration: number): Promise<void> {
    await redisService.set(`security:blocked_ip:${ipAddress}`, '1', duration);
    console.log(`🚫 Blocked IP: ${ipAddress} for ${duration} seconds`);
  }

  /**
   * Archive old audit logs
   */
  private async archiveOldLogs(tenantId: string): Promise<void> {
    try {
      // Archive logs older than 90 days to separate table
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const result = await this.db.query(
        `WITH archived AS (
          DELETE FROM audit_log
          WHERE tenant_id = $1
            AND created_at < $2
          RETURNING *
        )
        INSERT INTO audit_log_archive 
        SELECT * FROM archived`,
        [tenantId, ninetyDaysAgo],
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`📦 Archived ${result.rowCount} old audit logs`);
      }
    } catch (error) {
      // Ignore errors (archival is not critical)
    }
  }

  /**
   * Get audit statistics
   */
  async getStatistics(date: string): Promise<any> {
    const actionsKey = `stats:audit:${date}:actions`;
    const usersKey = `stats:audit:${date}:users`;
    const severityKey = `stats:audit:${date}:severity`;

    const [actions, users, severity] = await Promise.all([
      redisService.hgetall(actionsKey),
      redisService.hgetall(usersKey),
      redisService.hgetall(severityKey),
    ]);

    const totalEvents = Object.values(actions || {}).reduce(
      (sum: number, val: any) => sum + parseInt(val || '0'),
      0,
    );

    return {
      date,
      actions: actions || {},
      users: users || {},
      severity: severity || {},
      totalEvents,
    };
  }

  /**
   * Stop consumer
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping Audit Consumer...');
    // Kafka service handles consumer cleanup
    console.log('✅ Audit Consumer stopped');
  }
}
