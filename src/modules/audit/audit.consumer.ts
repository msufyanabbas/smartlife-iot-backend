// src/modules/audit/audit.consumer.ts
import { Pool } from 'pg';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { RedisService } from '@/lib/redis/redis.service';
import { EachMessagePayload } from 'kafkajs';
import { AuditAction, AuditEntityType, AuditSeverity, AuditStatus } from '@common/enums/index.enum';

export interface AuditEvent {
  id: string;
  tenantId: string;
  customerId?: string;  
  userId?: string;
  userName?: string;    
  userEmail?: string;
  action: AuditAction;   
  entityType: AuditEntityType;  
  entityId?: string;
  entityName?: string;
  description?: string;
  changes?: any;
  metadata?: any;
  ipAddress?: string;
  userAgent?: string;
  timestamp: number;
  severity: AuditSeverity; 
  status?: AuditStatus;    
  success?: boolean;
  errorMessage?: string;
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
    'audit.user.password.changed',
    'audit.user.role.changed',

    // Device actions
    'audit.device.created',
    'audit.device.updated',
    'audit.device.deleted',
    'audit.device.connected',
    'audit.device.disconnected',
    'audit.device.command',

    // Alarm actions
    'audit.alarm.created',
    'audit.alarm.acknowledged',
    'audit.alarm.cleared',
    'audit.alarm.resolved',

    // Asset actions
    'audit.asset.created',
    'audit.asset.updated',
    'audit.asset.deleted',

    // Dashboard actions
    'audit.dashboard.created',
    'audit.dashboard.updated',
    'audit.dashboard.deleted',

    // Customer actions
    'audit.customer.created',
    'audit.customer.updated',
    'audit.customer.deleted',

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

  constructor(
    private db: Pool,
    private kafkaService: KafkaService,
    private redisService: RedisService,
  ) {}

  async start(): Promise<void> {
    console.log('📝 Starting Audit Consumer...');

    await this.kafkaService.createConsumer(
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
          console.log(`🏢 Tenant: ${event.tenantId}`);
          if (event.customerId) {
            console.log(`👥 Customer: ${event.customerId}`);
          }
          console.log(`👤 User: ${event.userEmail || event.userName || 'System'}`);
          console.log(
            `📦 Entity: ${event.entityType}${event.entityId ? ` (${event.entityId})` : ''}`,
          );
          console.log(`⚠️  Severity: ${event.severity}`);
          console.log(`🕐 Time: ${new Date(event.timestamp).toISOString()}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

          // Process audit event
          await this.processAuditEvent(event);

          console.log(`✅ Audit event logged\n`);
        } catch (error) {
          console.error('❌ Failed to process audit event:', error);
          // Don't throw - log error but continue processing other messages
          await this.logProcessingError(error, payload);
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
    try {
      // 1. Save to audit log table
      await this.saveToAuditLog(event);

      // 2. Update audit statistics
      await this.updateAuditStats(event);

      // 3. Check for suspicious activity
      await this.checkSuspiciousActivity(event);

      // 4. Archive old logs periodically (every 100th event)
      if (Math.random() < 0.01) {
        await this.archiveOldLogs(event.tenantId);
      }
    } catch (error) {
      console.error('Error processing audit event:', error);
      throw error; // Re-throw to trigger Kafka retry
    }
  }

  /**
   * Save audit event to database
   * ✅ Fixed: Now matches your AuditLog entity structure
   */
  private async saveToAuditLog(event: AuditEvent): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit_logs (
          id, tenant_id, customer_id, user_id, user_name, user_email,
          action, entity_type, entity_id, entity_name,
          description, changes, metadata,
          ip_address, user_agent,
          severity, status, success, error_message,
          timestamp, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19,
          to_timestamp($20/1000), NOW(), NOW()
        )`,
        [
          event.id,
          event.tenantId,
          event.customerId,
          event.userId,
          event.userName,
          event.userEmail,
          event.action,
          event.entityType,
          event.entityId,
          event.entityName,
          event.description,
          event.changes ? JSON.stringify(event.changes) : null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          event.ipAddress,
          event.userAgent,
          event.severity,
          event.status || AuditStatus.SUCCESS,
          event.success !== false, // Default to true
          event.errorMessage,
          event.timestamp,
        ],
      );

      console.log(`💾 Audit event saved to database`);
    } catch (error) {
      console.error('Failed to save audit event to database:', error);
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
      await this.redisService.set(key, JSON.stringify(event), 86400); // 24 hours
      console.log(`💾 Audit event saved to Redis backup`);
    } catch (error) {
      console.error('Failed to save to Redis backup:', error);
    }
  }

