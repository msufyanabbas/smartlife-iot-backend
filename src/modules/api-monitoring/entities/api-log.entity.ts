// src/modules/api-logs/entities/api-log.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Customer } from '../../customers/entities/customers.entity';
import type { User } from '../../users/entities/user.entity';

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

  tenantId?: string;

  @ManyToOne('Tenant', { nullable: true })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL - denormalized from user)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  customerId?: string;  // Denormalized from user.customerId for fast filtering

  @ManyToOne('Customer', { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Relation<Customer>;

  // ══════════════════════════════════════════════════════════════════════════
  // USER CONTEXT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  userId?: string;  // Nullable for unauthenticated requests

  @ManyToOne('User', { nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: Relation<User>;

  // ══════════════════════════════════════════════════════════════════════════
  // REQUEST DETAILS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  requestId?: string;  // Correlation ID (from RequestIdMiddleware)

  @Column()
  method: string;  // GET, POST, PUT, DELETE, PATCH

  @Column()

  endpoint: string;  // Route TEMPLATE — /devices/:id — never the raw URL.
                     // Grouping keys (top endpoints, slowest) depend on this
                     // being low-cardinality, so query strings and inlined ids
                     // must stay out of it. The raw URL goes in `url`.

  @Column({ type: 'varchar', nullable: true })
  url?: string;  // Full request URL incl. query string — /devices?limit=1

  @Column()

  statusCode: number;  // 200, 201, 400, 401, 500

  @Column({ type: 'integer' })
  responseTime: number;  // Milliseconds

  @Column({ type: 'boolean', default: false })
  isError: boolean;  // Denormalised statusCode >= 400 (kept for cheap filtering)

  // ══════════════════════════════════════════════════════════════════════════
  // CLIENT INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })
  ip?: string;  // Nullable: a socket can be gone by the time we log

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  @Column({ type: 'varchar', nullable: true })
  userRole?: string;  // Denormalised from user.role — survives user deletion

  // ══════════════════════════════════════════════════════════════════════════
  // PAYLOAD SIZE (bytes)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'int', default: 0 })
  requestSize: number;  // From Content-Length; 0 when not sent

  @Column({ type: 'int', default: 0 })
  responseSize: number;  // Bytes written by the handler (pre-compression)

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
