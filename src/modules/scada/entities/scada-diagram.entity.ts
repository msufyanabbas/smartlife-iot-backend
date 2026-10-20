// src/modules/scada/entities/scada-diagram.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import type {
  ScadaBindableProperty,
  ScadaBindingSource,
  ScadaTransform,
} from '../scada-symbol.catalogue';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A binding: the one thing that makes this a mimic diagram and not a drawing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It says "this property of this element is driven by this live value, through
 * this transform". Without it an element is a static symbol; with it, a pump
 * spins because a pump is running.
 *
 * `deviceId` is a uuid and NOT enforced by a foreign key, on purpose. These
 * live inside a jsonb array — Postgres cannot put an FK on a value inside
 * jsonb, and promoting every binding to its own row with a real FK would make
 * saving a diagram an N-statement transaction instead of one UPDATE. The
 * tenant check at save time is what stops a crafted payload binding to another
 * tenant's device; `scada_element_bindings` then mirrors the bindings as rows
 * so "which diagrams use this device" is still an indexed query.
 */
export interface ScadaBinding {
  /** Stable id within the element, so the editor can edit one binding. */
  id: string;
  property: ScadaBindableProperty;
  source: ScadaBindingSource;
  /** Required for telemetry / attribute / alarm; absent for `static`. */
  deviceId?: string | null;
  /** Telemetry key, attribute key, or alarm type. */
  key?: string | null;
  /** Attribute scope — ignored for other sources. */
  scope?: 'client' | 'server' | 'shared' | null;
  /** How the raw value becomes a state, a number or a string. */
  transform?: ScadaTransform | null;
  /** A reading older than this many seconds resolves to `staleState`. */
  staleAfterSeconds?: number | null;
  /**
   * Which state a stale or missing reading resolves to. Default is the
   * symbol's own `defaultState`. The reason this is configurable: on a tank
   * "empty" is the honest answer to no data, on a pump it is not.
   */
  staleState?: string | null;
  label?: string | null;
}

/**
 * An action binding — write-back.
 *
 * Clicking the element issues a command to a device. Held separately from
 * `bindings` because it is a WRITE and the two have opposite risk profiles: a
 * read binding that is wrong shows the wrong colour, an action binding that is
 * wrong actuates the wrong plant. Keeping them in one array invited a UI that
 * treated them identically.
 *
 * `method` and `params` are passed to `GatewayService`; `rpc: true` uses the
 * two-way route and waits for the device's answer.
 */
export interface ScadaAction {
  id: string;
  /** Device the command is sent to. Resolved tenant-scoped at execution. */
  deviceId: string;
  method: string;
  params?: Record<string, unknown> | null;
  /** Two-way RPC rather than fire-and-forget. */
  rpc?: boolean;
  timeoutMs?: number | null;
  /** Shown in the confirmation dialog. An unconfirmed trip is a hazard. */
  confirm?: boolean;
  confirmMessage?: string | null;
  label?: string | null;
  /**
   * Only fire while the element is in one of these states. An interlock, not
   * a decoration: "Start" should be dead while the drive is in Hand.
   */
  enabledStates?: string[] | null;
}

/** A placed symbol. */
export interface ScadaElement {
  /** Client-generated; may be a `tmp-*` id on first save. */
  id: string;
  /** A key in `SCADA_SYMBOL_CATALOGUE`. */
  symbolKey: string;
  x: number;
  y: number;
  /** Degrees, clockwise, about the element's centre. */
  rotation: number;
  /** Uniform scale. Width/height come from the symbol's own box. */
  scale: number;
  /** Stacking order; higher draws later. */
  z: number;
  label?: string | null;
  labelPosition?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  /** State used when no `state` binding resolves. */
  defaultState?: string | null;
  bindings: ScadaBinding[];
  action?: ScadaAction | null;
  /** Navigate to another diagram on click. Mutually exclusive with `action`. */
  linkDiagramId?: string | null;
  /** Free notes, shown as a tooltip in the runtime. */
  note?: string | null;
  locked?: boolean;
}

