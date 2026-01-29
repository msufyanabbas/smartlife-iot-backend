import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { CustomerUsersService } from './customer-users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('Customer Users')
@Controller('customer-users')
export class CustomerUsersController {
  constructor(private readonly customerUsersService: CustomerUsersService) {}

  /**
   * Assign a user to a customer
   */
  @Post('assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign a user to a customer' })
  @ApiResponse({ status: 200, description: 'User assigned successfully' })
  async assignUserToCustomer(
    @Body() body: { userId: string; customerId: string },
  ) {
    const user = await this.customerUsersService.assignUserToCustomer(
      body.userId,
      body.customerId,
    );
    return {
      message: 'User assigned to customer successfully',
      data: user,
    };
  }

  /**
   * Remove user from customer
   */
  @Delete('unassign/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove user from customer' })
  @ApiResponse({ status: 200, description: 'User removed successfully' })
  async removeUserFromCustomer(@Param('userId') userId: string) {
    const user = await this.customerUsersService.removeUserFromCustomer(userId);
    return {
      message: 'User removed from customer successfully',
      data: user,
    };
  }

  /**
   * Get all users for a specific customer
   */
  @Get('customer/:customerId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users for a customer' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async getUsersByCustomer(
    @Param('customerId') customerId: string,
    @Request() req,
  ) {
    // Validate access
    await this.customerUsersService.validateCustomerAccess(
      req.user,
      customerId,
    );

    const users = await this.customerUsersService.getUsersByCustomer(
      customerId,
    );
    return {
      message: 'Customer users retrieved successfully',
      data: users,
    };
  }

  /**
   * Get customer for a specific user
   */
  @Get('user/:userId/customer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customer for a user' })
  @ApiResponse({ status: 200, description: 'Customer retrieved successfully' })
  async getCustomerForUser(@Param('userId') userId: string) {
    const customer = await this.customerUsersService.getCustomerForUser(userId);
    return {
      message: customer
        ? 'Customer retrieved successfully'
        : 'User has no customer assigned',
      data: customer,
    };
  }

  /**
   * Bulk assign users to a customer
   */
  @Post('bulk-assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Bulk assign users to a customer' })
  @ApiResponse({ status: 200, description: 'Bulk assignment completed' })
  async bulkAssignUsersToCustomer(
    @Body() body: { userIds: string[]; customerId: string },
  ) {
    const result = await this.customerUsersService.bulkAssignUsersToCustomer(
      body.userIds,
      body.customerId,
    );
    return {
      message: 'Bulk assignment completed',
      data: result,
    };
  }

  /**
   * Transfer user from one customer to another
   */
  @Post('transfer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Transfer user to another customer' })
  @ApiResponse({ status: 200, description: 'User transferred successfully' })
  async transferUserToCustomer(
    @Body() body: { userId: string; newCustomerId: string },
  ) {
    const user = await this.customerUsersService.transferUserToCustomer(
      body.userId,
      body.newCustomerId,
    );
    return {
      message: 'User transferred successfully',
      data: user,
    };
  }

  /**
   * Get customers accessible by current user
   */
  @Get('accessible-customers')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customers accessible by current user' })
  @ApiResponse({ status: 200, description: 'Customers retrieved successfully' })
  async getAccessibleCustomers(@Request() req) {
    const customers = await this.customerUsersService.getAccessibleCustomers(
      req.user,
    );
    return {
      message: 'Accessible customers retrieved successfully',
      data: customers,
    };
  }

  /**
   * Get customer user statistics
   */
  @Get('customer/:customerId/statistics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get customer user statistics' })
  @ApiResponse({
    status: 200,
    description: 'Statistics retrieved successfully',
  })
  async getCustomerUserStatistics(@Param('customerId') customerId: string) {
    const stats = await this.customerUsersService.getCustomerUserStatistics(
      customerId,
    );
    return {
      message: 'Statistics retrieved successfully',
      data: stats,
    };
  }

  /**
   * Search users within a customer
   */
  @Get('customer/:customerId/search')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Search users within a customer' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchCustomerUsers(
    @Param('customerId') customerId: string,
    @Query('q') searchTerm: string,
    @Query('limit') limit?: number,
    @Request() req?,
  ) {
    // Validate access
    await this.customerUsersService.validateCustomerAccess(
      req.user,
      customerId,
    );

    const users = await this.customerUsersService.searchCustomerUsers(
      customerId,
      searchTerm,
      limit ? +limit : 10,
    );
    return {
      message: 'Search completed successfully',
      data: users,
    };
  }

  /**
   * Check if current user has access to a customer
   */
  @Get('check-access/:customerId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if user has access to a customer' })
  @ApiResponse({ status: 200, description: 'Access check completed' })
  async checkAccess(@Param('customerId') customerId: string, @Request() req) {
    const hasAccess = await this.customerUsersService.hasAccessToCustomer(
      req.user,
      customerId,
    );
    return {
      message: 'Access check completed',
      data: { hasAccess },
    };
  }
}