// src/modules/assignments/assignment.controller.ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AssignmentService } from './assignment.service';
import type { ResourceType } from './assignment.service';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/index.entities';
import { TenantAdminOnly, CustomerAdminOnly } from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { IsEnum, IsString } from 'class-validator';

// ══════════════════════════════════════════════════════════════════════════
// DTOs
// ══════════════════════════════════════════════════════════════════════════

class AssignToCustomerDto {
  @IsString()
  resourceId: string;

  @IsEnum(['devices', 'dashboards', 'assets', 'floorPlans', 'automations'])
  resourceType: ResourceType;

  @IsString()
  customerId: string;
}

class AssignToUserDto {
  @IsString()
  resourceId: string;

  @IsEnum(['devices', 'dashboards', 'assets', 'floorPlans', 'automations'])
  resourceType: ResourceType;

  @IsString()
  userId: string;
}

// ══════════════════════════════════════════════════════════════════════════
// CONTROLLER
// ══════════════════════════════════════════════════════════════════════════

@ApiTags('Assignments')
@Controller('assignments')
@ApiBearerAuth()
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT ADMIN ENDPOINTS (Assign resources to customers)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Assign resource to customer
   * POST /assignments/customer
   */
  @Post('customer')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Assign resource to customer (Tenant Admin only)',
    description: 'Assign a device, dashboard, asset, floor plan, or automation to a customer'
  })
  @ApiResponse({ status: 200, description: 'Resource assigned successfully' })
  @ApiResponse({ status: 403, description: 'Permission or quota limit reached' })
  @ApiResponse({ status: 404, description: 'Customer or resource not found' })
  async assignToCustomer(
    @CurrentUser() user: User,
    @Body() dto: AssignToCustomerDto,
  ) {
    await this.assignmentService.assignResourceToCustomer(
      dto.resourceId,
      dto.resourceType,
      dto.customerId,
      user,
    );

    return {
      success: true,
      message: `${dto.resourceType.slice(0, -1)} assigned to customer successfully`,
    };
  }

  /**
   * Unassign resource from customer
   * DELETE /assignments/customer/:customerId/:resourceType/:resourceId
   */
  @Delete('customer/:customerId/:resourceType/:resourceId')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Unassign resource from customer (Tenant Admin only)',
    description: 'Remove resource assignment from customer (also removes all user assignments)'
  })
  @ApiResponse({ status: 200, description: 'Resource unassigned successfully' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  @ApiParam({ name: 'resourceType', enum: ['devices', 'dashboards', 'assets', 'floorPlans', 'automations'] })
  async unassignFromCustomer(
    @CurrentUser() user: User,
    @Param('customerId', ParseIdPipe) customerId: string,
    @Param('resourceType') resourceType: ResourceType,
    @Param('resourceId', ParseIdPipe) resourceId: string,
  ) {
    await this.assignmentService.unassignResourceFromCustomer(
      resourceId,
      resourceType,
      customerId,
      user,
    );

    return {
      success: true,
      message: `${resourceType.slice(0, -1)} unassigned from customer successfully`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMER ADMIN ENDPOINTS (Assign resources to users within their customer)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Assign resource to user (within your customer)
   * POST /assignments/user
   */
  @Post('user')
  @CustomerAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Assign resource to user (Customer Admin only)',
    description: 'Assign a resource to a user within your customer (resource must already be assigned to customer)'
  })
  @ApiResponse({ status: 200, description: 'Resource assigned to user successfully' })
  @ApiResponse({ status: 403, description: 'Permission or quota limit reached, or resource not assigned to customer' })
  @ApiResponse({ status: 404, description: 'User or resource not found' })
  async assignToUser(
    @CurrentUser() user: User,
    @Body() dto: AssignToUserDto,
  ) {
    await this.assignmentService.assignResourceToUser(
      dto.resourceId,
      dto.resourceType,
      dto.userId,
      user,
    );

    return {
      success: true,
      message: `${dto.resourceType.slice(0, -1)} assigned to user successfully`,
    };
  }

  /**
   * Unassign resource from user
   * DELETE /assignments/user/:userId/:resourceType/:resourceId
   */
  @Delete('user/:userId/:resourceType/:resourceId')
  @CustomerAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ 
    summary: 'Unassign resource from user (Customer Admin only)',
    description: 'Remove resource assignment from a user within your customer'
  })
  @ApiResponse({ status: 200, description: 'Resource unassigned from user successfully' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  @ApiParam({ name: 'resourceType', enum: ['devices', 'dashboards', 'assets', 'floorPlans', 'automations'] })
  async unassignFromUser(
    @CurrentUser() user: User,
    @Param('userId', ParseIdPipe) userId: string,
    @Param('resourceType') resourceType: ResourceType,
    @Param('resourceId', ParseIdPipe) resourceId: string,
  ) {
    await this.assignmentService.unassignResourceFromUser(
      resourceId,
      resourceType,
      userId,
      user,
    );

    return {
      success: true,
      message: `${resourceType.slice(0, -1)} unassigned from user successfully`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  //
  // This controller had assign and unassign and no GET at all, so a tenant
  // admin could grant a device to a customer and then had no way to see or
  // revoke it. These three are what an assignment screen is built on.
  // ══════════════════════════════════════════════════════════════════════════

  @Get('customer/:customerId')
  @TenantAdminOnly()
  @ApiOperation({
    summary: 'Everything assigned to a customer',
    description:
      'Grouped by resource type, joined to each resource so names come back ' +
      'rather than bare uuids.',
  })
  @ApiResponse({ status: 200, description: 'Assignments grouped by type' })
  async listCustomerAssignments(
    @CurrentUser() user: User,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.assignmentService.listCustomerAssignments(
      customerId,
      user.tenantId,
    );
  }

  @Get('user/:userId')
  @CustomerAdminOnly()
  @ApiOperation({ summary: 'Everything assigned to one user' })
  @ApiResponse({ status: 200, description: 'Assignments grouped by type' })
  async listUserAssignments(
    @CurrentUser() user: User,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.assignmentService.listUserAssignments(userId, user.tenantId);
  }

  @Get('assignable/:resourceType')
  @CustomerAdminOnly()
  @ApiOperation({
    summary: 'Resources that could still be assigned',
    description:
      'Pass customerId to see what the tenant holds and the customer does ' +
      'not. Pass userId to see what that user’s customer holds and the user ' +
      'does not — the assign path requires the customer to hold it first, so ' +
      'offering anything else would be a picker full of options the server ' +
      'refuses. Capped at 100; use `search` to reach the rest.',
  })
  @ApiQuery({ name: 'customerId', required: false, type: String })
  @ApiQuery({ name: 'userId', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Assignable resources' })
  async listAssignable(
    @CurrentUser() user: User,
    @Param('resourceType') resourceType: ResourceType,
    @Query('customerId') customerId?: string,
    @Query('userId') userId?: string,
    @Query('search') search?: string,
  ) {
    return this.assignmentService.listAssignableResources(
      resourceType,
      user.tenantId,
      { customerId, userId },
      search,
    );
  }
}
