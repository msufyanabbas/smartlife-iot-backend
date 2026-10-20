// src/modules/scada/scada.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/users/entities/user.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import {
  ScadaDiagram,
  type ScadaBinding,
  type ScadaConnection,
  type ScadaElement,
} from './entities/scada-diagram.entity';
import { ScadaElementBinding } from './entities/scada-element-binding.entity';
import {
  SCADA_SYMBOL_CATALOGUE,
  applyScadaTransform,
  validateScadaBinding,
} from './scada-symbol.catalogue';
import type {
  CreateScadaDiagramDto,
  ScadaDiagramQueryDto,
  UpdateScadaDiagramDto,
} from './dto/scada-diagram.dto';

@Injectable()
export class ScadaService {
  private readonly logger = new Logger(ScadaService.name);

  constructor(
    @InjectRepository(ScadaDiagram)
    private readonly diagrams: Repository<ScadaDiagram>,
    @InjectRepository(ScadaElementBinding)
    private readonly bindingIndex: Repository<ScadaElementBinding>,
    @InjectRepository(Device)
    private readonly devices: Repository<Device>,
    /**
     * The repository, not `TelemetryService`.
     *
     * TelemetryModule imports WebsocketModule and NotificationsModule and
     * pulling the service in here closes a module-load cycle of the kind
     * `AiInsightsService` documents. The interlock below only needs one
     * tenant-scoped read, which the repository covers — and it does the
     * tenant predicate itself rather than relying on a service that once
     * accepted a `userId` it ignored (§4g).
     */
    @InjectRepository(Telemetry)
    private readonly telemetry: Repository<Telemetry>,
    private readonly dataSource: DataSource,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // SCOPING
  //
  // §4g: a falsy tenantId must DENY, not skip the predicate. SUPER_ADMIN is
  // the only legitimately tenant-less role and it returns before this is
  // reached, so anything else without a tenant is refused rather than handed
  // an unscoped query.
  // ══════════════════════════════════════════════════════════════════════════

  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'This account has no tenant, so it cannot own SCADA diagrams. ' +
          'Use a tenant-scoped account.',
      );
    }
    return user.tenantId;
  }

  /**
   * Resolve one diagram for this caller, or 404.
   *
   * 404 and not 403 for a row outside the caller's scope: a 403 confirms the
   * id exists, which turns the detail route into an enumeration oracle
   * (§4g).
   */
  private async resolveForUser(
    id: string,
    user: User,
  ): Promise<ScadaDiagram> {
    const where: Record<string, unknown> = { id };

    if (user?.role !== UserRole.SUPER_ADMIN) {
      where.tenantId = this.tenantOf(user);

      // A customer-scoped caller sees its own customer's diagrams and the
      // tenant-wide ones (customerId null), never another customer's.
      if (
        (user.role === UserRole.CUSTOMER ||
          user.role === UserRole.CUSTOMER_USER) &&
        user.customerId
      ) {
        const found = await this.diagrams
          .createQueryBuilder('d')
          .where('d.id = :id', { id })
          .andWhere('d.tenantId = :tenantId', { tenantId: user.tenantId })
          .andWhere('(d.customerId = :customerId OR d.customerId IS NULL)', {
            customerId: user.customerId,
          })
          .getOne();
        if (!found) throw new NotFoundException('SCADA diagram not found');
        return found;
      }
    }

    const diagram = await this.diagrams.findOne({ where: where as any });
    if (!diagram) throw new NotFoundException('SCADA diagram not found');
    return diagram;
  }

  /**
   * Every device id a payload binds to must belong to this tenant.
   *
   * This is the load-bearing check in the whole module. The bindings live in
   * jsonb, so there is no foreign key to lean on — nothing in the database
   * stops a crafted save from pointing an element at another tenant's device
   * id and then reading its telemetry through the runtime. The ids are
   * resolved as a set, once, and a single unknown id fails the save.
   *
   * It reports the ids that were refused WITHOUT saying whether they exist,
   * for the same reason the detail route answers 404.
   */
  private async assertDevicesInTenant(
    deviceIds: string[],
    tenantId: string,
  ): Promise<void> {
    if (deviceIds.length === 0) return;

    const found = await this.devices.find({
      where: { id: In(deviceIds), tenantId },
      select: ['id'],
    });
    const ok = new Set(found.map((d) => d.id));
    const refused = deviceIds.filter((id) => !ok.has(id));

    if (refused.length > 0) {
      throw new BadRequestException(
        `These devices are not available to this tenant: ${refused.join(', ')}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Static analysis of a diagram, returned with every read and every save.
   *
   * Modelled on `RulesService.validateGraph()` and for the same reason: each
   * of these is a diagram that saves cleanly and then quietly does the wrong
   * thing. A binding whose transform outputs a state the symbol does not have
   * is the worst of them — the element simply never changes, and from the
   * screen that is indistinguishable from a device that never reports.
   */
  validateDiagram(diagram: {
    elements?: ScadaElement[] | null;
    connections?: ScadaConnection[] | null;
  }): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const elements = diagram.elements ?? [];
    const connections = diagram.connections ?? [];
    const elementIds = new Set(elements.map((e) => e.id));

    if (elementIds.size !== elements.length) {
      errors.push('Two elements share an id');
    }

    for (const element of elements) {
      const symbol = SCADA_SYMBOL_CATALOGUE[element.symbolKey];
      if (!symbol) {
        errors.push(`${element.id}: unknown symbol "${element.symbolKey}"`);
        continue;
      }

      const name = element.label || symbol.label;

      if (
        element.defaultState &&
        !symbol.states.some((s) => s.key === element.defaultState)
      ) {
        errors.push(
          `${name}: "${element.defaultState}" is not a state of ${symbol.label}`,
        );
      }

      for (const binding of element.bindings ?? []) {
        for (const problem of validateScadaBinding(element.symbolKey, binding)) {
          errors.push(`${name}: ${problem}`);
        }
        if (
          binding.staleState &&
          !symbol.states.some((s) => s.key === binding.staleState)
        ) {
          errors.push(
            `${name}: stale state "${binding.staleState}" is not a state of ${symbol.label}`,
          );
        }
      }

      // An element with no bindings is legal — a pipe elbow or a title block
      // needs none — but one that COULD animate and does not is worth saying
      // out loud, because that is the gap between a mimic and a drawing.
      const hasLiveBinding = (element.bindings ?? []).some(
        (b) => b.source !== 'static',
      );
      if (!hasLiveBinding && symbol.states.length > 1 && !symbol.linear) {
        warnings.push(
          `${name}: has ${symbol.states.length} states but nothing bound to drive them — it will never change`,
        );
      }

      if (element.action) {
        if (!element.action.method?.trim()) {
          errors.push(`${name}: the action binding has no command method`);
        }
        if (!symbol.bindable.includes('action')) {
          warnings.push(
            `${name}: ${symbol.label} is not an interactive symbol, so an action on it is easy to click by accident`,
          );
        }
        for (const state of element.action.enabledStates ?? []) {
          if (!symbol.states.some((s) => s.key === state)) {
            errors.push(
              `${name}: action interlock names "${state}", which is not a state of ${symbol.label}`,
            );
          }
        }
        if (element.linkDiagramId) {
          errors.push(
            `${name}: has both an action and a diagram link — one click cannot do both`,
          );
        }
      }
    }

    for (const connection of connections) {
      if (!elementIds.has(connection.fromElementId)) {
        errors.push(
          `Connection ${connection.id} starts at element ${connection.fromElementId}, which is not on the diagram`,
        );
      }
      if (!elementIds.has(connection.toElementId)) {
        errors.push(
          `Connection ${connection.id} ends at element ${connection.toElementId}, which is not on the diagram`,
        );
      }

      // A port that does not exist leaves the run drawn from the element's
      // origin, which looks like a routing bug rather than a bad reference.
      const from = elements.find((e) => e.id === connection.fromElementId);
      const to = elements.find((e) => e.id === connection.toElementId);
      const fromSymbol = from && SCADA_SYMBOL_CATALOGUE[from.symbolKey];
      const toSymbol = to && SCADA_SYMBOL_CATALOGUE[to.symbolKey];

      if (
        fromSymbol &&
        !fromSymbol.ports.some((p) => p.id === connection.fromPort)
      ) {
        warnings.push(
          `Connection ${connection.id}: ${fromSymbol.label} has no port "${connection.fromPort}"`,
        );
      }
      if (toSymbol && !toSymbol.ports.some((p) => p.id === connection.toPort)) {
        warnings.push(
          `Connection ${connection.id}: ${toSymbol.label} has no port "${connection.toPort}"`,
        );
      }

      for (const binding of connection.bindings ?? []) {
        if (!from) continue;
        for (const problem of validateScadaBinding(from.symbolKey, binding)) {
          warnings.push(`Connection ${connection.id}: ${problem}`);
        }
      }
    }

    return { errors, warnings };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BINDING INDEX
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Rewrite the flattened binding rows for a diagram.
   *
   * Delete-then-insert rather than a diff: a diagram's binding set is small
   * (tens, not thousands), the rows carry no state of their own, and a diff
   * would be a second place where the mirror could fall out of step with the
   * jsonb. Runs inside the caller's transaction so the index can never be
   * visible without the diagram that produced it.
   */
  private async reindexBindings(
    diagram: ScadaDiagram,
    manager = this.dataSource.manager,
  ): Promise<void> {
    const repo = manager.getRepository(ScadaElementBinding);

    // A hard delete, not a soft one: these are an index, and a soft-deleted
    // index row is just a row the queries have to remember to exclude.
    await repo.delete({ diagramId: diagram.id });

    // `QueryDeepPartialEntity`, not `Partial<Entity>`: `insert()` takes the
    // former, and an entity carrying jsonb columns (and therefore nested
    // object types) does not structurally satisfy it — the error reads as a
    // mismatch twelve levels down inside `elements[].action.params`.
    const rows: QueryDeepPartialEntity<ScadaElementBinding>[] = [];

    const push = (
      holder: 'element' | 'connection',
      elementId: string,
      symbolKey: string,
      binding: ScadaBinding,
    ) => {
      rows.push({
        tenantId: diagram.tenantId,
        diagramId: diagram.id,
        elementId,
        holder,
        symbolKey,
        property: binding.property,
        source: binding.source,
        deviceId: binding.deviceId ?? null,
        telemetryKey: binding.key ?? null,
        isAction: false,
        method: null,
      });
    };

    for (const element of diagram.elements ?? []) {
      for (const binding of element.bindings ?? []) {
        push('element', element.id, element.symbolKey, binding);
      }
      if (element.action) {
        rows.push({
          tenantId: diagram.tenantId,
          diagramId: diagram.id,
          elementId: element.id,
          holder: 'element',
          symbolKey: element.symbolKey,
          property: 'action',
          source: 'command',
          deviceId: element.action.deviceId,
          telemetryKey: null,
          isAction: true,
          method: element.action.method,
        });
      }
    }

    for (const connection of diagram.connections ?? []) {
      const from = (diagram.elements ?? []).find(
        (e) => e.id === connection.fromElementId,
      );
      for (const binding of connection.bindings ?? []) {
        push(
          'connection',
          connection.id,
          from?.symbolKey ?? 'pipe_segment',
          binding,
        );
      }
    }

    if (rows.length > 0) await repo.insert(rows);
  }

  /** Every device id the payload touches, bindings and actions alike. */
  private deviceIdsIn(payload: {
    elements?: ScadaElement[] | null;
    connections?: ScadaConnection[] | null;
  }): string[] {
    const ids = new Set<string>();
    for (const element of payload.elements ?? []) {
      for (const binding of element.bindings ?? []) {
        if (binding.deviceId) ids.add(binding.deviceId);
      }
      if (element.action?.deviceId) ids.add(element.action.deviceId);
    }
    for (const connection of payload.connections ?? []) {
      for (const binding of connection.bindings ?? []) {
        if (binding.deviceId) ids.add(binding.deviceId);
      }
    }
    return [...ids];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(user: User, query: ScadaDiagramQueryDto) {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 10), 100);

    const qb = this.diagrams
      .createQueryBuilder('d')
      .orderBy('d.updatedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (user?.role !== UserRole.SUPER_ADMIN) {
      qb.andWhere('d.tenantId = :tenantId', { tenantId: this.tenantOf(user) });

      if (
        (user.role === UserRole.CUSTOMER ||
          user.role === UserRole.CUSTOMER_USER) &&
        user.customerId
      ) {
        qb.andWhere('(d.customerId = :customerId OR d.customerId IS NULL)', {
          customerId: user.customerId,
        });
      }

      // An operator-level account has no business opening a draft mimic:
      // a half-wired diagram misreports plant state.
      if (user.role === UserRole.CUSTOMER_USER) {
        qb.andWhere('d.published = true');
      }
    }

    if (query.customerId) {
      qb.andWhere('d.customerId = :filterCustomer', {
        filterCustomer: query.customerId,
      });
    }
    if (query.published === 'true' || query.published === 'false') {
      qb.andWhere('d.published = :published', {
        published: query.published === 'true',
      });
    }
    if (query.tag) {
      qb.andWhere('d.tags @> :tag::jsonb', { tag: JSON.stringify([query.tag]) });
    }
    if (query.search) {
      qb.andWhere('(d.name ILIKE :q OR d.description ILIKE :q)', {
        q: `%${query.search}%`,
      });
    }

    const [data, total] = await qb.getManyAndCount();

    return {
      data: data.map((diagram) => this.summarise(diagram)),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /**
   * A list row without the geometry.
   *
   * `elements` and `connections` on a large mimic are tens of kilobytes of
   * jsonb each; sending twenty of them to render a list of names is how a
   * list page becomes slow for no reason. The counts are what the list
   * actually shows.
   */
  private summarise(diagram: ScadaDiagram) {
    return {
      id: diagram.id,
      name: diagram.name,
      description: diagram.description,
      customerId: diagram.customerId,
      width: diagram.width,
      height: diagram.height,
      published: diagram.published,
      publishedAt: diagram.publishedAt,
      revision: diagram.revision,
      tags: diagram.tags,
      elementCount: (diagram.elements ?? []).length,
      connectionCount: (diagram.connections ?? []).length,
      deviceCount: diagram.referencedDeviceIds().length,
      isStatic: diagram.isStatic(),
      createdAt: diagram.createdAt,
      updatedAt: diagram.updatedAt,
    };
  }

  /** Full read, with the validation report the editor shows. */
  async findOne(id: string, user: User) {
    const diagram = await this.resolveForUser(id, user);
    const issues = this.validateDiagram(diagram);

    return {
      diagram,
      issues,
      /**
       * What the runtime should subscribe to, computed server-side.
       *
       * The viewer could walk the bindings itself, but then the subscription
       * set and the binding set are derived in two places and drift. It also
       * means a diagram with 40 elements on 6 devices subscribes to 6 device
       * rooms rather than 40.
       */
      subscriptions: {
        deviceIds: diagram.referencedDeviceIds(),
        telemetryKeysByDevice: diagram.telemetryKeysByDevice(),
      },
    };
  }

  async create(user: User, dto: CreateScadaDiagramDto) {
    const tenantId = this.tenantOf(user);

    const elements = (dto.elements ?? []) as unknown as ScadaElement[];
    const connections = (dto.connections ?? []) as unknown as ScadaConnection[];

    await this.assertDevicesInTenant(
      this.deviceIdsIn({ elements, connections }),
      tenantId,
    );

    const { errors } = this.validateDiagram({ elements, connections });
    if (errors.length > 0) {
      throw new BadRequestException({
        message: 'The diagram has errors that would stop it animating',
        errors,
      });
    }

    const existing = await this.diagrams.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException(
        `A SCADA diagram called "${dto.name}" already exists in this tenant`,
      );
    }

    const diagram = this.diagrams.create({
      tenantId,
      customerId: dto.customerId ?? user.customerId ?? null,
      name: dto.name,
      description: dto.description ?? null,
      width: dto.width ?? 1600,
      height: dto.height ?? 900,
      background: dto.background ?? { colour: '#f8fafc', grid: 20, snap: true },
      elements,
      connections,
      tags: dto.tags ?? null,
      refreshIntervalMs: dto.refreshIntervalMs ?? null,
      published: false,
      revision: 1,
      createdBy: user.id,
    });

    const saved = await this.dataSource.transaction(async (manager) => {
      const row = await manager.getRepository(ScadaDiagram).save(diagram);
      await this.reindexBindings(row, manager);
      return row;
    });

    this.logger.log(
      `SCADA diagram created: ${saved.name} (${saved.id}) with ` +
        `${elements.length} elements for tenant ${tenantId}`,
    );

    return this.findOne(saved.id, user);
  }

  /**
   * Replace whatever the payload names.
   *
   * `elements` and `connections` are a REPLACE when present and untouched when
   * absent, which is what lets the canvas save in one request (the rule-chain
   * metadata route makes the same choice, for the same reason) while the list
   * page can rename a diagram without sending its geometry back.
   */
  async update(id: string, user: User, dto: UpdateScadaDiagramDto) {
    const diagram = await this.resolveForUser(id, user);
    const tenantId = diagram.tenantId;

    if (
      dto.expectedRevision !== undefined &&
      dto.expectedRevision !== diagram.revision
    ) {
      throw new ConflictException(
        `This diagram has been saved by someone else (revision ${diagram.revision}, ` +
          `you loaded ${dto.expectedRevision}). Reload before saving, or omit ` +
          `expectedRevision to overwrite.`,
      );
    }

    const geometryChanged =
      dto.elements !== undefined || dto.connections !== undefined;

    const elements = (dto.elements ?? diagram.elements ?? []) as ScadaElement[];
    const connections = (dto.connections ??
      diagram.connections ??
      []) as ScadaConnection[];

    if (geometryChanged) {
      await this.assertDevicesInTenant(
        this.deviceIdsIn({ elements, connections }),
        tenantId,
      );

      const { errors } = this.validateDiagram({ elements, connections });
      if (errors.length > 0) {
        throw new BadRequestException({
          message: 'The diagram has errors that would stop it animating',
          errors,
        });
      }
    }

    if (dto.name && dto.name !== diagram.name) {
      const clash = await this.diagrams.findOne({
        where: { tenantId, name: dto.name },
      });
      if (clash && clash.id !== diagram.id) {
        throw new ConflictException(
          `A SCADA diagram called "${dto.name}" already exists in this tenant`,
        );
      }
      diagram.name = dto.name;
    }

    if (dto.description !== undefined) diagram.description = dto.description;
    if (dto.customerId !== undefined) diagram.customerId = dto.customerId;
    if (dto.width !== undefined) diagram.width = dto.width;
    if (dto.height !== undefined) diagram.height = dto.height;
    if (dto.background !== undefined) diagram.background = dto.background;
    if (dto.tags !== undefined) diagram.tags = dto.tags;
    if (dto.refreshIntervalMs !== undefined) {
      diagram.refreshIntervalMs = dto.refreshIntervalMs;
    }

    if (geometryChanged) {
      diagram.elements = elements;
      diagram.connections = connections;
      diagram.revision = diagram.revision + 1;
    }

    diagram.updatedBy = user.id;

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ScadaDiagram).save(diagram);
      if (geometryChanged) await this.reindexBindings(diagram, manager);
    });

    return this.findOne(diagram.id, user);
  }

  async remove(id: string, user: User) {
    const diagram = await this.resolveForUser(id, user);

    // Soft delete, per §5 — but the index rows go for good, because a
    // soft-deleted mirror row would still match "which diagrams use this
    // device" and report a diagram nobody can open.
    await this.bindingIndex.delete({ diagramId: diagram.id });
    diagram.deletedBy = user.id;
    await this.diagrams.save(diagram);
    await this.diagrams.softDelete(diagram.id);

    return { success: true, id: diagram.id };
  }

  /**
   * Copy a diagram, geometry and bindings included.
   *
   * Device ids are kept, unlike a rule-chain export: a duplicate stays inside
   * the tenant it came from, so the ids still resolve. Exporting across
   * tenants would need them stripped, and that is a separate route this
   * module does not yet have.
   */
  async duplicate(id: string, user: User, name?: string) {
    const source = await this.resolveForUser(id, user);
    const tenantId = source.tenantId;

    let candidate = name?.trim() || `${source.name} (copy)`;
    // Keep trying rather than 409-ing: "duplicate" is a one-click action and
    // failing it on a name clash the user never typed is a bad trade.
    for (let suffix = 2; suffix < 50; suffix++) {
      const clash = await this.diagrams.findOne({
        where: { tenantId, name: candidate },
      });
      if (!clash) break;
      candidate = `${name?.trim() || source.name} (copy ${suffix})`;
    }

    const copy = this.diagrams.create({
      tenantId,
      customerId: source.customerId,
      name: candidate,
      description: source.description,
      width: source.width,
      height: source.height,
      background: source.background,
      elements: JSON.parse(JSON.stringify(source.elements ?? [])),
      connections: JSON.parse(JSON.stringify(source.connections ?? [])),
      tags: source.tags,
      refreshIntervalMs: source.refreshIntervalMs,
      // A copy lands UNPUBLISHED whatever the original was. Duplicating a
      // live mimic should not put a second, unreviewed one in front of
      // operators.
      published: false,
      revision: 1,
      createdBy: user.id,
    });

    const saved = await this.dataSource.transaction(async (manager) => {
      const row = await manager.getRepository(ScadaDiagram).save(copy);
      await this.reindexBindings(row, manager);
      return row;
    });

    return this.findOne(saved.id, user);
  }

  /**
   * Publish or unpublish.
   *
   * Publishing REFUSES a diagram with validation errors. That is the whole
   * point of the flag: an element whose binding cannot resolve shows its
   * default state, and a pump drawn stopped while it is running is the failure
   * mode a mimic exists to prevent. Warnings do not block — an unbound title
   * block is fine — and they are returned so the operator sees them.
   */
  async setPublished(id: string, user: User, published: boolean) {
    const diagram = await this.resolveForUser(id, user);
    const issues = this.validateDiagram(diagram);

    if (published && issues.errors.length > 0) {
      throw new BadRequestException({
        message:
          'This diagram cannot be published until its errors are fixed — ' +
          'an unresolved binding would show plant state that is not real',
        errors: issues.errors,
      });
    }

    diagram.published = published;
    diagram.publishedAt = published ? new Date() : null;
    diagram.updatedBy = user.id;
    await this.diagrams.save(diagram);

    return { ...this.summarise(diagram), issues };
  }

  /**
   * Which diagrams reference a device — the question the mirror table exists
   * to answer. Used before deleting a device, and from the device detail page.
   */
  async findByDevice(deviceId: string, user: User) {
    const tenantId =
      user?.role === UserRole.SUPER_ADMIN ? undefined : this.tenantOf(user);

    const qb = this.bindingIndex
      .createQueryBuilder('b')
      // `"d"."deleted_at"` is written quoted rather than as `d.deletedAt`: the
      // query builder rewrites `alias.property` to a column, and a diagram
      // that has been soft-deleted must not be reported as still using the
      // device — its index rows are hard-deleted on remove(), but a row
      // written by a concurrent save would otherwise slip through.
      .innerJoin(
        ScadaDiagram,
        'd',
        'd.id = b.diagramId AND "d"."deleted_at" IS NULL',
      )
      .select([
        'b.diagramId AS "diagramId"',
        'b.elementId AS "elementId"',
        'b.symbolKey AS "symbolKey"',
        'b.property AS "property"',
        'b.source AS "source"',
        'b.telemetryKey AS "telemetryKey"',
        'b.isAction AS "isAction"',
        'd.name AS "diagramName"',
        'd.published AS "published"',
      ])
      .where('b.deviceId = :deviceId', { deviceId });

    if (tenantId) qb.andWhere('b.tenantId = :tenantId', { tenantId });

    return qb.getRawMany();
  }

  /**
   * Resolve one element's action binding for execution.
   *
   * The controller needs three things the payload must not be trusted for: the
   * diagram is this tenant's, the element really carries that action, and the
   * action's device is this tenant's. All three are read from the stored
   * diagram, so a caller can only fire a command that an editor already put on
   * the canvas — the request names the element, never the command.
   */
  async resolveAction(diagramId: string, elementId: string, user: User) {
    const diagram = await this.resolveForUser(diagramId, user);
    const element = (diagram.elements ?? []).find((e) => e.id === elementId);

    if (!element) {
      throw new NotFoundException('Element not found on this diagram');
    }
    if (!element.action) {
      throw new BadRequestException(
        'This element has no action binding, so there is nothing to send',
      );
    }

    const device = await this.devices.findOne({
      where: { id: element.action.deviceId, tenantId: diagram.tenantId },
    });
    if (!device) {
      // The binding points at a device this tenant cannot reach — most likely
      // deleted since the diagram was drawn.
      throw new NotFoundException(
        'The device this action targets is no longer available',
      );
    }

    return { diagram, element, action: element.action, device };
  }

  /**
   * Resolve an element's CURRENT state from live data, server-side.
   *
   * Used to enforce `action.enabledStates` before a command is published. The
   * frontend already greys the button out, and that is not an interlock — it
   * is a hint. A `curl` against this route bypasses the UI entirely, and
   * "Start" on a drive that is in Hand, or "Open" on a valve that is tripped,
   * is precisely the command that must not get through.
   *
   * Returns `null` when the element has no `state` binding or has no reading
   * yet. `null` means "unknown", and the caller treats unknown as NOT enabled
   * whenever an interlock is declared — an interlock that fails open is not an
   * interlock.
   */
  async resolveLiveState(
    element: ScadaElement,
    tenantId: string,
  ): Promise<{ state: string | null; reason: string }> {
    const stateBinding = (element.bindings ?? []).find(
      (b) => b.property === 'state' && b.source !== 'static',
    );

    if (!stateBinding) {
      return { state: null, reason: 'the element has no live state binding' };
    }
    if (!stateBinding.deviceId || !stateBinding.key) {
      return { state: null, reason: 'the state binding is incomplete' };
    }

    const latest = await this.telemetry.findOne({
      where: {
        tenantId,
        deviceId: stateBinding.deviceId,
      },
      order: { timestamp: 'DESC' },
    });

    if (!latest) {
      return { state: null, reason: 'the device has reported no telemetry' };
    }

    if (stateBinding.staleAfterSeconds) {
      const ageSeconds =
        (Date.now() - new Date(latest.timestamp).getTime()) / 1000;
      if (ageSeconds > stateBinding.staleAfterSeconds) {
        return {
          state: stateBinding.staleState ?? null,
          reason: `the last reading is ${Math.round(ageSeconds)}s old`,
        };
      }
    }

    const raw = latest.data?.[stateBinding.key];
    const resolved = applyScadaTransform(stateBinding.transform, raw);

    if (resolved === null) {
      return {
        state: stateBinding.staleState ?? null,
        reason: `"${stateBinding.key}" did not resolve to a state`,
      };
    }

    return { state: String(resolved), reason: 'resolved from latest telemetry' };
  }
}
