// src/modules/integrations/entities/integration.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { IntegrationType, IntegrationStatus } from '@common/enums/index.enum';

@Entity('integrations')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'type'])
@Index(['tenantId', 'enabled'])
export class Integration extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;  // "Slack Notifications", "Weather API"

  @Column({ type: 'enum', enum: IntegrationType })

  type: IntegrationType;

  @Column()
  protocol: string;  // "HTTPS", "MQTT", "WebSocket", "AMQP"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: IntegrationStatus, default: IntegrationStatus.INACTIVE })

  status: IntegrationStatus;

  @Column({ default: true })

  enabled: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  configuration: {
    // HTTP/HTTPS
    url?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;

    // MQTT
    broker?: string;
    port?: number;
    topic?: string;
    qos?: 0 | 1 | 2;
    clientId?: string;

    // Authentication
    username?: string;
    password?: string;
    apiKey?: string;
    token?: string;

    // SSL/TLS
    useTls?: boolean;
    tlsCert?: string;
    tlsKey?: string;

    // Retry & Timeout
    timeout?: number;
    retryAttempts?: number;
    retryDelay?: number;

    // Other
    customFields?: Record<string, any>;
  };
  // Example - Webhook:
  // configuration: {
  //   url: 'https://api.slack.com/webhook/abc123',
  //   method: 'POST',
  //   headers: {
  //     'Content-Type': 'application/json',
  //     'Authorization': 'Bearer sk-xxx'
  //   },
  //   timeout: 5000,
  //   retryAttempts: 3
  // }
  //
  // Example - MQTT:
  // configuration: {
  //   broker: 'mqtt.example.com',
  //   port: 8883,
  //   topic: 'smartlife/devices/+/telemetry',
  //   qos: 1,
  //   clientId: 'integration-123',
  //   username: 'mqtt_user',
  //   password: 'mqtt_pass',
  //   useTls: true
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION (Separate from config for security)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true, select: false })
  credentials?: {
    apiKey?: string;
    apiSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    oauth?: {
      clientId: string;
      clientSecret: string;
      scope?: string[];
    };
    expiresAt?: Date;
  };
  // Stored separately with select: false for security
  // Must explicitly select this field when needed

  // ══════════════════════════════════════════════════════════════════════════
  // USAGE STATISTICS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  messagesProcessed: number;

  @Column({ type: 'int', default: 0 })
  messagesSucceeded: number;

  @Column({ type: 'int', default: 0 })
  messagesFailed: number;

  @Column({ type: 'timestamp', nullable: true })
  lastActivity?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastSuccess?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastFailure?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // ERROR TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'text', nullable: true })
  lastError?: string;

  @Column({ type: 'int', default: 0 })
  consecutiveFailures: number;

  @Column({ type: 'jsonb', nullable: true })
  errorHistory?: Array<{
    timestamp: Date;
    error: string;
    statusCode?: number;
  }>;

  // ══════════════════════════════════════════════════════════════════════════
  // RATE LIMITING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  rateLimiting?: {
    enabled: boolean;
    maxRequests: number;      // Max requests per window
    windowSeconds: number;     // Time window in seconds
    currentCount?: number;     // Current count in window
    windowStart?: Date;        // When current window started
  };
  // Example:
  // rateLimiting: {
  //   enabled: true,
  //   maxRequests: 100,
  //   windowSeconds: 60,  // 100 requests per minute
  //   currentCount: 25,
  //   windowStart: new Date('2024-03-01T10:30:00Z')
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['notifications', 'critical', 'external-api']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if integration is active
   */
  isActive(): boolean {
    return this.status === IntegrationStatus.ACTIVE && this.enabled;
  }

  /**
   * Check if integration has errors
   */
  hasErrors(): boolean {
    return this.status === IntegrationStatus.ERROR || this.consecutiveFailures > 0;
  }

  /**
   * Record successful message
   */
  recordSuccess(): void {
    this.messagesProcessed++;
    this.messagesSucceeded++;
    this.consecutiveFailures = 0;
    this.lastActivity = new Date();
    this.lastSuccess = new Date();
    this.status = IntegrationStatus.ACTIVE;
    this.lastError = undefined;
  }

  /**
   * Record failed message
   */
  recordFailure(error: string, statusCode?: number): void {
    this.messagesProcessed++;
    this.messagesFailed++;
    this.consecutiveFailures++;
    this.lastActivity = new Date();
    this.lastFailure = new Date();
    this.lastError = error;

    // Add to error history (keep last 10)
    if (!this.errorHistory) {
      this.errorHistory = [];
    }
    this.errorHistory.unshift({
      timestamp: new Date(),
      error,
      statusCode,
    });
    this.errorHistory = this.errorHistory.slice(0, 10);

    // Auto-disable after too many failures
    if (this.consecutiveFailures >= 10) {
      this.status = IntegrationStatus.ERROR;
      this.enabled = false;
    }
  }

  /**
   * Get success rate percentage
   */
  getSuccessRate(): number {
    if (this.messagesProcessed === 0) return 0;
    return (this.messagesSucceeded / this.messagesProcessed) * 100;
  }

  /**
   * Check if rate limit exceeded
   */
  isRateLimited(): boolean {
    if (!this.rateLimiting?.enabled) return false;

    const now = Date.now();
    const windowStart = this.rateLimiting.windowStart
      ? new Date(this.rateLimiting.windowStart).getTime()
      : 0;
    const windowMs = this.rateLimiting.windowSeconds * 1000;

    // Reset window if expired
    if (now - windowStart > windowMs) {
      this.rateLimiting.currentCount = 0;
      this.rateLimiting.windowStart = new Date();
      return false;
    }

    // Check if limit exceeded
    return (this.rateLimiting.currentCount ?? 0) >= this.rateLimiting.maxRequests;
  }

  /**
   * Increment rate limit counter
   */
  incrementRateLimit(): void {
    if (!this.rateLimiting?.enabled) return;

    const now = Date.now();
    const windowStart = this.rateLimiting.windowStart
      ? new Date(this.rateLimiting.windowStart).getTime()
      : 0;
    const windowMs = this.rateLimiting.windowSeconds * 1000;

    // Reset window if expired
    if (now - windowStart > windowMs) {
      this.rateLimiting.currentCount = 1;
      this.rateLimiting.windowStart = new Date();
    } else {
      this.rateLimiting.currentCount = (this.rateLimiting.currentCount ?? 0) + 1;
    }
  }

  /**
   * Check if integration is healthy
   */
  isHealthy(): boolean {
    return (
      this.isActive() &&
      this.consecutiveFailures === 0 &&
      this.getSuccessRate() > 90
    );
  }

  /**
   * Get configuration value safely
   */
  getConfig<T = any>(key: string, defaultValue?: T): T {
    return (this.configuration as any)?.[key] ?? defaultValue;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.messagesProcessed = 0;
    this.messagesSucceeded = 0;
    this.messagesFailed = 0;
    this.consecutiveFailures = 0;
    this.errorHistory = [];
    this.lastError = undefined;
  }
}