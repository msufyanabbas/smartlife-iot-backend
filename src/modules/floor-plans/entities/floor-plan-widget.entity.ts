import { Column, Entity, Index, JoinColumn, ManyToOne, type Relation } from 'typeorm';

import { BaseEntity } from '@common/entities/base.entity';
import type { Device } from '@modules/devices/entities/device.entity';
import type { Tenant } from '@modules/tenants/entities/tenant.entity';
import type { FloorPlan } from './floor-plan.entity';

/**
 * What kind of control this is. Varchar, not a PG enum — the integrations
 * lesson (§4e): a new TypeScript enum member alone passes `@IsEnum` and then
 * fails the INSERT with `invalid input value for enum`, and `migration:run` is
 * blocked (§11), so adding a kind must not need a migration.
 */
export type FloorPlanWidgetKind =
  /** A luminaire or lighting group. Illuminates its zone when on. */
  | 'light'
  /** An air conditioner / FCU. Tints its zone when cooling or heating. */
  | 'hvac'
  /** A generic on/off actuator — a pump, a door release, a socket. */
  | 'switch'
  /** Read-only: shows a measured value in place. */
  | 'sensor'
  /**
   * A stored set of commands across several devices — "Evening", "All Off".
   * Has no single `deviceId`; its targets live in `actions`.
   */
  | 'scene';

/**
 * How a raw telemetry value becomes the widget's displayed state.
 *
 * Deliberately the same shape as `ScadaTransform` (§4n), because the two
 * answer the same question and a second vocabulary for it would mean two
 * places to fix when a device reports `"ON"` instead of `true`. The frontend
 * resolver is shared for the same reason.
 */
export interface WidgetStateTransform {
  type: 'boolean' | 'threshold' | 'valueMap' | 'linear';
  /** `threshold`: at or above this is ON. */
  threshold?: number;
  /** `valueMap`: exact raw value → state. Keys are compared as strings. */
  valueMap?: Record<string, string | number | boolean>;
  /** `linear`: map [inMin,inMax] onto [outMin,outMax], for a dimmer. */
  inMin?: number;
  inMax?: number;
  outMin?: number;
  outMax?: number;
  /**
   * Seconds. A reading older than this resolves to `unknown` rather than to
   * its last value — a dead sensor must not leave a lamp drawn on. The same
   * rule as `staleAfterSeconds` on a SCADA binding, and for the same reason.
   */
  staleAfterSeconds?: number;
}

/**
 * One command this widget can issue.
 *
 * The METHOD and PARAMS live here, in the database, not in the request. See
 * the note on the action route in the service: a body of
 * `{ deviceId, method }` would turn one floor plan's light switch into a
 * general-purpose "send any command to any device" endpoint wearing a
 * widget's name. This is the SCADA write-back rule (§4n) applied here.
 */
export interface WidgetAction {
  /** Which stored command this is: the key the caller names. */
  id: string;
  label?: string;
  /** Target device. Defaults to the widget's own `deviceId` when omitted. */
  deviceId?: string;
  /** RPC/command method, e.g. `setState`, `control`. */
  method: string;
  params?: Record<string, any>;
  /**
   * Resulting state to show immediately, before the device confirms. The
   * device's own telemetry overrides it on the next frame; without it a lamp
   * does not visibly respond until the next poll, which reads as a dead
   * button.
   */
  optimisticState?: string | number | boolean;
}

/**
 * How the widget's state is drawn on the plan and in the 3D model.
 *
 * This is the "visualization" half of the request: *"when I turn on the light
 * it reflects this action to the area."* The widget knows its zone, and the
 * zone already carries a polygon (`FloorPlan.zones[].boundaries`), so lighting
 * the area is a matter of filling that polygon — no new geometry.
 */
export interface WidgetVisual {
  /** Hex. The colour of the spill when the widget is ON. */
  color?: string;
  /** 0–1. Opacity of the zone fill / intensity of the 3D light. */
  intensity?: number;
  /**
   * Metres. When the widget has no zone, the effect is drawn as a circle of
   * this radius around the widget instead, so an unzoned light still shows
   * something rather than nothing.
   */
  radiusM?: number;
  /** Icon key for the marker. Falls back to one derived from `kind`. */
  icon?: string;
}

@Entity('floor_plan_widgets')
@Index(['tenantId', 'floorPlanId'])
@Index(['tenantId', 'deviceId'])
export class FloorPlanWidget extends BaseEntity {
  @Column()
  tenantId: string;

  @ManyToOne('Tenant', { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant?: Relation<Tenant>;

  @Column()
  floorPlanId: string;

  @ManyToOne('FloorPlan', { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'floorPlanId' })
  floorPlan?: Relation<FloorPlan>;

  /**
   * Varchar with no PG enum — see the note on `FloorPlanWidgetKind`.
   */
  @Column({ type: 'varchar', length: 32 })
  kind: FloorPlanWidgetKind;

  @Column({ type: 'varchar', length: 160 })
  label: string;

  /**
   * The device this widget reads and commands. Nullable because a `scene` has
   * no single device — its targets are in `actions`.
   *
   * `onDelete: 'SET NULL'` rather than CASCADE: deleting a device should not
   * silently remove the control from the floor plan, because the operator who
   * finds a widget with no device can rebind it, while one who finds an empty
   * plan has no idea anything was ever there.
   */
  @Column({ nullable: true })
  deviceId?: string | null;

  @ManyToOne('Device', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'deviceId' })
  device?: Relation<Device>;

  /**
   * The zone whose area this widget affects, from `FloorPlan.zones`.
   *
   * A plain varchar, not a relation: zones live inside the floor plan's own
   * jsonb column, so there is no table to point a foreign key at. The service
   * validates that the id exists in the plan's `zones` on write — nothing in
   * the database can.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  zoneId?: string | null;

  /** Metres, in the drawing's own coordinates — the same space as `display.walls`. */
  @Column({ type: 'double precision', default: 0 })
  x: number;

  @Column({ type: 'double precision', default: 0 })
  y: number;

  /**
   * Metres above the floor. Ceiling height for a luminaire, which is where the
   * drawing standard mounts `E-LITE` (`mount: 'ceiling'`).
   */
  @Column({ type: 'double precision', default: 0 })
  z: number;

  /** Telemetry key reporting the current state, e.g. `switch_1`, `state`. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  stateKey?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  stateTransform?: WidgetStateTransform | null;

  @Column({ type: 'jsonb', default: [] })
  actions: WidgetAction[];

  @Column({ type: 'jsonb', nullable: true })
  visual?: WidgetVisual | null;

  /** Off keeps the widget on the plan but refuses its actions. */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * Where this widget came from. `drawing` means it was created by importing
   * the plan's own symbols (`SYM-LIGHT` on `E-LITE`, equipment on
   * `M-HVAC-EQPM`), which is what lets a re-import know not to duplicate it.
   */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  origin: 'manual' | 'drawing';

  /**
   * The drawing entity this came from, when `origin` is `drawing`. Used to
   * match on re-import instead of creating a second widget at the same point.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceMarkerId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, any> | null;

  /** True when this widget can be commanded at all. */
  isActuator(): boolean {
    return this.kind !== 'sensor' && this.actions.length > 0;
  }
}
