// src/modules/floor-plans/entities/floor-plan-device.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import type { Relation } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Device } from '../../devices/entities/device.entity';
import type { FloorPlan } from './floor-plan.entity';
import { DeviceAnimationType } from '@common/enums/index.enum';

/**
 * Relational placement of a Device on a FloorPlan.
 *
 * Replaces the previous `floor_plans.devices` JSONB array, which had no foreign
 * keys — deleting a Device left a permanent orphan entry in the blob, and any
 * string at all could be stored as a `deviceId`. Placements now cascade with
 * both the floor plan and the device.
 *
 * The presentation fields (displayName .. telemetryBindings) exist so the legacy
 * `devices: Device3DData[]` response shape can be reconstructed exactly; they are
 * not used by the placement API itself.
 */
@Entity('floor_plan_devices')
@Unique(['floorPlanId', 'deviceId'])
@Index(['tenantId', 'floorPlanId'])
@Index(['tenantId', 'deviceId'])
export class FloorPlanDevice extends BaseEntity {
  // ── Tenant scoping ────────────────────────────────────────────────────────
  @Column()
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ── Placement target ──────────────────────────────────────────────────────
  @Column()
  floorPlanId: string;

  @ManyToOne('FloorPlan', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'floorPlanId' })
  floorPlan: Relation<FloorPlan>;

  @Column()
  deviceId: string;

  @ManyToOne('Device', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Relation<Device>;

  // ── Coordinates ───────────────────────────────────────────────────────────
  @Column({ type: 'double precision', default: 0 })
  x: number;

  @Column({ type: 'double precision', default: 0 })
  y: number;

  @Column({ type: 'double precision', default: 0 })
  z: number;

  @Column({ type: 'jsonb', nullable: true })
  rotation?: { x: number; y: number; z: number };

  @Column({ type: 'jsonb', nullable: true })
  scale?: { x: number; y: number; z: number };

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any>;

  // ── Legacy Device3DData presentation fields ───────────────────────────────
  // Retained so GET responses can still emit the original `devices[]` shape.
  @Column({ nullable: true })
  displayName?: string;

  @Column({ nullable: true })
  deviceTypeLabel?: string;

  @Column({ nullable: true })
  model3DUrl?: string;

  @Column({ type: 'varchar', nullable: true })
  animationType?: DeviceAnimationType;

  @Column({ type: 'jsonb', nullable: true })
  animationConfig?: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  telemetryBindings?: Record<string, any>;
}
