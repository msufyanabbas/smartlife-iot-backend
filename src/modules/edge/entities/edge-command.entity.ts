// src/modules/edge/entities/edge-command.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { EdgeInstance } from './edge-instance.entity';

export enum EdgeCommandStatus {
  PENDING   = 'pending',
  DELIVERED = 'delivered',
  EXECUTED  = 'executed',
  FAILED    = 'failed',
}

export type EdgeCommandType =
  | 'restart'
  | 'sync'
  | 'update_config'
  | 'reboot';

@Entity('edge_commands')
@Index(['edgeId', 'status'])
@Index(['tenantId', 'issuedAt'])
export class EdgeCommand {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ══════════════════════════════════════════════════════════════════════════
  // RELATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  edgeId: string;

  @ManyToOne(() => EdgeInstance, (edge) => edge.commands, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'edgeId' })
  edge: EdgeInstance;

  @Column()
  tenantId: string;

  // ══════════════════════════════════════════════════════════════════════════
  // COMMAND
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  command: EdgeCommandType;

  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, any>;

  @Column({
    type: 'enum',
    enum: EdgeCommandStatus,
    default: EdgeCommandStatus.PENDING,
  })
  status: EdgeCommandStatus;

  // ══════════════════════════════════════════════════════════════════════════
  // TIMING
  // ══════════════════════════════════════════════════════════════════════════

  @CreateDateColumn()
  issuedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deliveredAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  executedAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // RESULT
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'text', nullable: true })
  resultMessage?: string;
}