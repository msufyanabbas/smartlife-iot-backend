// src/modules/automations/automation.controller.ts
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
import { AutomationService } from './automation.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { PaginationDto } from '@common/dto/pagination.dto';
import { 
  TenantOrCustomerAdmin, 
  SwaggerAuth 
} from '@common/decorators/access-control.decorator';
import { RequireFeature } from '@common/decorators/feature.decorator';
import { RequireSubscriptionLimit } from '@common/decorators/subscription.decorator';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('Automations')
@Controller('automations')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  @Post()
  @TenantOrCustomerAdmin()  // ← Sets @Roles(TENANT_ADMIN, CUSTOMER_ADMIN)
  // @RequireFeature('automations')  // ← Check if automations feature is enabled
  // @RequireSubscriptionLimit({ resource: 'automations' })  // ← Check quota
  @SwaggerAuth('Create a new automation', 'Automation created')
  create(
    @CurrentUser('id') userId: string,  // ← Now works!
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Body() dto: CreateAutomationDto,
  ) {
    return this.automationService.create(userId, tenantId, customerId, dto);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  @Get()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all automations', 'List of automations')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Query() pagination: PaginationDto,
  ) {
    return this.automationService.findAll(tenantId, customerId, role, pagination);
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get automation statistics')
  getStatistics(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
  ) {
    return this.automationService.getStatistics(tenantId, customerId, role);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get automation by ID')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id') id: string,
  ) {
    return this.automationService.findOne(id, tenantId, customerId, role);
  }

  @Get(':id/logs')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get automation execution logs')
  getExecutionLogs(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query('limit') limit?: number,
  ) {
    return this.automationService.getExecutionLogs(id, tenantId, limit);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  @Patch(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update automation', 'Automation updated')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  update(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.automationService.update(id, userId, tenantId, customerId, role, dto);
  }

  @Post(':id/toggle')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Toggle automation on/off', 'Toggled successfully')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  toggle(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id') id: string,
  ) {
    return this.automationService.toggle(id, tenantId, customerId, role);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  @Delete(':id')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @SwaggerAuth('Delete automation', 'Deleted successfully')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id') id: string,
  ) {
    return this.automationService.remove(id, tenantId, customerId, role);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANUAL EXECUTION (For Testing)
  // ══════════════════════════════════════════════════════════════════════════

  @Post(':id/execute')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Manually execute automation', 'Executed successfully')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  @ApiResponse({ status: 409, description: 'Automation is disabled' })
  execute(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id') id: string,
  ) {
    return this.automationService.executeManually(id, tenantId, customerId, role);
  }
}