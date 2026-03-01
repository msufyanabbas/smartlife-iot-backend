// src/modules/api-logs/entities/api-log.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';

@Entity('api_logs')
// ── Composite indexes for tenant-scoped queries ────────────────────────────
@Index(['tenantId', 'timestamp'])                // Most common: recent logs for tenant
@Index(['tenantId', 'userId', 'timestamp'])      // User activity logs
@Index(['tenantId', 'endpoint', 'timestamp'])    // Endpoint usage stats
@Index(['tenantId', 'statusCode', 'timestamp'])  // Error logs (statusCode >= 400)
@Index(['requestId'])                            // Find log by correlation ID
export class APILog extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED for authenticated requests)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })  // Nullable only for public endpoints (health, metrics)
  @Index()
  tenantId?: string;

  @ManyToOne(() => Tenant, { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - denormalized from user)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;  // Denormalized from user.customerId for fast filtering

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // USER CONTEXT
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  userId?: string;  // Nullable for unauthenticated requests

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // ══════════════════════════════════════════════════════════════════════════
  // REQUEST DETAILS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  requestId?: string;  // Correlation ID (from RequestIdMiddleware)

  @Column()
  method: string;  // GET, POST, PUT, DELETE, PATCH

  @Column()
  @Index()
  endpoint: string;  // /api/devices/:id

  @Column()
  @Index()
  statusCode: number;  // 200, 201, 400, 401, 500

  @Column({ type: 'integer' })
  responseTime: number;  // Milliseconds

  // ══════════════════════════════════════════════════════════════════════════
  // CLIENT INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  ip: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // REQUEST DATA (SANITIZED - NO SENSITIVE INFO)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  request?: {
    query?: Record<string, any>;    // Query params (sanitized)
    params?: Record<string, any>;   // Path params
    // ⚠️ NO headers - they contain Authorization tokens
    // ⚠️ NO body - it may contain passwords/secrets
  };

  // ══════════════════════════════════════════════════════════════════════════
  // RESPONSE DATA (MINIMAL)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  response?: {
    statusCode: number;
    // ⚠️ NO body - it may be very large or contain sensitive data
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ERROR TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'text', nullable: true })
  errorMessage?: string;  // Error message (sanitized)

  @Column({ type: 'text', nullable: true })
  errorStack?: string;  // Stack trace (for 500 errors)

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  @Index()
  timestamp: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: {
    route?: string;           // Controller method (e.g., 'DevicesController.create')
    executionTime?: number;   // Time spent in handler
    dbQueryCount?: number;    // Number of DB queries
    cacheHit?: boolean;       // Was response cached?
    [key: string]: any;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if this was a successful request
   */
  isSuccess(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300;
  }

  /**
   * Check if this was a client error
   */
  isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }

  /**
   * Check if this was a server error
   */
  isServerError(): boolean {
    return this.statusCode >= 500;
  }

  /**
   * Check if response was slow
   */
  isSlow(thresholdMs: number = 1000): boolean {
    return this.responseTime > thresholdMs;
  }

  /**
   * Get human-readable status category
   */
  getStatusCategory(): 'success' | 'redirect' | 'client_error' | 'server_error' {
    if (this.statusCode < 300) return 'success';
    if (this.statusCode < 400) return 'redirect';
    if (this.statusCode < 500) return 'client_error';
    return 'server_error';
  }
}
