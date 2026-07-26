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
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NodesService } from './nodes.service';
import { CreateNodeDto } from './dto/create-node.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';

@ApiTags('nodes')
@Controller('nodes')
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  @Post()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Create a new node', 'Node created successfully')
  create(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Body() createDto: CreateNodeDto,
  ) {
    return this.nodesService.create(tenantId, userId, createDto);
  }

  @Get()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all nodes', 'List of nodes')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.nodesService.findAll(tenantId, paginationDto);
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get node statistics')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.nodesService.getStatistics(tenantId);
  }

  @Get('rule-chain/:ruleChainId')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get nodes by rule chain')
  findByRuleChain(
    @CurrentUser('tenantId') tenantId: string,
    @Param('ruleChainId') ruleChainId: string,
  ) {
    return this.nodesService.findByRuleChain(tenantId, ruleChainId);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get node by ID')
  @ApiResponse({ status: 404, description: 'Node not found' })
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.nodesService.findOne(id, tenantId);
  }

  @Patch(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update node', 'Node updated successfully')
  @ApiResponse({ status: 404, description: 'Node not found' })
  update(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateNodeDto,
  ) {
    return this.nodesService.update(id, tenantId, userId, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Delete node', 'Deleted successfully')
  @ApiResponse({ status: 404, description: 'Node not found' })
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.nodesService.remove(id, tenantId);
  }

  @Post(':id/toggle')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Toggle node enabled status', 'Toggled successfully')
  @ApiResponse({ status: 404, description: 'Node not found' })
  toggle(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.nodesService.toggle(id, tenantId, userId);
  }
}
