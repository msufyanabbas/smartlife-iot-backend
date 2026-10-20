// src/modules/scada/entities/scada-element-binding.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type { Device } from '../../devices/entities/device.entity';
import type { ScadaDiagram } from './scada-diagram.entity';

/**
 * A flattened mirror of the bindings inside `scada_diagrams.elements`.
 *
 * WHY A MIRROR AND NOT THE SOURCE OF TRUTH
 *
 * The diagram's geometry is saved atomically as jsonb (see ScadaDiagram), and
 * that has to stay: an editor writes the whole canvas or none of it. But jsonb
 * cannot answer the two questions operations actually asks —
 *
 *   "which diagrams would break if I delete this device?"
 *   "which diagrams are watching this telemetry key?"
 *
 * — without scanning and parsing every row. So `ScadaService.save()` rewrites
 * these rows from the diagram inside the same transaction. They are an INDEX,
 * never edited directly, and a route that read a binding from here instead of
 * from the diagram would be reading a cache.
 *
 * `deviceId` carries a real FK with ON DELETE CASCADE, which is the point:
 * deleting a device removes its index rows, and `GET /scada/diagrams/
 * by-device/:id` then correctly reports nothing rather than a dangling match.
 * The jsonb copy is left intact deliberately — silently stripping bindings out
 * of a saved diagram because a device was deleted would lose the operator's
 * work, where a binding that resolves to the stale state is visible and
 * fixable.
 */
@Entity('scada_element_bindings')
@Index(['tenantId', 'deviceId'])
@Index(['diagramId'])
@Index(['tenantId', 'deviceId', 'telemetryKey'])
export class ScadaElementBinding extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  @Column({ type: 'uuid' })
  diagramId: string;

  @ManyToOne('ScadaDiagram', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'diagramId' })
  diagram: Relation<ScadaDiagram>;

  /** The element (or connection) id inside the diagram's jsonb. */
  @Column({ type: 'varchar', length: 64 })
  elementId: string;

  /** 'element' or 'connection' — both carry bindings. */
  @Column({ type: 'varchar', length: 16, default: 'element' })
  holder: string;

  @Column({ type: 'varchar', length: 64 })
  symbolKey: string;

  @Column({ type: 'varchar', length: 32 })
  property: string;

  @Column({ type: 'varchar', length: 32 })
  source: string;

  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  /**
   * Declared as a relation, not just a column, so the FK and its cascade are
   * real rather than something the migration asserts and `synchronize` then
   * disagrees with — the trap `AiModel` documents.
   */
  @ManyToOne('Device', { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device?: Relation<Device> | null;

  /** Telemetry key, attribute key or alarm type, whichever the source means. */
  @Column({ type: 'varchar', length: 160, nullable: true })
  telemetryKey?: string | null;

  /** True for the element's action binding — a WRITE, not a read. */
  @Column({ type: 'boolean', default: false })
  isAction: boolean;

  /** The command an action binding sends. Null for read bindings. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  method?: string | null;
}
