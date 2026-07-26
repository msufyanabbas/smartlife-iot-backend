import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { RulesService } from './rules.service';
import {
  CreateRuleChainDto,
  UpdateRuleChainDto,
  RuleChainQueryDto,
} from './dto/rule-chain.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';

@ApiTags('Rule Chains')
@Controller('rule-chains')
export class RulesController {
  constructor(private readonly rulesService: RulesService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
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
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all rule chains', 'List of rule chains')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: RuleChainQueryDto,
  ) {
    return this.rulesService.findAll(tenantId, query);
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get rule chain statistics')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.rulesService.getStatistics(tenantId);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get rule chain by ID')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  findOne(@CurrentUser('tenantId') tenantId: string, @Param('id') id: string) {
    return this.rulesService.findOne(tenantId, id);
  }

  @Get(':id/nodes')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all nodes in a rule chain')
  @ApiResponse({ status: 404, description: 'Rule chain not found' })
  findNodes(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
  ) {
    return this.rulesService.findNodes(tenantId, id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  @Patch(':id')
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

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  @Delete(':id')
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
