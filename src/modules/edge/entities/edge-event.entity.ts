// src/modules/edge/entities/edge-event.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Edge } from './edge.entity';

export type EdgeEventType =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FAILED'
  | 'HEARTBEAT'
  | 'ERROR'
  | 'COMMAND_SENT'
  | 'COMMAND_RECEIVED'
  | 'DEVICE_CONNECTED'
  | 'DEVICE_DISCONNECTED'
  | 'CONFIG_UPDATED'
  | 'FIRMWARE_UPDATE';

export type EdgeEventSeverity = 'info' | 'warning' | 'error' | 'success';

/**
 * Append-only audit trail for an edge: what happened, when, and how badly.
 *
 * This is the "event log" ThingsBoard Edge exposes — the record of which syncs
 * ran, which commands went out, and when the agent came and went.
 */
@Entity('edge_events')
@Index(['edgeId', 'createdAt'])
@Index(['tenantId', 'createdAt'])
@Index(['edgeId', 'severity'])
export class EdgeEvent extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  edgeId: string;

  @ManyToOne('Edge', 'events', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'edgeId' })
  edge: Relation<Edge>;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar' })
  type: EdgeEventType;

  @Column({ type: 'varchar', nullable: true })
  message: string | null;

  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null;

  @Column({ type: 'varchar', default: 'info' })
  severity: EdgeEventSeverity;
}
