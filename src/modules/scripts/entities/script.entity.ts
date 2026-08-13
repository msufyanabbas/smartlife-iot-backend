// src/modules/scripts/entities/script.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import { ScriptType } from '@common/enums/index.enum';

@Entity('scripts')
@Index(['tenantId', 'userId']) // ✅ Added this for better queries
@Index(['tenantId', 'type'])
@Index(['userId', 'type'])
export class Script extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index() // ✅ Keep individual index on tenantId (frequently queried alone)
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // OWNER
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  userId: string; // ✅ REMOVED @Index() - already in composite index

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

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
  type: ScriptType; // ✅ REMOVED @Index() - already in composite index

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

  /**
   * Per-script sandbox timeout in milliseconds.
   *
   * Clamped to MAX_SCRIPT_TIMEOUT_MS by ScriptsService at execution time, so a
   * row edited directly in the database cannot buy itself a longer slice of the
   * event loop than the platform allows.
   */
  @Column({ type: 'int', default: 3000 })
  timeout: number;

  /** Seeded/system-provided example. Not editable through the CRUD surface. */
  @Column({ default: false })
  isSystem: boolean;

  // ══════════════════════════════════════════════════════════════════════════
  // TRACKING
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  lastModified: Date;

  @Column({ default: 0 })
  executionCount: number;

  @Column({ type: 'int', default: 0 })
  errorCount: number;

  @Column({ type: 'timestamp', nullable: true })
  lastExecutedAt?: Date;

  /** Wall-clock duration of the most recent execution, in milliseconds. */
  @Column({ type: 'int', nullable: true })
  lastExecutionTime?: number | null;

  /** Message from the most recent failed execution; cleared on success. */
  @Column({ type: 'text', nullable: true })
  lastError?: string | null;

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
