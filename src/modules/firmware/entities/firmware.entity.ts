import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { DeviceProfile } from '../../profiles/entities/device-profile.entity';

/**
 * A firmware package that can be assigned to devices / device profiles for OTA.
 * The binary itself lives on disk (see FirmwareService storage dir); this row
 * holds the metadata + checksum used by the OTA poll/download endpoints.
 */
@Entity('firmware')
@Index(['tenantId', 'version'])
@Index(['tenantId', 'deviceProfileId'])
export class Firmware extends BaseEntity {
  // ── Tenant scoping (REQUIRED) ─────────────────────────────────────────────
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'uuid', nullable: true })
  customerId?: string;

  // ── Optional profile targeting ────────────────────────────────────────────
  // When set, this firmware is intended for devices of this profile. OTA poll
  // matches on (version [+ profile]); a null profile means "any device".
  @Column({ type: 'uuid', nullable: true })
  deviceProfileId?: string;

  @ManyToOne('DeviceProfile', { nullable: true })
  @JoinColumn({ name: 'deviceProfileId' })
  deviceProfile?: Relation<DeviceProfile>;

  // ── Package info ──────────────────────────────────────────────────────────
  @Column()
  version: string; // e.g. '1.0.1'

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  // ── Binary storage ────────────────────────────────────────────────────────
  @Column()
  fileName: string; // original upload name

  @Column()
  storagePath: string; // absolute path on the server's disk

  @Column({ nullable: true })
  downloadUrl?: string; // device-facing URL (/ota/{token}/download)

  @Column({ type: 'int', default: 0 })
  size: number; // bytes

  @Column()
  checksum: string; // hex digest

  @Column({ default: 'sha256' })
  checksumAlgorithm: string;

  @Column({ nullable: true })
  contentType?: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;
}