  /**
   * Update audit statistics in Redis
   */
  private async updateAuditStats(event: AuditEvent): Promise<void> {
    const today = new Date().toISOString().split('T')[0];

    try {
      // Count by tenant and action type
      const actionsKey = `stats:audit:${event.tenantId}:${today}:actions`;
      await this.redisService.hincrby(actionsKey, event.action, 1);
      await this.redisService.expire(actionsKey, 30 * 24 * 60 * 60); // 30 days

      // Count by tenant and user
      if (event.userId) {
        const usersKey = `stats:audit:${event.tenantId}:${today}:users`;
        await this.redisService.hincrby(usersKey, event.userId, 1);
        await this.redisService.expire(usersKey, 30 * 24 * 60 * 60);
      }

      // Count by tenant and severity
      const severityKey = `stats:audit:${event.tenantId}:${today}:severity`;
      await this.redisService.hincrby(severityKey, event.severity, 1);
      await this.redisService.expire(severityKey, 30 * 24 * 60 * 60);

      // Count by tenant and customer
      if (event.customerId) {
        const customerKey = `stats:audit:${event.tenantId}:${today}:customers`;
        await this.redisService.hincrby(customerKey, event.customerId, 1);
        await this.redisService.expire(customerKey, 30 * 24 * 60 * 60);
      }

      // Total events for tenant
      const totalKey = `stats:audit:${event.tenantId}:${today}:total`;
      await this.redisService.increment(totalKey);
      await this.redisService.expire(totalKey, 30 * 24 * 60 * 60);
    } catch (error) {
      console.error('Failed to update audit stats:', error);
      // Don't throw - stats are not critical
    }
  }

  /**
   * Check for suspicious activity patterns
   */
  private async checkSuspiciousActivity(event: AuditEvent): Promise<void> {
    try {
      // Check for multiple failed login attempts
      if (event.action === AuditAction.LOGIN_FAILED) {
        await this.checkFailedLogins(event);
      }

      // Check for unusual access patterns
      if (event.action === AuditAction.PERMISSION_DENIED) {
        await this.checkUnauthorizedAccess(event);
      }

      // Check for mass deletions
      if (event.action === AuditAction.DELETE) {
        await this.checkMassDeletion(event);
      }

      // Check for privilege escalation
      if (event.action === AuditAction.ROLE_CHANGE && event.changes?.after?.role) {
        await this.checkPrivilegeEscalation(event);
      }
    } catch (error) {
      console.error('Failed to check suspicious activity:', error);
      // Don't throw - continue processing
    }
  }