/** A pipe or wire between two element ports. */
export interface ScadaConnection {
  id: string;
  fromElementId: string;
  fromPort: string;
  toElementId: string;
  toPort: string;
  /** How the run is drawn between the two ports. */
  routing: 'straight' | 'orthogonal' | 'curved';
  kind: 'pipe' | 'wire' | 'signal' | 'duct';
  /** Intermediate points in diagram coordinates, for a hand-routed run. */
  waypoints?: Array<{ x: number; y: number }>;
  /** A connection animates too — flow in a pipe is the clearest signal there is. */
  bindings?: ScadaBinding[];
  label?: string | null;
  colour?: string | null;
  width?: number | null;
}

export interface ScadaBackground {
  colour?: string | null;
  imageUrl?: string | null;
  /** Grid spacing in diagram units. 0 disables the grid. */
  grid?: number | null;
  snap?: boolean | null;
}

/**
 * A SCADA mimic diagram.
 *
 * The geometry lives in two jsonb columns rather than in element and
 * connection tables, matching how `Dashboard` stores its widgets and for the
 * same reason the rule-engine metadata route exists: an editor saves the WHOLE
 * canvas atomically. Splitting it into rows turns one save into a transaction
 * over three tables where a partial failure leaves connections pointing at
 * elements that were never inserted.
 */
@Entity('scada_diagrams')
@Index(['tenantId', 'published'])
@Index(['tenantId', 'customerId'])
@Unique('UQ_scada_diagrams_tenant_name', ['tenantId', 'name'])
export class ScadaDiagram extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  /** Optional customer scoping, like every other tenant-owned resource. */
  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  /** Canvas size in diagram units. The viewer fits this to its viewport. */
  @Column({ type: 'integer', default: 1600 })
  width: number;

  @Column({ type: 'integer', default: 900 })
  height: number;

  @Column({ type: 'jsonb', nullable: true })
  background?: ScadaBackground | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  elements: ScadaElement[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  connections: ScadaConnection[];

  /**
   * Published means "operators may open this".
   *
   * An unpublished diagram is a draft: it is still readable and editable by
   * whoever can edit diagrams, but the runtime list that operators see only
   * shows published ones. A half-wired mimic is worse than no mimic — it shows
   * a stopped pump that is actually running, because the binding is not
   * configured yet.
   */
  @Column({ type: 'boolean', default: false })
  published: boolean;

  @Column({ type: 'timestamp', nullable: true })
  publishedAt?: Date | null;

  /** Bumped on every geometry save, so a stale editor can be detected. */
  @Column({ type: 'integer', default: 1 })
  revision: number;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[] | null;

  /**
   * How often the runtime should re-poll REST when the socket is not
   * delivering. Null means use the client default.
   */
  @Column({ type: 'integer', nullable: true })
  refreshIntervalMs?: number | null;

  // ── Behaviour ─────────────────────────────────────────────────────────────

  /** Every distinct device id any binding or action on this diagram touches. */
  referencedDeviceIds(): string[] {
    const ids = new Set<string>();

    const collect = (bindings?: ScadaBinding[] | null) => {
      for (const binding of bindings ?? []) {
        if (binding.deviceId) ids.add(binding.deviceId);
      }
    };

    for (const element of this.elements ?? []) {
      collect(element.bindings);
      if (element.action?.deviceId) ids.add(element.action.deviceId);
    }
    for (const connection of this.connections ?? []) {
      collect(connection.bindings);
    }

    return [...ids];
  }

  /** The telemetry keys needed per device, for a targeted subscription. */
  telemetryKeysByDevice(): Record<string, string[]> {
    const out: Record<string, Set<string>> = {};

    const collect = (bindings?: ScadaBinding[] | null) => {
      for (const binding of bindings ?? []) {
        if (binding.source !== 'telemetry' || !binding.deviceId || !binding.key)
          continue;
        (out[binding.deviceId] ??= new Set()).add(binding.key);
      }
    };

    for (const element of this.elements ?? []) collect(element.bindings);
    for (const connection of this.connections ?? []) collect(connection.bindings);

    return Object.fromEntries(
      Object.entries(out).map(([device, keys]) => [device, [...keys]]),
    );
  }

  /** True when nothing on the diagram is driven by live data. */
  isStatic(): boolean {
    return this.referencedDeviceIds().length === 0;
  }
}
