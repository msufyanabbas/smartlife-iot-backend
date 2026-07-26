// src/modules/edge/entities/edge-metrics-snapshot.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import type { EdgeInstance } from './edge-instance.entity';

@Entity('edge_metrics_snapshots')
@Index(['edgeId', 'recordedAt'])
@Index(['tenantId', 'recordedAt'])
export class EdgeMetricsSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  edgeId: string;

  @ManyToOne('EdgeInstance', 'metricsSnapshots', {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'edgeId' })
  edge: Relation<EdgeInstance>;

  @Column()
  tenantId: string;

  // ══════════════════════════════════════════════════════════════════════════
  // CORE METRICS (always present)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'float' })
  cpu: number;

  @Column({ type: 'float' })
  memory: number;

  @Column({ type: 'float' })
  storage: number;

  @Column({ type: 'float' })
  uptime: number;

  // ══════════════════════════════════════════════════════════════════════════
  // OPTIONAL METRICS
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'float', nullable: true })
  temperature?: number;

  @Column({ type: 'float', nullable: true })
  networkIn?: number;

  @Column({ type: 'float', nullable: true })
  networkOut?: number;

  // ══════════════════════════════════════════════════════════════════════════
  // TIMESTAMP
  // ══════════════════════════════════════════════════════════════════════════

  @CreateDateColumn()
  recordedAt: Date;
}