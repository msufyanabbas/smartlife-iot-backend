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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { File as MulterFile } from 'multer';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import {
  SolutionTemplatesService,
  MAX_IMAGE_BYTES,
} from './solution-template.service';
import {
  CreateSolutionTemplateDto,
  InstallTemplateDto,
} from './dto/create-solution-template.dto';
import { UpdateSolutionTemplateDto } from './dto/update-solution-template.dto';
import { RateTemplateDto } from './dto/rate-template.dto';
import { FindAllTemplatesDto } from './dto/find-all-templates.dto';
import { FindInstallationsDto } from './dto/find-installations.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Roles } from '@common/decorators/roles.decorator';
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

  // ══════════════════════════════════════════════════════════════════════════
  // TEMPLATE IMAGE
  // ══════════════════════════════════════════════════════════════════════════

  // SUPER_ADMIN is listed explicitly: @TenantOrCustomerAdmin() resolves to
  // Roles(TENANT_ADMIN, CUSTOMER) and would otherwise block the super admin,
  // who is the only role allowed to replace a system template's image.
  @Post(':id/image')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @SwaggerAuth('Upload a template image', 'Template updated with image')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'No file, unsupported format, or file too large',
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }),
  )
  uploadImage(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.solutionTemplatesService.uploadImage(
      id,
      tenantId,
      userId,
      role,
      file,
    );
  }

  @Get(':id/image')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @SwaggerAuth('Download the uploaded template image', 'Image stream')
  @ApiResponse({ status: 404, description: 'Template has no uploaded image' })
  async getImage(
    @CurrentUser('tenantId') tenantId: string,
    @Param('id', ParseIdPipe) id: string,
    @Res() res: Response,
  ) {
    const { path: filePath, contentType, fileName } =
      await this.solutionTemplatesService.getImageFile(id, tenantId);

    // @Res() bypasses the global TransformInterceptor so raw bytes are sent.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    createReadStream(filePath).pipe(res);
  }

  @Delete(':id/image')
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @SwaggerAuth('Remove the template image', 'Image removed')
  @ApiResponse({ status: 404, description: 'Template not found' })
  removeImage(
    @CurrentUser('id') userId: string,
    @CurrentUser('tenantId') tenantId: string,
    @CurrentUser('role') role: UserRole,
    @Param('id', ParseIdPipe) id: string,
  ) {
    return this.solutionTemplatesService.removeImage(
      id,
      tenantId,
      userId,
      role,
    );
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
