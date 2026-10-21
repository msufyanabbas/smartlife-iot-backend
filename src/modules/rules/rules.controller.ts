import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiResponse, ApiOperation } from '@nestjs/swagger';
import { RulesService } from './rules.service';
import { RuleEngineService } from './rule-engine.service';
import {
  CreateRuleChainDto,
  UpdateRuleChainDto,
  RuleChainQueryDto,
} from './dto/rule-chain.dto';
import {
  SaveRuleChainMetadataDto,
  TestRuleChainDto,
} from './dto/rule-chain-metadata.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@ApiTags('Rule Chains')
@Controller('rule-chains')
export class RulesController {
  constructor(
    private readonly rulesService: RulesService,
    private readonly ruleEngineService: RuleEngineService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:create')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Create a new rule chain', 'Rule chain created')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRuleChainDto,
  ) {
    return this.rulesService.create(tenantId, userId, dto);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  @Get()
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all rule chains', 'List of rule chains')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: RuleChainQueryDto,
  ) {
    return this.rulesService.findAll(tenantId, query);
  }

  @Get('statistics')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get rule chain statistics')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.rulesService.getStatistics(tenantId);
  }

  @Get('catalogue')
  @RequirePermissions('automations:list')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'The rule-node palette',
    description:
      'Every node type with its label, category, icon, the output routes it can ' +
      'emit, and the configuration fields its form should render. The single ' +
      'source of truth for the editor palette AND the node config form: each ' +
      'field key here is read by that node type\'s processor, so a form built ' +
      'from this cannot drift into writing keys the engine ignores.\n\n' +
      '`outputs` is what tells the editor that a FILTER emits true/false while ' +
      'an ACTION emits success/failure. `dynamicOutputs: true` (SWITCH) means ' +
      'the routes come from the node\'s own cases instead.',
  })
  @ApiResponse({ status: 200, description: 'Node type manifests' })
  getCatalogue() {
    return this.rulesService.getNodeCatalogue();
  }

  @Post('import')
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:create')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Create a rule chain from an export',
    description:
      'Accepts the payload from GET /rule-chains/:id/export. Edges are carried ' +
      'as node INDEXES rather than ids, so an export moves between tenants ' +
      'without re-pointing at foreign rows.\n\n' +
      'The chain lands DISABLED: its nodes may reference device, script or ' +
      'integration ids from the source tenant, so going live should be a ' +
      'decision rather than a side effect of importing. A clashing name gets a ' +
      '" (1)" suffix rather than a 409.',
  })
  @ApiResponse({ status: 201, description: 'Imported chain with its graph' })
  @ApiResponse({ status: 400, description: 'Payload is not a rule chain export' })
  import(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() payload: any,
  ) {
    return this.rulesService.importChain(tenantId, userId, payload);
  }

  @Get(':id')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get rule chain by ID')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  findOne(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.rulesService.findOne(tenantId, id);
  }

  @Get(':id/nodes')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all nodes in a rule chain')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  findNodes(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.findNodes(tenantId, id);
  }

  @Get(':id/metadata')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'The whole graph, for the editor',
    description:
      'Returns `{ ruleChain, nodes, resolvedRootNodeId, issues }`. Nodes carry ' +
      'their canvas `position` and outgoing `connections`.\n\n' +
      '`resolvedRootNodeId` repeats the engine\'s own fallback — the node no ' +
      'edge targets — so the editor shows the entry point the engine will ' +
      'actually use rather than guessing differently.\n\n' +
      '`issues` is static analysis of the saved graph: nodes unreachable from ' +
      'the entry point, edges to deleted nodes, edges labelled with a route the ' +
      'node can never emit, and missing required configuration. Each of those ' +
      'is a chain that saves cleanly and then does nothing at runtime.',
  })
  @ApiResponse({ status: 200, description: 'Chain, nodes, entry point and issues' })
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  getMetadata(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.getMetadata(tenantId, id);
  }

  @Put(':id/metadata')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Replace the whole graph, in one transaction',
    description:
      'A REPLACE, not a merge: nodes of this chain absent from `nodes` are ' +
      'deleted. That is what makes a visual editor safe to save from — the ' +
      'alternative is a dozen node requests where any one can fail and leave ' +
      'edges pointing at nodes that were never created.\n\n' +
      'Node ids may be CLIENT-GENERATED temporary ids. A node just dropped on ' +
      'the canvas has no server id, but its edges already reference it; the ' +
      'server maps temporary ids to real ones after insert and rewrites every ' +
      'connection, so the editor never has to save in two phases.\n\n' +
      '`rootNodeId` may likewise be a temporary id. Omit it to let the engine ' +
      'fall back to the node nothing points at. Returns the same shape as GET.',
  })
  @ApiResponse({ status: 200, description: 'Saved graph with any remaining issues' })
  @ApiResponse({
    status: 400,
    description:
      'Graph is not valid — unknown node type, duplicate id, edge to a node not in the payload, or missing required config. Every problem is listed in `errors`.',
  })
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  saveMetadata(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SaveRuleChainMetadataDto,
  ) {
    return this.rulesService.saveMetadata(tenantId, id, userId, dto);
  }

  @Post(':id/test')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a sample message through the chain',
    description:
      'Returns the per-node trace: which nodes ran, which route each took, how ' +
      'long each took, and the first error. This is the only way to find out ' +
      'why a chain is not doing what you expect.\n\n' +
      'Execution counters are NOT touched — a few test payloads should not make ' +
      "a chain's health look worse than its real traffic did.\n\n" +
      'But the nodes do their real work: a test through a "create alarm" or ' +
      '"call REST API" node WILL create the alarm and make the call. There is ' +
      'no way to test an action node\'s configuration without performing it.',
  })
  @ApiResponse({ status: 200, description: 'Execution result with per-node trace' })
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  test(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: TestRuleChainDto,
  ) {
    return this.ruleEngineService.testChain(tenantId, id, {
      type: dto.type ?? 'TELEMETRY',
      data: dto.data ?? {},
      metadata: dto.metadata ?? {},
      originator: dto.originator,
    } as any);
  }

  @Get(':id/export')
  @RequirePermissions('automations:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Export the chain as portable JSON',
    description:
      'Ids, execution counters and tenant columns are stripped, and edges are ' +
      're-expressed against each node\'s INDEX in the array. An export therefore ' +
      'imports cleanly into another tenant instead of colliding on ids or ' +
      're-pointing at rows it does not own.',
  })
  @ApiResponse({ status: 200, description: 'Portable chain definition' })
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  export(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.exportChain(tenantId, id);
  }

  @Post(':id/duplicate')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Copy a chain, graph and all',
    description:
      'Export then import in one call, so the copy is a draft with its own ' +
      'node rows rather than edges shared with the original.',
  })
  @ApiResponse({ status: 201, description: 'The new chain and its graph' })
  duplicate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.duplicate(tenantId, id, userId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update rule chain', 'Rule chain updated')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRuleChainDto,
  ) {
    return this.rulesService.update(tenantId, id, userId, dto);
  }

  @Post(':id/activate')
  @Audit({
    action: AuditAction.ACTIVATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Activate a rule chain', 'Rule chain activated')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  activate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.activate(tenantId, id, userId);
  }

  @Post(':id/deactivate')
  @Audit({
    action: AuditAction.DEACTIVATE,
    entityType: AuditEntityType.RULE_CHAIN,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Deactivate a rule chain', 'Rule chain deactivated')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  deactivate(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.deactivate(tenantId, id, userId);
  }

  @Post(':id/root')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.RULE_CHAIN,
  })
  @RequirePermissions('automations:update')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make this the tenant\'s root chain',
    description:
      'Clears `isRoot` on every other chain in the same transaction. `isRoot` ' +
      'is a boolean per row rather than a pointer on the tenant, so without ' +
      'that unset two chains can both claim to be root and which one wins ' +
      'depends on row order.',
  })
  @ApiResponse({ status: 200, description: 'The chain, now root' })
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  setRoot(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.setRoot(tenantId, id, userId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.RULE_CHAIN,
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('automations:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Delete rule chain', 'Deleted successfully')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.delete(tenantId, id, userId);
  }
}
