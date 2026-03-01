// src/modules/scripts/entities/script.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant, User } from '@modules/index.entities';
import { ScriptType } from '@common/enums/index.enum';
@Entity('scripts')
@Index(['userId', 'type'])
@Index(['tenantId', 'type'])
export class Script extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNER
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  // ══════════════════════════════════════════════════════════════════════════
  // SCRIPT INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: ScriptType,
  })

  type: ScriptType;

  @Column({ default: 'javascript' })
  language: string;

  // ══════════════════════════════════════════════════════════════════════════
  // SCRIPT CODE
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'text' })
  code: string;

  @Column({ default: '1.0.0' })
  version: string;

  @Column({ default: 0 })
  lines: number;

  // ══════════════════════════════════════════════════════════════════════════
  // TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  lastModified: Date;

  @Column({ default: 0 })
  executionCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastExecutedAt?: Date;

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ══════════════════════════════════════════════════════════════════════════

  updateLines(): void {
    this.lines = this.code.split('\n').length;
    this.lastModified = new Date();
  }

  incrementExecutionCount(): void {
    this.executionCount += 1;
    this.lastExecutedAt = new Date();
  }
}
