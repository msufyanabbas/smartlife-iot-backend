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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { Roles } from '@/common/decorators/roles.decorator';
import { UserRole } from '@/common/enums/user.enum';
import { TenantListResponseDto, TenantMessageResponseDto } from './dto/tenant-response.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

@ApiTags('tenants')
@Controller('tenants')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    // SubscriptionsModule is @Global(), so this needs no module import.
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new tenant' })
  @ApiResponse({ status: 201, description: 'Tenant created successfully', type: TenantMessageResponseDto })
  @ApiResponse({ status: 409, description: 'Tenant already exists' })
  create(@CurrentUser() user: User, @Body() createDto: CreateTenantDto) {
    return this.tenantsService.create(user.id, createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all tenants' })
  @ApiResponse({ status: 200, description: 'List of tenants', type: TenantListResponseDto })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.tenantsService.findAll(paginationDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get tenant statistics' })
  getStatistics() {
    return this.tenantsService.getStatistics();
  }

  // Declared before the ':id' routes on purpose. Nest matches in declaration
  // order, so a literal path registered after a parameterised one on the same
  // method would be shadowed by it.
  @Post('sync-usage')
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
  @ApiOperation({ summary: 'Get tenant by ID' })
  findOne(@Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.findOne(id);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Get tenant usage statistics' })
  getUsage(@Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.getUsage(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update tenant' })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateTenantDto,
  ) {
    return this.tenantsService.update(id, user.id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tenant' })
  remove(@Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.remove(id);
  }

  @Post(':id/activate')
  @ApiOperation({ summary: 'Activate tenant' })
  activate(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.activate(id, user.id);
  }

  @Post(':id/suspend')
  @ApiOperation({ summary: 'Suspend tenant' })
  suspend(@CurrentUser() user: User, @Param('id', ParseIdPipe) id: string) {
    return this.tenantsService.suspend(id, user.id);
  }
}
