import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { Roles } from '@/common/decorators/roles.decorator';
import { UserRole } from '@/common/enums/user.enum';
import { TenantListResponseDto, TenantMessageResponseDto } from './dto/tenant-response.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { RequirePermissions } from '@common/decorators/permission.decorator';

@ApiTags('tenants')
/**
 * Tenant administration — the platform operator's surface, not a tenant's own.
 *
 * ── Every route here was open to every authenticated user ──────────────────
 * The class carried `@UseGuards(JwtAuthGuard)` and only `sync-usage` had
 * `@Roles`. `RolesGuard` returns TRUE for a handler with no `@Roles` metadata,
 * so list, create, update, activate, suspend and **delete** were all reachable
 * by any logged-in account — a CUSTOMER_USER of one tenant could enumerate
 * every organisation on the platform and delete them. `ParseIdPipe` on the
 * parameter validates the shape of a uuid, not the right to use it.
 *
 * Now: administration is SUPER_ADMIN. The two read routes a tenant admin
 * legitimately needs about their OWN tenant are scoped to it rather than
 * removed, because the tenant settings screen reads them.
 */
@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    // SubscriptionsModule is @Global(), so this needs no module import.
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Post()
  @RequirePermissions('tenants:create')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a new tenant (platform operator only)' })
  @ApiResponse({ status: 201, description: 'Tenant created successfully', type: TenantMessageResponseDto })
  @ApiResponse({ status: 409, description: 'Tenant already exists' })
  create(@CurrentUser() user: User, @Body() createDto: CreateTenantDto) {
    return this.tenantsService.create(user.id, createDto);
  }

  @Get()
  @RequirePermissions('tenants:list')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Get all tenants (platform operator only)',
    description:
      'Lists every organisation on the platform, so it is SUPER_ADMIN only. ' +
      'A tenant reads its own record through GET /tenants/:id.',
  })
  @ApiResponse({ status: 200, description: 'List of tenants', type: TenantListResponseDto })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.tenantsService.findAll(paginationDto);
  }

  @Get('statistics')
  @RequirePermissions('tenants:list')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get tenant statistics (platform operator only)' })
  getStatistics() {
    return this.tenantsService.getStatistics();
  }

  // Declared before the ':id' routes on purpose. Nest matches in declaration
  // order, so a literal path registered after a parameterised one on the same
  // method would be shadowed by it.
  @Post('sync-usage')
  @RequirePermissions('tenants:create')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Recalculate usage counters from real DB counts',
    description:
      'Repairs drift between the denormalised subscription.usage counters and ' +
      'actual row counts. Metered counters (apiCalls, smsNotifications, ' +
      'storageGB) are preserved, not recomputed.',
  })
  @ApiResponse({ status: 200, description: 'Usage counters synchronized' })
  async syncUsage(@CurrentUser() user: User) {
    const usage = await this.subscriptionsService.syncUsageFromDB(user.tenantId!);
    return { message: 'Usage counters synchronized successfully', usage };
  }

  @Get(':id')
  @RequirePermissions('tenants:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get tenant by ID',
    description:
      'A TENANT_ADMIN may read only their own tenant; SUPER_ADMIN may read any.',
  })
  findOne(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    this.assertOwnTenantOrSuperAdmin(user, id);
    return this.tenantsService.findOne(id);
  }

  @Get(':id/usage')
  @RequirePermissions('tenants:read')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  @ApiOperation({
    summary: 'Get tenant usage statistics',
    description:
      'A TENANT_ADMIN may read only their own tenant; SUPER_ADMIN may read any.',
  })
  getUsage(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    this.assertOwnTenantOrSuperAdmin(user, id);
    return this.tenantsService.getUsage(id);
  }

  @Patch(':id')
  @RequirePermissions('tenants:update')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update tenant (platform operator only)' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateTenantDto,
  ) {
    return this.tenantsService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  @RequirePermissions('tenants:delete')
  @Roles(UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tenant (platform operator only)' })
  remove(@Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.remove(id);
  }

  @Post(':id/activate')
  @RequirePermissions('tenants:update')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Activate tenant (platform operator only)' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.activate(id, user.id);
  }

  @Post(':id/suspend')
  @RequirePermissions('tenants:update')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Suspend tenant (platform operator only)' })
  suspend(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.suspend(id, user.id);
  }

  /**
   * A TENANT_ADMIN may read their own tenant and nothing else.
   *
   * 404 rather than 403, so the endpoint cannot be used to confirm which
   * tenant ids exist on the platform.
   */
  private assertOwnTenantOrSuperAdmin(user: User, id: string): void {
    if (user.role === UserRole.SUPER_ADMIN) return;
    if (user.tenantId && user.tenantId === id) return;
    throw new NotFoundException('Tenant not found');
  }
}
