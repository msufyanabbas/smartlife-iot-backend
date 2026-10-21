// src/modules/protocols/opcua/opcua.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { OpcuaService } from './opcua.service';
import {
  CreateOpcuaServerDto,
  OPCUA_SECURITY_MODES,
  OPCUA_SECURITY_POLICIES,
  UpdateOpcuaServerDto,
} from './dto/opcua-server.dto';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { UserRole } from '@common/enums/index.enum';
import { User } from '@modules/index.entities';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OPC-UA server management
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * EVERY handler carries `@Roles`. `RolesGuard` returns **true** for a handler
 * with no `@Roles` metadata, so an undecorated route here would be open to
 * every authenticated account on the platform — including a CUSTOMER_USER in
 * another organisation — and these rows hold PLC credentials. That is exactly
 * the hole §4g found in `IntegrationsController`.
 *
 * `SUPER_ADMIN` is listed explicitly on every route: it has no bypass in
 * `RolesGuard`, despite what `access-control.decorator.ts` claims.
 */
@ApiTags('OPC-UA')
@Controller('opcua')
@ApiBearerAuth()
export class OpcuaController {
  constructor(private readonly service: OpcuaService) {}

  /**
   * An OPC-UA server row is tenant-scoped, and SUPER_ADMIN legitimately has no
   * tenant. Rather than widen every signature to `string | undefined` and risk
   * a falsy tenant producing an unscoped query (§4g), the tenant-less caller is
   * refused here with an explanation.
   */
  private tenantOf(user: User): string {
    if (!user?.tenantId) {
      throw new BadRequestException(
        'OPC-UA servers belong to an organisation. Sign in as a tenant ' +
          'administrator, or select a tenant first.',
      );
    }
    return user.tenantId;
  }

  @Get('security-options')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Security modes and policies this platform can negotiate',
    description:
      'The form is generated from this, so the client cannot offer a policy ' +
      'the server-side library does not implement. Basic128Rsa15 and Basic256 ' +
      'are deprecated by the OPC Foundation but still what most installed PLCs ' +
      'offer, so they are listed and flagged rather than withheld.',
  })
  getSecurityOptions() {
    const deprecated = new Set(['Basic128Rsa15', 'Basic256']);
    return {
      securityModes: OPCUA_SECURITY_MODES.map((value) => ({
        value,
        label: value,
      })),
      securityPolicies: OPCUA_SECURITY_POLICIES.map((value) => ({
        value,
        label: value,
        deprecated: deprecated.has(value),
      })),
      defaultPort: 4840,
      note:
        'Security mode None means the session is unauthenticated AND ' +
        'unencrypted on the wire. It is the factory default on most servers ' +
        'and is appropriate only on an isolated control network.',
    };
  }

  @Get('status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'Which of this organisation’s OPC-UA servers are live',
    description:
      'Reports the adapter’s in-process state filtered to this tenant’s rows, ' +
      'plus whether each row is running as a subscription or a poll.',
  })
  getStatus(@CurrentUser() user: User) {
    return this.service.getStatus(this.tenantOf(user));
  }

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @RequirePermissions('devices:read')
  @ApiOperation({ summary: 'OPC-UA servers for this organisation' })
  findAll(@CurrentUser() user: User) {
    return this.service.findAll(this.tenantOf(user));
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'One OPC-UA server (never includes the stored password)',
  })
  @ApiResponse({ status: 404, description: 'Not found, or not in your organisation' })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id, this.tenantOf(user));
  }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.DEVICE,
    description: 'create OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:create')
  @ApiOperation({ summary: 'Register an OPC-UA server' })
  @ApiResponse({ status: 201, description: 'Created' })
  create(@CurrentUser() user: User, @Body() dto: CreateOpcuaServerDto) {
    return this.service.create(this.tenantOf(user), user.id, dto);
  }

  @Put(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    description: 'update OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({
    summary: 'Update an OPC-UA server',
    description:
      'Omit `password` to keep the stored credential. Send an empty string to ' +
      'clear it, which switches the session to anonymous.',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOpcuaServerDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  // Two HTTP method decorators on one handler do NOT both register — Nest's
  // RequestMapping overwrites the path/method metadata — so PATCH gets its own
  // method that delegates. Both verbs exist because the shipped client sends
  // PATCH and Swagger consumers reach for PUT.
  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    description: 'update OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Update an OPC-UA server (alias of PUT)' })
  patch(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOpcuaServerDto,
  ) {
    return this.service.update(id, this.tenantOf(user), user.id, dto);
  }

  @Patch(':id/enabled')
  @Audit({
    action: AuditAction.ACTIVATE,
    entityType: AuditEntityType.DEVICE,
    description: 'activate OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @ApiOperation({ summary: 'Enable or disable polling of this server' })
  setEnabled(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('enabled') enabled: boolean,
  ) {
    return this.service.setEnabled(id, this.tenantOf(user), enabled !== false);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.DEVICE,
    description: 'delete OPC UA server',
    severity: AuditSeverity.WARNING,
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an OPC-UA server' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(id, this.tenantOf(user));
    return { success: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE OPERATIONS
  // ══════════════════════════════════════════════════════════════════════════

  @Post(':id/test')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.DEVICE,
    description: 'update OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Really connect to the server and read the mapped nodes',
    description:
      'Opens a TCP session, authenticates, reads ServerStatus, reads every ' +
      'mapped NodeId and — when the row uses subscriptions — creates and ' +
      'terminates a real subscription. A pass therefore means the adapter will ' +
      'work; a server that accepts a session and refuses subscriptions is a ' +
      'real configuration and is reported here rather than discovered from an ' +
      'empty chart tomorrow. Uses its own short-lived client, so it cannot ' +
      'disturb a running subscription.',
  })
  test(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.testConnection(id, this.tenantOf(user));
  }

  @Post('test')
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.DEVICE,
    description: 'create OPC UA server',
  })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a configuration before saving it',
    description:
      'So an endpoint and credential can be proven without first creating a ' +
      'row that does not work and that the adapter then keeps retrying.',
  })
  testDraft(@CurrentUser() user: User, @Body() dto: CreateOpcuaServerDto) {
    return this.service.testDraft(this.tenantOf(user), dto);
  }

  @Get(':id/browse')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @RequirePermissions('devices:read')
  @ApiOperation({
    summary: 'Browse the server’s address space to find NodeIds',
    description:
      'Defaults to the Objects folder (ns=0;i=85). `isVariable` marks the ' +
      'entries that can be mapped to a telemetry key — the rest are folders ' +
      'to navigate into. Without this the only way to fill in the node map is ' +
      'to run UaExpert and copy strings by hand.',
  })
  browse(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('nodeId') nodeId?: string,
  ) {
    return this.service.browse(id, this.tenantOf(user), nodeId);
  }
}
