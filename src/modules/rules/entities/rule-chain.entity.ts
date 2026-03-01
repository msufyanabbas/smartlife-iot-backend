// src/modules/rule-chains/entities/rule-chain.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User } from '@modules/index.entities';
import { RuleChainStatus } from '@common/enums/index.enum';

@Entity('rule_chains')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'isRoot'])
export class RuleChain extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER SCOPING (OPTIONAL)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  @Index()
  customerId?: string;

  @ManyToOne(() => Customer, { nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer?: Customer;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNERSHIP
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  name: string;  // "Device Telemetry Processing", "Alarm Handler"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: RuleChainStatus, default: RuleChainStatus.DRAFT })
  @Index()
  status: RuleChainStatus;

  @Column({ default: false })
  @Index()
  isRoot: boolean;  // Is this the root/entry rule chain?

  @Column({ default: true })
  enabled: boolean;

  @Column({ default: false })
  debugMode: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // ROOT NODE (Entry point of the rule chain)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  rootNodeId?: string;  // First node to execute

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  configuration?: {
    messageTypes?: string[];      // ['TELEMETRY', 'ALARM', 'ATTRIBUTE']
    deviceTypes?: string[];       // ['sensor', 'gateway']
    assetTypes?: string[];        // ['building', 'vehicle']
    maxExecutionTime?: number;    // Max time in ms
    retryOnFailure?: boolean;
    maxRetries?: number;
  };
  // Example:
  // configuration: {
  //   messageTypes: ['TELEMETRY'],
  //   deviceTypes: ['sensor', 'gateway'],
  //   maxExecutionTime: 5000,
  //   retryOnFailure: true,
  //   maxRetries: 3
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTION STATISTICS
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'int', default: 0 })
  executionCount: number;

  @Column({ type: 'int', default: 0 })
  successCount: number;

  @Column({ type: 'int', default: 0 })
  failureCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastExecuted?: Date;

  @Column({ type: 'int', default: 0 })
  averageExecutionTime: number;  // Milliseconds

  // ══════════════════════════════════════════════════════════════════════════
  // ERROR TRACKING
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'text', nullable: true })
  lastError?: string;

  @Column({ type: 'jsonb', nullable: true })
  errorHistory?: Array<{
    timestamp: Date;
    error: string;
    nodeId?: string;
  }>;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['telemetry', 'critical', 'alarms']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if rule chain is active
   */
  isActive(): boolean {
    return this.status === RuleChainStatus.ACTIVE && this.enabled;
  }

  /**
   * Check if rule chain is draft
   */
  isDraft(): boolean {
    return this.status === RuleChainStatus.DRAFT;
  }

  /**
   * Record execution
   */
  recordExecution(success: boolean, executionTime: number, error?: string, nodeId?: string): void {
    this.executionCount++;
    this.lastExecuted = new Date();

    if (success) {
      this.successCount++;
      this.lastError = undefined;
    } else {
      this.failureCount++;
      this.lastError = error;

      // Add to error history (keep last 10)
      if (!this.errorHistory) {
        this.errorHistory = [];
      }
      this.errorHistory.unshift({
        timestamp: new Date(),
        error: error || 'Unknown error',
        nodeId,
      });
      this.errorHistory = this.errorHistory.slice(0, 10);
    }

    // Update average execution time
    this.averageExecutionTime = Math.round(
      (this.averageExecutionTime * (this.executionCount - 1) + executionTime) / this.executionCount,
    );
  }

  /**
   * Get success rate
   */
  getSuccessRate(): number {
    if (this.executionCount === 0) return 0;
    return (this.successCount / this.executionCount) * 100;
  }

  /**
   * Check if rule chain is healthy
   */
  isHealthy(): boolean {
    return this.getSuccessRate() > 90;
  }

  /**
   * Activate rule chain
   */
  activate(): void {
    this.status = RuleChainStatus.ACTIVE;
    this.enabled = true;
  }

  /**
   * Deactivate rule chain
   */
  deactivate(): void {
    this.status = RuleChainStatus.INACTIVE;
    this.enabled = false;
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.executionCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.averageExecutionTime = 0;
    this.errorHistory = [];
    this.lastError = undefined;
  }
}