  /**
   * Check for failed login attempts (brute force detection)
   */
  private async checkFailedLogins(event: AuditEvent): Promise<void> {
    if (!event.ipAddress) return;

    const key = `security:failed_logins:${event.ipAddress}`;
    const count = await this.redisService.increment(key);

    // Set expiry if this is first failed attempt
    if (count === 1) {
      await this.redisService.expire(key, 300); // 5 minutes window
    }

    // Alert if more than 5 failed attempts in 5 minutes
    if (count >= 5) {
      console.warn(`🚨 Potential brute force attack from ${event.ipAddress}`);

      await this.createSecurityAlarm({
        type: 'BRUTE_FORCE_ATTEMPT',
        severity: AuditSeverity.CRITICAL,
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

    const key = `security:unauthorized:${event.tenantId}:${event.userId}`;
    const count = await this.redisService.increment(key);

    if (count === 1) {
      await this.redisService.expire(key, 3600); // 1 hour window
    }

    // Alert if more than 10 unauthorized attempts in 1 hour
    if (count >= 10) {
      console.warn(`🚨 Suspicious access pattern for user ${event.userEmail}`);

      await this.createSecurityAlarm({
        type: 'UNAUTHORIZED_ACCESS_PATTERN',
        severity: AuditSeverity.ERROR,
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

    const key = `security:deletions:${event.tenantId}:${event.userId}:${event.entityType}`;
    const count = await this.redisService.increment(key);

    if (count === 1) {
      await this.redisService.expire(key, 60); // 1 minute window
    }

    // Alert if more than 10 deletions in 1 minute
    if (count >= 10) {
      console.warn(`🚨 Mass deletion detected: ${event.userEmail}`);

      await this.createSecurityAlarm({
        type: 'MASS_DELETION',
        severity: AuditSeverity.WARNING,
        message: `${count} ${event.entityType} deleted in 1 minute by ${event.userEmail}`,
        details: event,
      });
    }
  }

  /**
   * Check for privilege escalation
   */
  private async checkPrivilegeEscalation(event: AuditEvent): Promise<void> {
    const oldRole = event.changes?.before?.role;
    const newRole = event.changes?.after?.role;

    if (!oldRole || !newRole) return;

    // Define role hierarchy
    const roleHierarchy = ['CUSTOMER_USER', 'CUSTOMER', 'TENANT_ADMIN', 'SUPER_ADMIN'];
    const oldLevel = roleHierarchy.indexOf(oldRole);
    const newLevel = roleHierarchy.indexOf(newRole);

    // Alert if role was elevated significantly (skipped a level)
    if (newLevel > oldLevel + 1) {
      console.warn(`🚨 Privilege escalation: ${oldRole} → ${newRole}`);

      await this.createSecurityAlarm({
        type: 'PRIVILEGE_ESCALATION',
        severity: AuditSeverity.CRITICAL,
        message: `User role elevated from ${oldRole} to ${newRole}`,
        details: event,
      });
    }
  }

  /**
   * Create security alarm via Kafka
   */
  private async createSecurityAlarm(alarm: any): Promise<void> {
    try {
      await this.kafkaService.sendMessage('alarms.security', {
        id: `security-${Date.now()}`,
        tenantId: alarm.details.tenantId,
        customerId: alarm.details.customerId,
        userId: alarm.details.userId,
        severity: alarm.severity,
        type: alarm.type,
        name: 'Security Alert',
        message: alarm.message,
        timestamp: Date.now(),
        metadata: alarm.details,
      });
    } catch (error) {
      console.error('Failed to create security alarm:', error);
    }
  }

  /**
   * Block IP address in Redis
   */
  private async blockIP(ipAddress: string, duration: number): Promise<void> {
    try {
      await this.redisService.set(
        `security:blocked_ip:${ipAddress}`,
        JSON.stringify({ blockedAt: Date.now(), reason: 'Brute force protection' }),
        duration,
      );
      console.log(`🚫 Blocked IP: ${ipAddress} for ${duration} seconds`);
    } catch (error) {
      console.error('Failed to block IP:', error);
    }
  }

  /**
   * Archive old audit logs (older than 90 days)
   */
  private async archiveOldLogs(tenantId: string): Promise<void> {
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const result = await this.db.query(
        `WITH archived AS (
          DELETE FROM audit_logs
          WHERE tenant_id = $1
            AND created_at < $2
          RETURNING *
        )
        INSERT INTO audit_logs_archive 
        SELECT * FROM archived`,
        [tenantId, ninetyDaysAgo],
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`📦 Archived ${result.rowCount} old audit logs for tenant ${tenantId}`);
      }
    } catch (error) {
      // Ignore errors - archival is not critical
      // Archive table might not exist yet
    }
  }

  /**
   * Log processing error
   */
  private async logProcessingError(error: any, payload: EachMessagePayload): Promise<void> {
    console.error('Audit processing error:', {
      topic: payload.topic,
      partition: payload.partition,
      offset: payload.message.offset,
      error: error.message,
      stack: error.stack,
    });

    // Save error to Redis for monitoring
    try {
      const errorKey = `audit:errors:${Date.now()}`;
      await this.redisService.set(
        errorKey,
        JSON.stringify({
          topic: payload.topic,
          error: error.message,
          timestamp: Date.now(),
        }),
        3600, // 1 hour
      );
    } catch {
      // Ignore
    }
  }

  /**
   * Get audit statistics for a specific date and tenant
   */
  async getStatistics(tenantId: string, date: string): Promise<any> {
    const actionsKey = `stats:audit:${tenantId}:${date}:actions`;
    const usersKey = `stats:audit:${tenantId}:${date}:users`;
    const severityKey = `stats:audit:${tenantId}:${date}:severity`;
    const customerKey = `stats:audit:${tenantId}:${date}:customers`;
    const totalKey = `stats:audit:${tenantId}:${date}:total`;

    const [actions, users, severity, customers, total] = await Promise.all([
      this.redisService.hgetall(actionsKey),
      this.redisService.hgetall(usersKey),
      this.redisService.hgetall(severityKey),
      this.redisService.hgetall(customerKey),
      this.redisService.get(totalKey),
    ]);

    return {
      tenantId,
      date,
      actions: actions || {},
      users: users || {},
      severity: severity || {},
      customers: customers || {},
      totalEvents: parseInt(total || '0'),
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