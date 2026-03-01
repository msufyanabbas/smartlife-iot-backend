// src/modules/nodes/entities/node.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, Customer, User, RuleChain } from '@modules/index.entities';
import { NodeType } from '@common/enums/index.enum';

@Entity('nodes')
@Index(['tenantId', 'type'])
@Index(['tenantId', 'ruleChainId'])
@Index(['tenantId', 'userId'])
@Index(['tenantId', 'enabled'])
export class Node extends BaseEntity {
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
  // RULE CHAIN ASSOCIATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ nullable: true })

  ruleChainId?: string;

  @ManyToOne(() => RuleChain, { nullable: true })
  @JoinColumn({ name: 'ruleChainId' })
  ruleChain?: RuleChain;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;  // "Temperature Filter", "Send Email Action"

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: NodeType })

  type: NodeType;

  @Column({ default: true })

  enabled: boolean;

  @Column({ default: false })
  debugMode: boolean;  // Enable debug logging for this node

  // ══════════════════════════════════════════════════════════════════════════
  // NODE CONFIGURATION
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb' })
  configuration: {
    // Script-based nodes
    script?: string;              // JavaScript/Python code
    scriptLang?: 'javascript' | 'python' | 'groovy';

    // Flow control
    successAction?: string;       // Node ID to go to on success
    failureAction?: string;       // Node ID to go to on failure

    // Filters
    messageTypes?: string[];      // ['TELEMETRY', 'ALARM']
    originatorTypes?: string[];   // ['DEVICE', 'ASSET']
    relationTypes?: string[];     // ['Contains', 'Manages']
    dataKeys?: string[];          // ['temperature', 'humidity']

    // Conditions
    condition?: {
      key: string;
      operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
      value: any;
    };

    // Transformations
    mapping?: Record<string, string>;  // { 'temp': 'temperature' }

    // Actions
    actionType?: 'email' | 'sms' | 'webhook' | 'mqtt' | 'log';
    actionConfig?: {
      template?: string;
      recipients?: string[];
      webhookUrl?: string;
      mqttTopic?: string;
    };

    // External integrations
    integrationId?: string;

    // Metadata
    metadata?: Record<string, any>;
  };
  // Example - Filter Node:
  // configuration: {
  //   messageTypes: ['TELEMETRY'],
  //   dataKeys: ['temperature'],
  //   condition: {
  //     key: 'temperature',
  //     operator: 'gt',
  //     value: 30
  //   }
  // }
  //
  // Example - Transformation Node:
  // configuration: {
  //   scriptLang: 'javascript',
  //   script: `
  //     msg.temperature = msg.temp * 1.8 + 32; // C to F
  //     return msg;
  //   `
  // }
  //
  // Example - Action Node:
  // configuration: {
  //   actionType: 'email',
  //   actionConfig: {
  //     template: 'Temperature Alert: {{temperature}}°C',
  //     recipients: ['admin@example.com']
  //   }
  // }

  // ══════════════════════════════════════════════════════════════════════════
  // CANVAS POSITION (For visual editor)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: { x: 0, y: 0 } })
  position: {
    x: number;
    y: number;
  };
  // Example: { x: 250, y: 150 }

  // ══════════════════════════════════════════════════════════════════════════
  // CONNECTIONS (Edges to other nodes)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', default: [] })
  connections: Array<{
    targetNodeId: string;
    connectionType: 'success' | 'failure' | 'default' | 'custom';
    label?: string;
  }>;
  // Example:
  // connections: [
  //   {
  //     targetNodeId: 'node-456',
  //     connectionType: 'success',
  //     label: 'Temperature > 30°C'
  //   },
  //   {
  //     targetNodeId: 'node-789',
  //     connectionType: 'failure',
  //     label: 'Otherwise'
  //   }
  // ]

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
    input?: any;
  }>;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];  // ['critical', 'temperature', 'hvac']

  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: {
    layoutX?: number;
    layoutY?: number;
    color?: string;
    icon?: string;
    [key: string]: any;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if node is enabled
   */
  isEnabled(): boolean {
    return this.enabled === true;
  }

  /**
   * Check if node has connections
   */
  hasConnections(): boolean {
    return this.connections && this.connections.length > 0;
  }

  /**
   * Get success connection
   */
  getSuccessConnection(): string | undefined {
    return this.connections?.find(c => c.connectionType === 'success')?.targetNodeId;
  }

  /**
   * Get failure connection
   */
  getFailureConnection(): string | undefined {
    return this.connections?.find(c => c.connectionType === 'failure')?.targetNodeId;
  }

  /**
   * Add connection to another node
   */
  addConnection(
    targetNodeId: string,
    connectionType: 'success' | 'failure' | 'default' | 'custom' = 'default',
    label?: string,
  ): void {
    if (!this.connections) {
      this.connections = [];
    }

    // Remove existing connection of same type
    this.connections = this.connections.filter(
      c => c.targetNodeId !== targetNodeId || c.connectionType !== connectionType,
    );

    // Add new connection
    this.connections.push({
      targetNodeId,
      connectionType,
      label,
    });
  }

  /**
   * Remove connection
   */
  removeConnection(targetNodeId: string): void {
    if (this.connections) {
      this.connections = this.connections.filter(c => c.targetNodeId !== targetNodeId);
    }
  }

  /**
   * Record execution
   */
  recordExecution(success: boolean, executionTime: number, error?: string): void {
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
      });
      this.errorHistory = this.errorHistory.slice(0, 10);
    }

    // Update average execution time (rolling average)
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
   * Check if node is healthy (> 90% success rate)
   */
  isHealthy(): boolean {
    return this.getSuccessRate() > 90;
  }

  /**
   * Get configuration value
   */
  getConfig<T = any>(key: string, defaultValue?: T): T {
    return (this.configuration as any)?.[key] ?? defaultValue;
  }

  /**
   * Check if node is filter type
   */
  isFilter(): boolean {
    return this.type === NodeType.FILTER;
  }

  /**
   * Check if node is action type
   */
  isAction(): boolean {
    return this.type === NodeType.ACTION;
  }

  /**
   * Check if node is transformation type
   */
  isTransformation(): boolean {
    return this.type === NodeType.TRANSFORMATION;
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