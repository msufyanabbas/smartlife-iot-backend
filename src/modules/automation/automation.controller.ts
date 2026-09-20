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
import { AutomationService } from './automation.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { ExecuteAutomationDto } from './dto/execute-automation.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { PaginationDto } from '@common/dto/pagination.dto';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('Automations')
@Controller('automations')
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  // ── Create ────────────────────────────────────────────────────────────────

  @Post()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Create a new automation', 'Automation created')
  @ApiResponse({ status: 409, description: 'Name already used in this tenant' })
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @Body() dto: CreateAutomationDto,
  ) {
    return this.automationService.create(userId, tenantId, customerId, dto);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

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
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automationService.findOne(id, tenantId, customerId, role);
  }

  @Get(':id/logs')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get automation execution history', 'Paginated execution logs')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  getLogs(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.automationService.getLogs(id, tenantId, customerId, role, pagination);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  @Patch(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update automation', 'Automation updated')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  update(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
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
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automationService.toggle(id, tenantId, customerId, role);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete(':id')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @SwaggerAuth('Delete automation', 'Deleted successfully')
  @ApiResponse({ status: 404, description: 'Automation not found' })
  remove(
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.automationService.remove(id, tenantId, customerId, role);
  }

  // ── Manual execution ──────────────────────────────────────────────────────

  @Post(':id/execute')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Manually execute an automation', 'Execution result')
  @ApiResponse({ status: 400, description: 'Conditions did not pass for the supplied context' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  @ApiResponse({ status: 409, description: 'Automation is disabled' })
  execute(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | null,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: ExecuteAutomationDto,
  ) {
    return this.automationService.executeManually(
      id,
      tenantId,
      customerId,
      role,
      userId,
      dto ?? {},
    );
  }
}
