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
import {
  TenantAdminOnly,
  CustomerAdminOnly,
  TenantOrCustomerAdmin,
} from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
} from 'class-validator';
import { RequirePermissions } from '@common/decorators/permission.decorator';

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

/**
 * Bodies for the bulk and reverse routes.
 *
 * `resourceIds` is capped at the DTO layer as well as in the service: the
 * global ValidationPipe runs `forbidNonWhitelisted`, so an oversized array
 * should be refused before it reaches a loop that does two writes per element.
 */
class ResourceIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  resourceIds: string[];
}

class BulkAssignToCustomerDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  resourceIds: string[];

  @IsEnum(['devices', 'dashboards', 'assets', 'floorPlans', 'automations'])
  resourceType: ResourceType;

  @IsString()
  customerId: string;
}

class BulkAssignToUserDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  resourceIds: string[];

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
  @RequirePermissions('customers:create')
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
  @RequirePermissions('customers:update')
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
  @RequirePermissions('customers:create')
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
  @RequirePermissions('customers:update')
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
  @RequirePermissions('customers:read')
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
  @RequirePermissions('customers:read')
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
  @RequirePermissions('customers:read')
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

  // ══════════════════════════════════════════════════════════════════════════
  // THE REVERSE DIRECTION — "who holds this device?"
  //
  // Everything above is customer-first. These are resource-first, which is
  // where the question is actually asked: you are looking at a device list
  // and want to hand one to a customer, exactly as ThingsBoard does it.
  // ══════════════════════════════════════════════════════════════════════════

  @Get('resource/:resourceType/:resourceId')
  @RequirePermissions('customers:read')
  @TenantOrCustomerAdmin()
  @ApiOperation({
    summary: 'Who holds this resource',
    description: 'The customers it is assigned to, and the individual users under them.',
  })
  @ApiResponse({ status: 200, description: 'Holders of the resource' })
  async listResourceHolders(
    @CurrentUser() user: User,
    @Param('resourceType') resourceType: ResourceType,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.assignmentService.listResourceHolders(
      resourceType,
      resourceId,
      user.tenantId,
    );
  }

  @Post('holders/:resourceType')
  @RequirePermissions('customers:update')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Holders for a page of resources',
    description:
      'POST rather than GET because a page of 50 uuids does not belong in a ' +
      'query string. Two queries, not 2N — an "Assigned to" column rendered ' +
      'one request per row is what this exists to prevent.',
  })
  @ApiResponse({ status: 200, description: 'Map of resourceId to its holders' })
  async listHoldersForMany(
    @CurrentUser() user: User,
    @Param('resourceType') resourceType: ResourceType,
    @Body() dto: ResourceIdsDto,
  ) {
    return this.assignmentService.listHoldersForMany(
      resourceType,
      dto.resourceIds,
      user.tenantId,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BULK
  //
  // Partial success is reported, not rolled back: with quotas in play the
  // 31st of 40 devices can legitimately be the one refused, and "30 done, 10
  // over the limit" is both the truth and the actionable answer.
  // ══════════════════════════════════════════════════════════════════════════

  @Post('customer/bulk')
  @RequirePermissions('customers:create')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign many resources to one customer' })
  @ApiResponse({ status: 200, description: 'Per-resource outcome' })
  async assignManyToCustomer(
    @CurrentUser() user: User,
    @Body() dto: BulkAssignToCustomerDto,
  ) {
    return this.assignmentService.assignManyToCustomer(
      dto.resourceIds,
      dto.resourceType,
      dto.customerId,
      user,
    );
  }

  @Post('user/bulk')
  @RequirePermissions('customers:create')
  @CustomerAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign many resources to one user' })
  @ApiResponse({ status: 200, description: 'Per-resource outcome' })
  async assignManyToUser(
    @CurrentUser() user: User,
    @Body() dto: BulkAssignToUserDto,
  ) {
    return this.assignmentService.assignManyToUser(
      dto.resourceIds,
      dto.resourceType,
      dto.userId,
      user,
    );
  }

  @Post('customer/bulk-unassign')
  @RequirePermissions('customers:create')
  @TenantAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign many resources from one customer' })
  @ApiResponse({ status: 200, description: 'Per-resource outcome' })
  async unassignManyFromCustomer(
    @CurrentUser() user: User,
    @Body() dto: BulkAssignToCustomerDto,
  ) {
    return this.assignmentService.unassignManyFromCustomer(
      dto.resourceIds,
      dto.resourceType,
      dto.customerId,
      user,
    );
  }

  @Post('user/bulk-unassign')
  @RequirePermissions('customers:create')
  @CustomerAdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unassign many resources from one user' })
  @ApiResponse({ status: 200, description: 'Per-resource outcome' })
  async unassignManyFromUser(
    @CurrentUser() user: User,
    @Body() dto: BulkAssignToUserDto,
  ) {
    return this.assignmentService.unassignManyFromUser(
      dto.resourceIds,
      dto.resourceType,
      dto.userId,
      user,
    );
  }
}
