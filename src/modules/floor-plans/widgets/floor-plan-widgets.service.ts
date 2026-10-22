import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { applyAccessScope } from '@/common/scoping/apply-access-scope';
import { CadStandardsService } from '@modules/cad-standards/cad-standards.service';
import { Device } from '@modules/devices/entities/device.entity';
import { User } from '@modules/users/entities/user.entity';
import { FloorPlan } from '../entities/floor-plan.entity';
import {
  FloorPlanWidget,
  type FloorPlanWidgetKind,
  type WidgetAction,
} from '../entities/floor-plan-widget.entity';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Floor-plan control widgets
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"Add the widgets to the floor plan so I can turn on and off the lights, Air
 * conditioner, even the scenes and scenarios from the 3D model. Add
 * visualization to the widgets so when I turn on the light it reflecting this
 * action to the area."*
 *
 * A widget is a control placed at a point on a plan, bound to a device's
 * telemetry for its state and to stored commands for its actions, optionally
 * attached to a ZONE whose polygon is what gets lit or tinted when it is on.
 *
 * ── Three decisions worth knowing ──────────────────────────────────────────
 *
 * **1. The command lives in the database, never in the request.**
 * `POST .../widgets/:widgetId/action` names the WIDGET and the stored action
 * id. The method, the params and the target device are read from the stored
 * row. A body of `{ deviceId, method }` would make this a general-purpose
 * "send any command to any device" route wearing a light switch's name, and
 * it is reachable by a CUSTOMER_USER — which is correct, because an operator
 * is the person who presses the switch. What protects the plant is that the
 * command is fixed by the widget. This is the SCADA write-back rule (§4n),
 * and it applies for the same reason.
 *
 * **2. A widget's device is resolved in the caller's scope, every time.**
 * Both on write (you may not bind another tenant's device into your plan) and
 * on action (a widget whose device has since moved out of scope must stop
 * working). The widget's `deviceId` is a column with a real foreign key, but a
 * foreign key does not know about tenants — `applyAccessScope` does (§4g).
 *
 * **3. Importing from the drawing.** The client's own CAD standard already
 * says where the lights are: `SYM-LIGHT` on `E-LITE`, equipment on
 * `M-HVAC-EQPM`, and nineteen more symbols in the master template's section 9
 * legend. `importFromDrawing` creates one widget per marker, so a plan arrives
 * with its luminaires already placed instead of the operator dragging forty
 * icons onto it. They land UNBOUND — a drawing says where a light is, not
 * which device on this platform controls it, and guessing that binding would
 * wire a switch to the wrong lamp.
 */
@Injectable()
export class FloorPlanWidgetsService implements OnModuleInit {
  private readonly logger = new Logger(FloorPlanWidgetsService.name);
  private readonly standards = new CadStandardsService();

  /**
   * Resolved at init, not injected.
   *
   * `FloorPlansModule` importing `GatewayModule` would close a loop through
   * `ProtocolsModule`, and a module load cycle crashes `bootstrap()` (§4l).
   * `GatewayModule` registers the string token this looks up.
   */
  private gateway?: {
    sendCommand(
      deviceKey: string,
      command: { method: string; params?: Record<string, any> },
      actor?: { id: string; name: string; email: string },
    ): Promise<void>;
    sendRpc?(
      deviceKey: string,
      request: { method: string; params?: Record<string, any>; timeoutMs?: number },
      actor?: { id: string; name: string; email: string },
    ): Promise<any>;
  };

  constructor(
    @InjectRepository(FloorPlanWidget)
    private readonly widgetRepository: Repository<FloorPlanWidget>,
    @InjectRepository(FloorPlan)
    private readonly floorPlanRepository: Repository<FloorPlan>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    // Non-fatal: a widget's state and placement are useful even where
    // commanding is unavailable, and a floor plan must not stop the
    // application booting. The action route reports the absence instead.
    try {
      this.gateway = this.moduleRef.get('GatewayService', { strict: false });
    } catch (error) {
      this.logger.warn(
        `GatewayService could not be resolved, so widget actions will be refused: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * Press a widget's action.
   *
   * The command is read from the STORED widget — see `resolveAction` and the
   * note at the top of this class. The caller names a widget and an action id
   * and nothing else.
   */
  async executeAction(
    floorPlanId: string,
    widgetId: string,
    actionId: string,
    user: User,
    options: { waitForResponse?: boolean } = {},
  ): Promise<{
    widget: string;
    action: string;
    deviceId: string;
    method: string;
    dispatched: boolean;
    response?: unknown;
    optimisticState?: string | number | boolean;
  }> {
    const { widget, action, deviceId, deviceKey } = await this.resolveAction(
      floorPlanId,
      widgetId,
      actionId,
      user,
    );

    if (!this.gateway) {
      throw new BadRequestException({
        code: 'COMMANDING_UNAVAILABLE',
        message:
          'The device gateway is not available in this deployment, so the command was not ' +
          'sent. The widget and its state are unaffected.',
      });
    }

    const actor = { id: user.id, name: user.name, email: user.email };
    let response: unknown;

    // ── A transport failure must not look like a broken widget ───────────
    //
    // Unwrapped, a disconnected broker surfaced as a bare 500 "MQTT client is
    // not connected" — which tells the operator nothing about whether the
    // widget is misconfigured or the infrastructure is down, and those need
    // completely different responses. The resolved method and device are
    // reported with the failure, so "the widget resolved correctly and the
    // broker is unreachable" is distinguishable from "this widget points at
    // nothing".
    try {
      if (options.waitForResponse && typeof this.gateway.sendRpc === 'function') {
        response = await this.gateway.sendRpc(
          deviceKey,
          { method: action.method, params: action.params },
          actor,
        );
      } else {
        await this.gateway.sendCommand(
          deviceKey,
          { method: action.method, params: action.params },
          actor,
        );
      }
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.error(
        `Widget ${widget.id} action "${action.id}" resolved to ${action.method} on ` +
          `${deviceKey} but could not be dispatched: ${reason}`,
      );
      throw new BadRequestException({
        code: 'DISPATCH_FAILED',
        message:
          `"${widget.label}" is configured correctly — it resolved to ${action.method} on ` +
          `device ${deviceKey} — but the command could not be delivered: ${reason}`,
        details: {
          widget: widget.id,
          action: action.id,
          deviceId,
          deviceKey,
          method: action.method,
          resolved: true,
          dispatched: false,
        },
      });
    }

    this.logger.log(
      `Widget ${widget.id} action "${action.id}" → ${action.method} on device ${deviceKey}`,
    );

    return {
      widget: widget.id,
      action: action.id,
      deviceId,
      method: action.method,
      dispatched: true,
      response,
      optimisticState: action.optimisticState,
    };
  }

  /**
   * The plan, scoped to the caller.
   *
   * 404 rather than 403 for a plan outside scope: a 403 confirms the id
   * exists, which turns every detail route into an enumeration oracle (§4g).
   */
  private async loadPlan(floorPlanId: string, user: User): Promise<FloorPlan> {
    const query = this.floorPlanRepository
      .createQueryBuilder('plan')
      .where('plan.id = :floorPlanId', { floorPlanId });
    applyAccessScope(query, 'plan', user, { includeUnassigned: true });

    const plan = await query.getOne();
    if (!plan) throw new NotFoundException('Floor plan not found');
    return plan;
  }

  /** A device the caller may actually bind, or a 404. */
  private async resolveDevice(deviceId: string, user: User): Promise<Device> {
    const query = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id = :deviceId', { deviceId });
    applyAccessScope(query, 'device', user, { includeUnassigned: true });

    const device = await query.getOne();
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  private assertZone(plan: FloorPlan, zoneId: string | null | undefined): void {
    if (!zoneId) return;
    const zones = Array.isArray(plan.zones) ? plan.zones : [];
    if (!zones.some((z) => z?.id === zoneId)) {
      throw new BadRequestException({
        code: 'UNKNOWN_ZONE',
        message:
          `This floor plan has no zone "${zoneId}". A widget's zone is what gets lit when it ` +
          `turns on, so an unknown id would leave the control working and the area dark.`,
        details: { available: zones.map((z) => ({ id: z.id, name: z.name })) },
      });
    }
  }

  /**
   * Validate the stored actions.
   *
   * Every action is checked here because this is the only gate: the action
   * route reads these rows verbatim and issues whatever they say. An action
   * with no method would fail at the device with a message about the device.
   */
  private async assertActions(
    actions: WidgetAction[] | undefined,
    kind: FloorPlanWidgetKind,
    ownDeviceId: string | null | undefined,
    user: User,
  ): Promise<WidgetAction[]> {
    const list = Array.isArray(actions) ? actions : [];

    if (kind === 'sensor') {
      if (list.length > 0) {
        throw new BadRequestException({
          code: 'SENSOR_HAS_ACTIONS',
          message: 'A sensor widget is read-only and cannot carry actions.',
        });
      }
      return [];
    }

    if (list.length === 0) {
      throw new BadRequestException({
        code: 'NO_ACTIONS',
        message:
          `A ${kind} widget needs at least one action, or it is a button that does nothing. ` +
          `A light normally has two: one to turn it on and one to turn it off.`,
      });
    }

    const ids = new Set<string>();
    for (const action of list) {
      if (!action?.id || !action?.method) {
        throw new BadRequestException({
          code: 'INVALID_ACTION',
          message: 'Every action needs an id and a method.',
          details: { action },
        });
      }
      if (ids.has(action.id)) {
        throw new BadRequestException({
          code: 'DUPLICATE_ACTION_ID',
          message:
            `Two actions share the id "${action.id}". The action route names an action by id, ` +
            `so a duplicate makes which one runs a matter of array order.`,
        });
      }
      ids.add(action.id);

      // A scene commands several devices, so each of its actions names its
      // own. Every one is scope-checked: a scene is the one widget kind that
      // can reach beyond a single device, which makes it the one worth
      // checking hardest.
      const target = action.deviceId ?? ownDeviceId;
      if (!target) {
        throw new BadRequestException({
          code: 'ACTION_HAS_NO_DEVICE',
          message:
            `Action "${action.id}" names no device and the widget has none of its own. ` +
            `A scene's actions must each name their target.`,
        });
      }
      await this.resolveDevice(target, user);
    }

    return list;
  }

  async list(floorPlanId: string, user: User): Promise<FloorPlanWidget[]> {
    const plan = await this.loadPlan(floorPlanId, user);
    return this.widgetRepository.find({
      where: { floorPlanId, tenantId: plan.tenantId },
      order: { createdAt: 'ASC' },
    });
  }

  async create(
    floorPlanId: string,
    user: User,
    dto: Partial<FloorPlanWidget>,
  ): Promise<FloorPlanWidget> {
    const plan = await this.loadPlan(floorPlanId, user);
    this.assertZone(plan, dto.zoneId);

    if (dto.deviceId) await this.resolveDevice(dto.deviceId, user);

    const kind = (dto.kind ?? 'switch') as FloorPlanWidgetKind;
    const actions = await this.assertActions(dto.actions, kind, dto.deviceId, user);

    if (kind !== 'scene' && !dto.deviceId) {
      throw new BadRequestException({
        code: 'DEVICE_REQUIRED',
        message: `A ${kind} widget controls a device, so it needs one. Only a scene does not.`,
      });
    }

    const widget = this.widgetRepository.create({
      ...dto,
      kind,
      actions,
      tenantId: plan.tenantId,
      floorPlanId,
      origin: dto.origin ?? 'manual',
    });

    const saved = await this.widgetRepository.save(widget);
    this.logger.log(`Widget ${saved.id} (${kind}) added to floor plan ${floorPlanId}`);
    return saved;
  }

  async update(
    floorPlanId: string,
    widgetId: string,
    user: User,
    dto: Partial<FloorPlanWidget>,
  ): Promise<FloorPlanWidget> {
    const plan = await this.loadPlan(floorPlanId, user);
    const widget = await this.widgetRepository.findOne({
      where: { id: widgetId, floorPlanId, tenantId: plan.tenantId },
    });
    if (!widget) throw new NotFoundException('Widget not found');

    if (dto.zoneId !== undefined) this.assertZone(plan, dto.zoneId);
    if (dto.deviceId) await this.resolveDevice(dto.deviceId, user);

    const kind = (dto.kind ?? widget.kind) as FloorPlanWidgetKind;
    const deviceId = dto.deviceId !== undefined ? dto.deviceId : widget.deviceId;

    if (dto.actions !== undefined || dto.kind !== undefined) {
      dto.actions = await this.assertActions(
        dto.actions ?? widget.actions,
        kind,
        deviceId,
        user,
      );
    }

    Object.assign(widget, dto);

    // `zoneId` and `deviceId` are explicitly nullable, and TypeORM reads
    // `undefined` as "leave this column alone" — so clearing one needs a real
    // null. Unbinding a widget from its zone is an ordinary thing to do, and
    // it silently did nothing before this.
    if (dto.zoneId === null) widget.zoneId = null;
    if (dto.deviceId === null) widget.deviceId = null;

    return this.widgetRepository.save(widget);
  }

  async remove(floorPlanId: string, widgetId: string, user: User): Promise<void> {
    const plan = await this.loadPlan(floorPlanId, user);
    const result = await this.widgetRepository.delete({
      id: widgetId,
      floorPlanId,
      tenantId: plan.tenantId,
    });
    if (!result.affected) throw new NotFoundException('Widget not found');
  }

  /**
   * Resolve a stored action into the command to issue.
   *
   * Returns the device KEY as well as the id, because the control routes key
   * on `deviceKey` (`POST /gateway/devices/:deviceKey/command`) and a widget
   * only ever holds a uuid — resolving that here is what stops every caller
   * doing it differently.
   *
   * The caller is told what WOULD be sent rather than this method sending it,
   * so the gateway stays the single place a command leaves the platform.
   */
  async resolveAction(
    floorPlanId: string,
    widgetId: string,
    actionId: string,
    user: User,
  ): Promise<{
    widget: FloorPlanWidget;
    action: WidgetAction;
    deviceId: string;
    deviceKey: string;
  }> {
    const plan = await this.loadPlan(floorPlanId, user);

    const widget = await this.widgetRepository.findOne({
      where: { id: widgetId, floorPlanId, tenantId: plan.tenantId },
    });
    if (!widget) throw new NotFoundException('Widget not found');

    if (!widget.enabled) {
      throw new BadRequestException({
        code: 'WIDGET_DISABLED',
        message: `"${widget.label}" is switched off, so its controls are refused.`,
      });
    }

    const action = (widget.actions ?? []).find((a) => a.id === actionId);
    if (!action) {
      throw new BadRequestException({
        code: 'UNKNOWN_ACTION',
        message: `"${widget.label}" has no action "${actionId}".`,
        details: { available: (widget.actions ?? []).map((a) => a.id) },
      });
    }

    const deviceId = action.deviceId ?? widget.deviceId;
    if (!deviceId) {
      throw new BadRequestException({
        code: 'ACTION_HAS_NO_DEVICE',
        message: `Action "${actionId}" has no target device.`,
      });
    }

    // Re-resolved at ACTION time, not trusted from the row. A device moved to
    // another customer, or soft-deleted, must stop being commandable through a
    // widget that still remembers it.
    const device = await this.resolveDevice(deviceId, user);

    return { widget, action, deviceId, deviceKey: device.deviceKey };
  }

  /**
   * Create widgets from the plan's own drawing symbols.
   *
   * Idempotent on `sourceMarkerId`: re-importing after the drawing is updated
   * adds what is new and leaves what exists alone, rather than stacking a
   * second luminaire on every one already placed.
   */
  async importFromDrawing(
    floorPlanId: string,
    user: User,
    options: { kinds?: FloorPlanWidgetKind[] } = {},
  ): Promise<{ created: number; skipped: number; byKind: Record<string, number> }> {
    const plan = await this.loadPlan(floorPlanId, user);

    const geometry = plan.parsedGeometry as Record<string, any> | null | undefined;
    const markers: any[] = Array.isArray(geometry?.devices) ? geometry!.devices : [];

    // The storey height the drawing states, or the usual 3 m. Ceiling-mounted
    // equipment is positioned relative to this, so a building with 4 m floors
    // puts its luminaires 1 m higher rather than leaving them stranded at the
    // default.
    const floorHeight = Number(geometry?.building?.floorHeight);
    const ceilingHeight = floorHeight > 1.8 ? floorHeight : 3;

    if (markers.length === 0) {
      throw new BadRequestException({
        code: 'NO_MARKERS_IN_DRAWING',
        message:
          'The drawing carries no equipment symbols, so there is nothing to import. Light ' +
          'fittings are expected on E-LITE and HVAC equipment on M-HVAC-EQPM, per the ' +
          'standard\'s symbol legend.',
      });
    }

    const existing = await this.widgetRepository.find({
      where: { floorPlanId, tenantId: plan.tenantId, origin: 'drawing' },
      select: ['id', 'sourceMarkerId'],
    });
    const taken = new Set(existing.map((w) => w.sourceMarkerId).filter(Boolean));

    const wanted = new Set(options.kinds ?? ['light', 'hvac']);
    const byKind: Record<string, number> = {};
    const toSave: FloorPlanWidget[] = [];
    let skipped = 0;

    for (const marker of markers) {
      const kind = this.kindForMarker(marker);
      if (!kind || !wanted.has(kind)) continue;

      const markerId = String(marker?.id ?? '');
      if (!markerId || taken.has(markerId)) {
        skipped++;
        continue;
      }

      const classification = this.standards.classify(String(marker?.layer ?? ''));
      const position = marker?.position ?? {};

      toSave.push(
        this.widgetRepository.create({
          tenantId: plan.tenantId,
          floorPlanId,
          kind,
          // The standard's own words for the layer ("Light fittings",
          // "HVAC equipment / FCUs") beat a generic guess, and the block name
          // beats both when the drawing used one.
          label:
            marker?.block ??
            classification.description ??
            (kind === 'light' ? 'Light fitting' : 'HVAC unit'),
          x: Number(position.x) || 0,
          y: Number(position.y) || 0,
          // ── The mounting height is an OFFSET FROM A PLANE ───────────────
          //
          // Not an absolute height. `mountMm` is 60 for `E-LITE`, and the
          // catalogue states the formula per plane:
          //
          //   'floor' / 'wall' → z = mountMm                (above FFL)
          //   'ceiling'        → z = ceilingHeight - mountMm (hangs below)
          //   'soffit'         → z = ceilingHeight + mountMm (in the void)
          //
          // Reading `mountMm` as the height put every luminaire 60 mm off the
          // floor instead of just under a 3 m ceiling — which the
          // verification caught as `z: 0.06`. A light at ankle height is not
          // a cosmetic error: it is what the 3D model shows and what the
          // operator clicks.
          z: mountHeight(classification, ceilingHeight),
          // UNBOUND on purpose. The drawing says where a light is; it does not
          // say which device on this platform controls it. Guessing that would
          // wire a switch to the wrong lamp, which is worse than an unbound
          // widget the operator can see and bind.
          deviceId: null,
          zoneId: this.zoneContaining(plan, position),
          stateKey: null,
          actions: [],
          enabled: false,
          origin: 'drawing',
          sourceMarkerId: markerId,
          visual:
            kind === 'light'
              ? { color: '#fde68a', intensity: 0.55, radiusM: 3, icon: 'lightbulb' }
              : { color: '#93c5fd', intensity: 0.4, radiusM: 4, icon: 'wind' },
          metadata: { layer: marker?.layer, block: marker?.block, deviceHint: marker?.deviceHint },
        }),
      );
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }

    if (toSave.length > 0) await this.widgetRepository.save(toSave);

    this.logger.log(
      `Imported ${toSave.length} widget(s) from the drawing of floor plan ${floorPlanId}`,
    );
    return { created: toSave.length, skipped, byKind };
  }

  /**
   * Which widget kind a drawing marker becomes, from the layer the standard
   * recognises. Returns null for a marker that is not a controllable thing —
   * a smoke detector is a sensor on a fire panel, not a switch.
   */
  private kindForMarker(marker: any): FloorPlanWidgetKind | null {
    const layer = String(marker?.layer ?? '').toUpperCase();
    const hint = String(marker?.deviceHint ?? '').toLowerCase();

    if (layer.startsWith('E-LITE') || hint === 'light') return 'light';
    if (layer.startsWith('M-HVAC') || layer.startsWith('M-CHIL') || hint === 'hvac') return 'hvac';
    if (layer.startsWith('E-POWR') || hint === 'socket') return 'switch';
    if (layer.startsWith('B-CTRL-DEVC') || hint.endsWith('_sensor')) return 'sensor';
    return null;
  }

  /** The zone whose polygon contains a point, if any. */
  private zoneContaining(
    plan: FloorPlan,
    position: { x?: number; y?: number },
  ): string | null {
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    for (const zone of Array.isArray(plan.zones) ? plan.zones : []) {
      const ring = zone?.boundaries;
      if (!Array.isArray(ring) || ring.length < 3) continue;
      if (pointInPolygon({ x, y }, ring)) return zone.id;
    }
    return null;
  }

  /**
   * Which widgets read or command this device.
   *
   * The answer to "what happens if I delete this device?", which is the same
   * question `GET /scada/diagrams/by-device/:deviceId` exists to answer for
   * mimic diagrams (§4n). Deleting a device sets the widget's `deviceId` to
   * NULL rather than removing the control, so without this route a floor plan
   * quietly accumulates dead switches.
   *
   * Two ways a device can be reached, and the second is the one a `find()`
   * cannot express: a SCENE names its targets inside the `actions` jsonb, so a
   * device can be commanded by a widget whose own `deviceId` is null. That
   * needs jsonb CONTAINMENT, hence the query builder.
   */
  async findByDevice(deviceId: string, user: User): Promise<FloorPlanWidget[]> {
    await this.resolveDevice(deviceId, user);

    return this.widgetRepository
      .createQueryBuilder('widget')
      .where('widget."tenantId" = :tenantId', { tenantId: user.tenantId })
      .andWhere(
        // `@>` asks "does this array contain an element with at least these
        // keys and values?", which matches an action object carrying the id
        // alongside its method and params. A `->>` path lookup would only
        // work for a fixed array index.
        '(widget."deviceId" = :deviceId OR widget.actions @> :actionMatch::jsonb)',
        { deviceId, actionMatch: JSON.stringify([{ deviceId }]) },
      )
      .orderBy('widget.created_at', 'ASC')
      .getMany();
  }

  /** Every device any widget on this plan can command, including scene targets. */
  async deviceIdsForPlan(floorPlanId: string, user: User): Promise<string[]> {
    const widgets = await this.list(floorPlanId, user);
    const ids = new Set<string>();
    for (const widget of widgets) {
      if (widget.deviceId) ids.add(widget.deviceId);
      for (const action of widget.actions ?? []) {
        if (action.deviceId) ids.add(action.deviceId);
      }
    }
    if (ids.size === 0) return [];

    // Filtered through the scope once more: the list is handed to a client
    // that will subscribe to each one's telemetry.
    const query = this.deviceRepository
      .createQueryBuilder('device')
      .where('device.id IN (:...ids)', { ids: [...ids] });
    applyAccessScope(query, 'device', user, { includeUnassigned: true });
    const devices = await query.select(['device.id']).getMany();
    return devices.map((d) => d.id);
  }
}

/**
 * Resolve a layer's mounting height into metres above finished floor level.
 *
 * The formula is the catalogue's own (see `MountPlane`): the stored `mountMm`
 * is an OFFSET from a named plane, not a height. Defaults to the floor plane
 * when the layer names none, which is right for plant and racks.
 */
function mountHeight(
  classification: { mount?: string; mountMm?: number },
  ceilingHeight: number,
): number {
  const offset = (classification.mountMm ?? 0) / 1000;
  switch (classification.mount) {
    case 'ceiling':
      return Math.max(0, ceilingHeight - offset);
    case 'soffit':
      return ceilingHeight + offset;
    case 'wall':
    case 'floor':
    default:
      return offset;
  }
}

/**
 * Ray casting. Lifted in rather than imported from the frontend's
 * `FloorPlanCanvas`, which has the same function — this is the server side of
 * the same question and cannot import from there.
 */
function pointInPolygon(
  point: { x: number; y: number },
  ring: Array<{ x: number; y: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;

    if (
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}
