// src/modules/scada/scada.controller.ts
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/users/entities/user.entity';
import { GatewayService } from '@modules/gateway/gateway.service';
import { ScadaService } from './scada.service';
import {
  SCADA_BINDABLE_PROPERTIES,
  SCADA_BINDING_SOURCES,
  SCADA_SYMBOL_CATALOGUE,
  SCADA_SYMBOL_CATEGORIES,
  SCADA_THRESHOLD_OPERATORS,
  SCADA_TRANSFORMS,
  applyScadaTransform,
} from './scada-symbol.catalogue';
import {
  CreateScadaDiagramDto,
  DuplicateScadaDiagramDto,
  EvaluateBindingDto,
  ExecuteScadaActionDto,
  PublishScadaDiagramDto,
  ScadaDiagramQueryDto,
  UpdateScadaDiagramDto,
} from './dto/scada-diagram.dto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SCADA mimic diagrams.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EVERY handler below carries `@Roles(...)` explicitly. §4g: `RolesGuard`
 * returns TRUE for a handler with no `@Roles` metadata, so an undecorated
 * route here would be open to every authenticated account on the platform —
 * and one of these routes ACTUATES PLANT. The same mistake was found eight
 * times in one pass across this codebase; `GatewayController`, which the
 * action route delegates to, is one of the places it was found.
 *
 * `SUPER_ADMIN` has no bypass in `RolesGuard` despite what the decorator
 * comments claim, so it is listed wherever it should reach.
 *
 * Permission strings reuse the `dashboards:*` family rather than minting
 * `scada:*`. A permission that the seeder never creates can never be granted
 * to anyone, which makes the route a permanent 403 for every CUSTOMER and
 * CUSTOMER_USER and looks like a guard bug rather than a missing seed
 * (`npm run check:permissions` exists for exactly this). A mimic diagram is a
 * visualisation, so the dashboard family is the honest fit.
 */
