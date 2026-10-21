import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  SwaggerAuth,
  TenantAdminOnly,
  TenantOrCustomerAdmin,
} from '@common/decorators/access-control.decorator';
import { DefaultRuleChainsService } from './default-rule-chains.service';
import { DefaultRuleChainResolverService } from './default-rule-chain-resolver.service';
import {
  CreateDefaultRuleChainDto,
  DefaultRuleChainQueryDto,
  ResolveDefaultRuleChainDto,
  SetDefaultRuleChainDto,
  UpdateDefaultRuleChainDto,
} from './dto/default-rule-chain.dto';
import { DefaultRuleChainOriginatorType } from './default-rule-chain.enum';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

/**
 * Default rule chains — the mapping that decides which rule chain handles which
 * kind of incoming message.
 *
 * Every handler carries an explicit roles decorator: `RolesGuard` returns TRUE
 * for a handler with no `@Roles` metadata, so an undecorated route here would
 * let any authenticated user — CUSTOMER_USER included — repoint a tenant's
 * telemetry into a chain of their choosing. Writes are TENANT_ADMIN and above.
 *
 * ── What is wired ─────────────────────────────────────────────────────────
 * `RuleEngineConsumer` calls `DefaultRuleChainResolverService.resolve()` for
 * every message on `rules.input`. A match means exactly that chain is executed.
 * No match means the consumer falls through to `RuleEngineService.execute()`,
 * which is what it did before this module existed.
 *
 * Note that `execute()` fans a message out to EVERY active chain whose
 * `configuration.messageTypes` accepts it — it is not a root-chain-only
 * fallback, whatever CLAUDE.md §4f says. `GET /resolve` reports that
 * distinction explicitly rather than letting the screen imply otherwise.
 */
@ApiTags('Default Rule Chains')
@Controller('default-rule-chains')
export class DefaultRuleChainsController {
  constructor(
    private readonly service: DefaultRuleChainsService,
    private readonly resolver: DefaultRuleChainResolverService,
  ) {}

  @Get()
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'List message-type → rule chain mappings' })
  @SwaggerAuth('List default rule chains', 'Paginated mappings')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: DefaultRuleChainQueryDto,
  ) {
    return this.service.findAll(tenantId, query);
  }

  // These three literals must precede `:id`, or they are parsed as ids.
  @Get('message-types')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Suggested message types and the originator types available',
  })
  @SwaggerAuth('Message types', 'Suggestions')
  getMessageTypes() {
    return this.service.getMessageTypes();
  }

  @Get('statistics')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Mapping counts and how often each has matched',
    description:
      'Match counts are buffered in memory and flushed every 10 seconds, so the ' +
      'newest few seconds of traffic may be missing and a restart loses at most ' +
      'one flush interval.',
  })
  @SwaggerAuth('Default rule chain statistics', 'Counts per mapping')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.service.getStatistics(tenantId);
  }

  @Get('resolve')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Which chain would handle a message like this',
    description:
      'Runs the real resolver. Returns the matching mapping, or — when nothing ' +
      'matches — the tenant’s root chain with `appliedByConsumer: false` and ' +
      '`fanOut: true`, because the consumer then runs every active chain that ' +
      'accepts the message type rather than only the root chain.',
  })
  @SwaggerAuth('Resolve a default rule chain', 'The chain that would handle it')
  resolve(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: ResolveDefaultRuleChainDto,
  ) {
    return this.resolver.resolveWithRootFallback(tenantId, {
      messageType: query.messageType ?? 'TELEMETRY',
      originatorType:
        query.originatorType ?? DefaultRuleChainOriginatorType.DEVICE,
      originatorId: query.deviceId,
      deviceProfileId: query.deviceProfileId ?? null,
    });
  }

  @Get('type/:type')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'The catch-all mapping for an originator type',
    description:
      'The row with no messageType and no deviceProfileId — "the default chain ' +
      'for devices". 404 when none is configured.',
  })
  @SwaggerAuth('Default rule chain by type', 'The mapping')
  findByType(
    @CurrentUser('tenantId') tenantId: string,
    @Param('type') type: string,
  ) {
    return this.service.findByOriginatorType(tenantId, type);
  }

  @Post('type/:type')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'update default rule chain',
  })
  @RequirePermissions('automations:update')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Create or repoint the catch-all mapping for an originator type',
  })
  @SwaggerAuth('Set default rule chain by type', 'The mapping')
  setByType(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('type') type: string,
    @Body() dto: SetDefaultRuleChainDto,
  ) {
    return this.service.setForOriginatorType(tenantId, userId, type, dto);
  }

  @Get(':id')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({ summary: 'One mapping' })
  @SwaggerAuth('Get a default rule chain mapping', 'The mapping')
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(tenantId, id);
  }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'create default rule chain',
  })
  @RequirePermissions('automations:create')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Create a mapping',
    description:
      'Match on any combination of originator type, message type and device ' +
      'profile. Omit a field for "any". The most specific matching mapping wins; ' +
      '`priority` breaks ties. 409 when an identical key already exists.',
  })
  @SwaggerAuth('Create a default rule chain mapping', 'Mapping created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDefaultRuleChainDto,
  ) {
    return this.service.create(tenantId, userId, dto);
  }

  @Put(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'update default rule chain',
  })
  @RequirePermissions('automations:update')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Update a mapping' })
  @SwaggerAuth('Update a default rule chain mapping', 'Mapping updated')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDefaultRuleChainDto,
  ) {
    return this.service.update(tenantId, id, userId, dto);
  }

  // The shipped frontend client sends PATCH. Same handler.
  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'update default rule chain',
  })
  @RequirePermissions('automations:update')
  @TenantAdminOnly()
  @ApiOperation({ summary: 'Update a mapping (alias of PUT)' })
  @SwaggerAuth('Update a default rule chain mapping', 'Mapping updated')
  patch(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDefaultRuleChainDto,
  ) {
    return this.service.update(tenantId, id, userId, dto);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'delete default rule chain',
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('automations:delete')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Delete a mapping',
    description:
      'The rule chain itself is untouched. Messages that matched this mapping ' +
      'fall back to RuleEngineService.execute() from the next message on.',
  })
  @SwaggerAuth('Delete a default rule chain mapping', 'Mapping deleted')
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(tenantId, id);
  }
}
