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
import { SolutionTemplatesService } from './solution-template.service';
import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { RateTemplateDto } from './dto/rate-template.dto';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';
import { FindInstallationsDto } from './dto/find-installations.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import {
  TenantOrCustomerAdmin,
  SwaggerAuth,
} from '@common/decorators/access-control.decorator';
import { ParseIdPipe } from '@common/pipes/parse-id.pipe';
import { UserRole } from '@common/enums/index.enum';

@ApiTags('Solution Templates')
@Controller('solution-templates')
export class SolutionTemplatesController {
  constructor(
    private readonly solutionTemplatesService: SolutionTemplatesService,
  ) {}

  @Post()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Create a new solution template', 'Template created')
  create(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Body() createDto: CreateSolutionTemplateDto,
  ) {
    return this.solutionTemplatesService.create(userId, tenantId, createDto);
  }

  @Get()
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all solution templates', 'List of templates')
  findAll(
    @CurrentUser('tenantId') tenantId: string,
    @Query() filters: FindAllTemplatesDto,
  ) {
    return this.solutionTemplatesService.findAll(tenantId, filters);
  }

  // NOTE: static routes must precede ':id' or Nest parses them as an id param
  @Get('categories')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get all template categories', 'List of categories')
  getCategories(@CurrentUser('tenantId') tenantId: string) {
    return this.solutionTemplatesService.getCategories(tenantId);
  }

  @Get('statistics')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get template statistics', 'Template statistics')
  getStatistics(@CurrentUser('tenantId') tenantId: string) {
    return this.solutionTemplatesService.getStatistics(tenantId);
  }

  @Get('installations')
  @TenantOrCustomerAdmin()
  @SwaggerAuth(
    'List every template installation for the current tenant',
    'Paginated installation history across all templates',
  )
  getMyInstallations(
    @CurrentUser('tenantId') tenantId: string,
    @Query() query: FindInstallationsDto,
  ) {
    return this.solutionTemplatesService.getMyInstallations(
      tenantId,
      query.page,
      query.limit,
    );
  }

  @Delete('installations/:installationId')
  @TenantOrCustomerAdmin()
  @SwaggerAuth(
    'Uninstall a template installation',
    'Installation removed and quota released',
  )
  @ApiResponse({
    status: 404,
    description: 'Installation not found or already uninstalled',
  })
  uninstall(
    @CurrentUser('tenantId') tenantId: string,
    @Param('installationId', ParseIdPipe) installationId: string,
  ) {
    return this.solutionTemplatesService.uninstall(installationId, tenantId);
  }

  @Get(':id/preview')
  @TenantOrCustomerAdmin()
  @SwaggerAuth(
    'Preview template installation',
    'Shows what will be created without installing',
  )
  @ApiResponse({ status: 404, description: 'Template not found' })
  preview(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.solutionTemplatesService.preview(id, tenantId);
  }

  @Get(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Get template by ID', 'Template details')
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.solutionTemplatesService.findOne(id, tenantId);
  }

  @Get(':id/installations')
  @TenantOrCustomerAdmin()
  @SwaggerAuth(
    'List installations of a template for the current tenant',
    'Installation history',
  )
  @ApiResponse({ status: 404, description: 'Template not found' })
  getInstallations(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.solutionTemplatesService.getInstallations(id, tenantId);
  }

  @Patch(':id')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Update template', 'Template updated')
  @ApiResponse({ status: 404, description: 'Template not found' })
  update(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
    @Body() updateDto: UpdateSolutionTemplateDto,
  ) {
    return this.solutionTemplatesService.update(
      id,
      userId,
      tenantId,
      role,
      updateDto,
    );
  }

  @Delete(':id')
  @TenantOrCustomerAdmin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @SwaggerAuth('Delete template', 'Template deleted')
  @ApiResponse({ status: 404, description: 'Template not found' })
  remove(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.solutionTemplatesService.remove(id, userId, tenantId, role);
  }

  @Post(':id/install')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Install solution template', 'Template installed')
  @ApiResponse({ status: 400, description: 'No configuration, or quota exceeded' })
  @ApiResponse({ status: 409, description: 'Template already installed' })
  install(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('customerId') customerId: string | undefined,
    @Param('id', ParseIdPipe) id: string,
    @Body() installDto: InstallTemplateDto,
  ) {
    return this.solutionTemplatesService.install(
      id,
      userId,
      tenantId,
      customerId,
      installDto,
    );
  }

  @Post(':id/rate')
  @TenantOrCustomerAdmin()
  @SwaggerAuth('Rate a template', 'Template rated')
  @ApiResponse({ status: 400, description: 'Rating must be between 0 and 5' })
  rate(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: RateTemplateDto,
  ) {
    return this.solutionTemplatesService.rateTemplate(
      id,
      userId,
      tenantId,
      dto.rating,
    );
  }
}