@ApiTags('SCADA')
@Controller('scada')
@ApiBearerAuth()
export class ScadaController {
  constructor(
    private readonly scada: ScadaService,
    private readonly gateway: GatewayService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CATALOGUE — the editor's palette
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The symbol library, served to the editor exactly as
   * `GET /rule-chains/catalogue` serves the node palette.
   *
   * Read by CUSTOMER_USER too: the runtime viewer needs the SVG bodies and the
   * state styling to render a diagram at all, and withholding the palette from
   * a read-only operator would mean shipping a second copy of every symbol in
   * the frontend bundle — which is the drift this whole pattern avoids.
   */
  @Get('symbols')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @ApiOperation({
    summary: 'The SCADA symbol library',
    description:
      'Every symbol with its inline SVG body, named states, state-driven ' +
      'parts, connection ports and the properties that may be bound to live ' +
      'data. The editor renders its palette and its binding form from this, ' +
      'and the runtime renders the diagram from it.',
  })
  @ApiResponse({ status: 200, description: 'The catalogue' })
  getSymbols() {
    return {
      categories: SCADA_SYMBOL_CATEGORIES,
      symbols: Object.values(SCADA_SYMBOL_CATALOGUE),
      bindableProperties: SCADA_BINDABLE_PROPERTIES,
      bindingSources: SCADA_BINDING_SOURCES,
      thresholdOperators: SCADA_THRESHOLD_OPERATORS,
      transforms: SCADA_TRANSFORMS,
    };
  }

  /**
   * Preview a transform without a device.
   *
   * `POST` rather than `GET` because the transform is a nested object, not a
   * query string. It performs no write and touches no row.
   */
  @Post('symbols/evaluate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a value through a transform',
    description:
      'What the runtime would do with this reading. Returns the resolved ' +
      'output and, for a `state` binding, whether that output is actually a ' +
      'state of the symbol — the mistake that makes an element never change.',
  })
  evaluate(@Body() dto: EvaluateBindingDto) {
    const resolved = applyScadaTransform(dto.transform, dto.value ?? null);
    const symbol = SCADA_SYMBOL_CATALOGUE[dto.symbolKey];
    const isState = dto.property === 'state';

    return {
      value: dto.value ?? null,
      resolved,
      resolvesToNothing: resolved === null,
      validState: isState
        ? symbol.states.some((s) => s.key === String(resolved))
        : null,
      availableStates: symbol.states.map((s) => ({
        key: s.key,
        label: s.label,
        tone: s.tone,
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DIAGRAMS
  // ══════════════════════════════════════════════════════════════════════════

  @Get('diagrams')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @RequirePermissions('dashboards:read')
  @ApiOperation({
    summary: 'List SCADA diagrams',
    description:
      'Summaries only — the geometry is tens of kilobytes of jsonb per row. ' +
      'A CUSTOMER_USER sees published diagrams only.',
  })
  findAll(@CurrentUser() user: User, @Query() query: ScadaDiagramQueryDto) {
    return this.scada.findAll(user, query);
  }

  @Get('diagrams/by-device/:deviceId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('dashboards:read')
  @ApiOperation({
    summary: 'Which diagrams reference a device',
    description:
      'Answered from `scada_element_bindings`, the flattened mirror of the ' +
      'bindings inside each diagram. Check this before deleting a device.',
  })
  findByDevice(
    @CurrentUser() user: User,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
  ) {
    return this.scada.findByDevice(deviceId, user);
  }

  /**
   * Declared AFTER `symbols` and `diagrams/by-device` so neither literal
   * segment is shadowed by this parameter — the ordering trap that makes
   * `/scada/symbols` resolve as a diagram id.
   */
  @Get('diagrams/:id')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @RequirePermissions('dashboards:read')
  @ApiOperation({
    summary: 'Read one diagram, with its validation report',
    description:
      'Returns `{ diagram, issues, subscriptions }`. `subscriptions` is the ' +
      'device and telemetry-key set the runtime should subscribe to, derived ' +
      'server-side from the bindings so the two cannot drift.',
  })
  @ApiResponse({ status: 404, description: 'Not found, or not in your scope' })
  findOne(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.scada.findOne(id, user);
  }

  @Post('diagrams')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('dashboards:create')
  @ApiOperation({
    summary: 'Create a diagram',
    description:
      'Every device id any binding names is checked against the caller’s ' +
      'tenant before the row is written — the bindings live in jsonb, so no ' +
      'foreign key does it for us.',
  })
  @ApiResponse({ status: 400, description: 'Validation or device-scope error' })
  @ApiResponse({ status: 409, description: 'Name already used in this tenant' })
  create(@CurrentUser() user: User, @Body() dto: CreateScadaDiagramDto) {
    return this.scada.create(user, dto);
  }

  @Patch('diagrams/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('dashboards:update')
  @ApiOperation({
    summary: 'Update a diagram — the canvas saves through this in one request',
    description:
      '`elements` and `connections` are a REPLACE when present and left ' +
      'alone when absent, so the editor can write the whole canvas atomically ' +
      'while the list page renames without sending geometry back. Pass ' +
      '`expectedRevision` to get a 409 instead of overwriting a concurrent save.',
  })
  @ApiResponse({ status: 409, description: 'Revision conflict or name clash' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScadaDiagramDto,
  ) {
    return this.scada.update(id, user, dto);
  }

  @Post('diagrams/:id/duplicate')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('dashboards:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Duplicate a diagram',
    description:
      'Bindings and device ids are kept — a copy stays inside its tenant, so ' +
      'they still resolve. The copy always lands unpublished.',
  })
  duplicate(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateScadaDiagramDto,
  ) {
    return this.scada.duplicate(id, user, dto.name);
  }

  @Post('diagrams/:id/publish')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('dashboards:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish or unpublish a diagram',
    description:
      'Publishing is REFUSED while the diagram has validation errors. An ' +
      'element whose binding cannot resolve renders its default state, and a ' +
      'pump drawn stopped while it is running is the exact failure a mimic ' +
      'exists to prevent. Warnings do not block.',
  })
  @ApiResponse({ status: 400, description: 'The diagram still has errors' })
  publish(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishScadaDiagramDto,
  ) {
    return this.scada.setPublished(id, user, dto.published);
  }

  @Delete('diagrams/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('dashboards:delete')
  @ApiOperation({ summary: 'Soft-delete a diagram' })
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.scada.remove(id, user);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITE-BACK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Fire an element's action binding.
   *
   * The request names the DIAGRAM and the ELEMENT, never the command. The
   * method, the parameters and the target device are all read from the stored
   * diagram, so a caller can only issue a command an editor already placed on
   * the canvas. A route that took `{ deviceId, method }` from the body would
   * be a general-purpose device-control endpoint wearing a diagram's name, and
   * `@TenantOrCustomerAdmin()` on it would be the only thing between a
   * customer user and arbitrary plant.
   *
   * CUSTOMER_USER is deliberately included: an operator is the person who
   * presses Start. What protects the plant is that the command is fixed by the
   * diagram and the interlock in `enabledStates` is enforced below, not that
   * operators are locked out of their own HMI.
   */
  @Post('diagrams/:id/elements/:elementId/action')
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER,
    UserRole.CUSTOMER_USER,
  )
  @RequirePermissions('devices:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send an element’s configured command to its device',
    description:
      'One-way by default; `rpc: true` on the action waits for the device’s ' +
      'answer and reports `status` (response | timeout | cancelled | sent). ' +
      'HTTP 200 means the command was carried out, not that the device ' +
      'succeeded — read `status`.',
  })
  @ApiResponse({ status: 400, description: 'The element has no action' })
  @ApiResponse({ status: 404, description: 'Diagram, element or device not found' })
  async executeAction(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('elementId') elementId: string,
    @Body() dto: ExecuteScadaActionDto,
  ) {
    const { action, device, element, diagram } =
      await this.scada.resolveAction(id, elementId, user);

    // ── Interlock ───────────────────────────────────────────────────────────
    //
    // Enforced HERE, not only in the UI. A greyed-out button is a hint; a
    // curl against this route ignores it. "Start" on a drive that is in Hand
    // is exactly the command that must not get through, so the element's live
    // state is resolved from the latest telemetry and an unknown state counts
    // as NOT enabled — an interlock that fails open is not an interlock.
    if (action.enabledStates && action.enabledStates.length > 0) {
      const { state, reason } = await this.scada.resolveLiveState(
        element,
        diagram.tenantId,
      );

      if (!state || !action.enabledStates.includes(state)) {
        throw new ConflictException({
          message:
            `This command is interlocked. It is only permitted while the ` +
            `element is in: ${action.enabledStates.join(', ')}.`,
          currentState: state,
          reason,
        });
      }
    }

    // Parameter overrides are merged OVER the stored ones, never replacing
    // them, and the method is never taken from the request.
    const params = { ...(action.params ?? {}), ...(dto.params ?? {}) };

    if (action.rpc) {
      const outcome = await this.gateway.sendRpcRequest(
        device.deviceKey,
        action.method,
        params,
        {
          timeoutMs: action.timeoutMs ?? undefined,
          waitForResponse: true,
          userId: user.id,
          tenantId: device.tenantId,
        },
      );
      // `outcome` already carries `method` and `deviceKey`; spread last so
      // the gateway's own report is what the caller sees.
      return { elementId: element.id, ...outcome };
    }

    await this.gateway.sendCommand(device.deviceKey, {
      method: action.method,
      params,
    });

    return {
      elementId: element.id,
      deviceKey: device.deviceKey,
      method: action.method,
      status: 'sent',
      message: 'Command published to the broker',
    };
  }
}
