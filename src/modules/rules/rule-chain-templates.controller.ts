import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RuleChainTemplatesService } from './rule-chain-templates.service';
import {
  CreateRuleChainTemplateDto,
  UpdateRuleChainTemplateDto,
  InstantiateRuleChainTemplateDto,
  RuleChainTemplateQueryDto,
} from './dto/rule-chain-template.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

/**
 * Rule chain templates.
 *
 * Separate controller rather than more routes on `rule-chains`, because
 * `GET /rule-chains/:id` would otherwise shadow nothing useful and the two
 * resources have genuinely different lifetimes: a template outlives the chains
 * made from it, and deleting one leaves them untouched.
 *
 * Every handler carries `@TenantOrCustomerAdmin()`. `RolesGuard` returns TRUE
 * for a handler with no `@Roles` metadata, so an undecorated route here would
 * be open to every authenticated user, CUSTOMER_USER included — which is
 * exactly the hole the integrations controller had.
 */
@ApiTags('Rule Chain Templates')
@Controller('rule-chain-templates')
export class RuleChainTemplatesController {
  constructor(private readonly templatesService: RuleChainTemplatesService) {}

  @Get()
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'List rule chain templates',
    description:
      'This tenant’s own templates plus the platform’s built-in ones. Use ?scope=mine or ?scope=builtin to narrow.',
  })
  @SwaggerAuth('List rule chain templates', 'Paginated templates')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: RuleChainTemplateQueryDto,
  ) {
    return this.templatesService.findAll(tenantId, query);
  }

  // Before `:id`, or "categories" is parsed as a template id.
  @Get('categories')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Template categories', 'Category names')
  getCategories(@CurrentUser('tenantId') tenantId: string) {
    return this.templatesService.getCategories(tenantId);
  }

  @Get(':id')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'One template, with its full definition and static analysis',
  })
  @SwaggerAuth('Get a rule chain template', 'The template')
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.templatesService.findOne(tenantId, id);
  }

  @Get(':id/export')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Download the definition',
    description:
      'The same JSON `POST /rule-chains/import` accepts, so a template can be moved between deployments.',
  })
  @SwaggerAuth('Export a template', 'Template definition')
  exportTemplate(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.templatesService.exportTemplate(tenantId, id);
  }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'create rule chain template',
  })
  @RequirePermissions('automations:create')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Create a template',
    description:
      'Supply `definition` to author one directly, or `fromRuleChainId` to capture an existing chain as it stands.',
  })
  @SwaggerAuth('Create a rule chain template', 'Template created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRuleChainTemplateDto,
  ) {
    return this.templatesService.create(tenantId, userId, dto);
  }

  @Post(':id/instantiate')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'update rule chain template',
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a rule chain from this template',
    description:
      'What the "Use" button calls. The new chain lands disabled unless `enabled: true` is passed — a template may carry placeholder endpoints. Returns the created chain so the client can open it in the editor.',
  })
  @SwaggerAuth('Use a template', 'Rule chain created')
  instantiate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: InstantiateRuleChainTemplateDto,
  ) {
    return this.templatesService.instantiate(tenantId, userId, id, dto);
  }

  @Put(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'update rule chain template',
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Update a template',
    description:
      'Built-in templates are read-only and answer 403. Pass `fromRuleChainId` to re-capture the definition from a chain as it is now.',
  })
  @SwaggerAuth('Update a rule chain template', 'Template updated')
  update(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRuleChainTemplateDto,
  ) {
    return this.templatesService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.RULE_CHAIN,
    description: 'delete rule chain template',
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('automations:delete')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Delete a template',
    description:
      'Chains already created from it are not affected. Built-ins answer 403.',
  })
  @SwaggerAuth('Delete a rule chain template', 'Template deleted')
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.templatesService.remove(tenantId, id);
  }
}
