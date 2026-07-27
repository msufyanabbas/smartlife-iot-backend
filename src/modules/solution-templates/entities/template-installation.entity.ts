// src/modules/solution-templates/entities/template-installation.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { InstallationStatus } from '../interfaces/template-configuration.interface';
import type { TemplateConfiguration } from '../interfaces/template-configuration.interface';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { User } from '../../users/entities/user.entity';
import type { SolutionTemplate } from './solution-template.entity';

/**
 * One row per attempt to install a SolutionTemplate into a tenant.
 *
 * Records exactly which entities were provisioned so that an installation can
 * later be audited, uninstalled, or upgraded, and so repeat installs can be
 * rejected (idempotency).
 *
 * NOTE: id / createdAt / updatedAt / deletedAt / createdBy / updatedBy come from
 * BaseEntity — they are deliberately not redeclared here.
 */
@Entity('template_installations')
@Index(['tenantId'])
@Index(['tenantId', 'templateId'])
@Index(['tenantId', 'status'])
export class TemplateInstallation extends BaseEntity {
  // ── Tenant scoping ────────────────────────────────────────────────────────

  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ nullable: true })
  customerId?: string;

  // ── Source template ───────────────────────────────────────────────────────

  @Column()
  templateId: string;

  @ManyToOne('SolutionTemplate', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'templateId' })
  template: Relation<SolutionTemplate>;

  // ── Who installed it ──────────────────────────────────────────────────────

  @Column()
  userId: string;

  @ManyToOne('User')
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  // ── Installation identity & lifecycle ─────────────────────────────────────

  @Column()
  installationName: string;

  @Column({
    type: 'enum',
    enum: InstallationStatus,
    default: InstallationStatus.INSTALLING,
  })
  status: InstallationStatus;

  @Column({ type: 'timestamp' })
  installedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt?: Date;

  @Column({ type: 'text', nullable: true })
  error?: string;

  // ── Provisioned resource IDs (enables uninstall / audit) ──────────────────

  @Column({ type: 'jsonb', default: [] })
  createdDeviceIds: string[];

  @Column({ type: 'jsonb', default: [] })
  createdDashboardIds: string[];

  @Column({ type: 'jsonb', default: [] })
  createdRuleChainIds: string[];

  @Column({ type: 'jsonb', default: [] })
  createdAlarmIds: string[];

  // ── Snapshots ─────────────────────────────────────────────────────────────

  /** The template configuration exactly as it was at install time. */
  @Column({ type: 'jsonb', nullable: true })
  configuration?: TemplateConfiguration;

  /** Whatever the caller passed as InstallTemplateDto.customization. */
  @Column({ type: 'jsonb', nullable: true })
  customization?: Record<string, any>;

  // ── Helpers ───────────────────────────────────────────────────────────────

  isSuccessful(): boolean {
    return this.status === InstallationStatus.SUCCESS;
  }

  totalResourcesCreated(): number {
    return (
      (this.createdDeviceIds?.length ?? 0) +
      (this.createdDashboardIds?.length ?? 0) +
      (this.createdRuleChainIds?.length ?? 0) +
      (this.createdAlarmIds?.length ?? 0)
    );
  }
}
