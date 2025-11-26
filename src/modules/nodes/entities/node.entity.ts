import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum NodeType {
  FILTER = 'filter',
  ENRICHMENT = 'enrichment',
  TRANSFORMATION = 'transformation',
  ACTION = 'action',
  EXTERNAL = 'external',
  FLOW = 'flow',
}

@Entity('nodes')
@Index(['type'])
// @Index(['ruleChainId'])
export class Node extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: NodeType,
  })
  type: NodeType;

  @Column({ name: 'rule_chain_id', nullable: true })
  @Index()
  ruleChainId?: string;

  @Column({ type: 'jsonb' })
  configuration: {
    script?: string;
    scriptLang?: string;
    successAction?: string;
    failureAction?: string;
    messageTypes?: string[];
    originatorTypes?: string[];
    relationTypes?: string[];
    dataKeys?: string[];
    metadata?: Record<string, any>;
  };

  @Column({ type: 'jsonb', default: '{}' })
  position: {
    x: number;
    y: number;
  };

  @Column({ default: true })
  enabled: boolean;

  @Column({ name: 'debug_mode', default: false })
  debugMode: boolean;

  @Column({ type: 'jsonb', default: '[]' })
  additionalInfo: {
    layoutX?: number;
    layoutY?: number;
  };

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;
}
