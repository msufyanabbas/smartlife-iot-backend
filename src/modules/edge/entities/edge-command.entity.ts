// src/modules/edge/entities/edge-command.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Edge } from './edge.entity';

export type EdgeCommandType =
  | 'SYNC_CONFIG'
  | 'REBOOT'
  | 'UPDATE_FIRMWARE'
  | 'CLEAR_BUFFER'
  | 'RESTART_AGENT'
  | 'CUSTOM';

export type EdgeCommandStatus =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'EXECUTED'
  | 'FAILED';

/**
 * A instruction queued for an edge agent to collect on its next poll.
 *
 * Lifecycle: PENDING → SENT (handed to the agent) → EXECUTED | FAILED (agent
 * acknowledged). DELIVERED sits between SENT and EXECUTED for agents that
 * confirm receipt separately from completion.
 *
 * Replaces the previous EdgeCommand, which used a lowercase status enum, a
 * `command` column and a different verb set. Rewritten rather than migrated —
 * the table was empty.
 */
@Entity('edge_commands')
@Index(['edgeId', 'status'])
@Index(['tenantId', 'createdAt'])
export class EdgeCommand extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  edgeId: string;

  @ManyToOne('Edge', 'commands', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'edgeId' })
  edge: Relation<Edge>;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar' })
  type: EdgeCommandType;

  @Column({ type: 'jsonb', nullable: true })
  payload: Record<string, any> | null;

  @Column({ type: 'varchar', default: 'PENDING' })
  status: EdgeCommandStatus;

  @Column({ type: 'timestamp', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  executedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId: string | null;
}
