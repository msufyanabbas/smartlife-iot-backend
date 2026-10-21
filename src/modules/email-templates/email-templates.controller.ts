import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { EmailTemplatesService } from './email-templates.service';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '@common/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { User } from '@modules/users/entities/user.entity';
import { EmailTemplateType, UserRole } from '@common/enums/index.enum';
import { RequirePermissions } from '@common/decorators/permission.decorator';
import { Audit } from '@common/decorators/audit.decorator';
import { AuditAction, AuditEntityType, AuditSeverity } from '@common/enums/index.enum';

@ApiTags('Email Templates')
@ApiBearerAuth()
/**
 * Email templates.
 *
 * Had NO `@Roles` on any handler and no tenant scoping whatsoever. Since
 * `RolesGuard` returns TRUE for an undecorated handler, any authenticated
 * user — a CUSTOMER_USER included — could create, edit and delete templates;
 * and because the service ignored the entity's own `tenantId` column, the
 * template they edited was the one EVERY tenant's MailService rendered. One
 * customer could rewrite the password-reset email the whole platform sends.
 *
 * Reads stay open to any signed-in user (the template they receive is their
 * own tenant's, resolved per caller). Writes are TENANT_ADMIN and above, and
 * confined to the caller's tenant; the shared system template is editable
 * only by SUPER_ADMIN, who has no tenant of their own.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly emailTemplatesService: EmailTemplatesService) { }

  @Post()
  @Audit({
    action: AuditAction.CREATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'create email template',
  })
  @RequirePermissions('settings:create')
  @ApiOperation({ summary: 'Create a new email template' })
  @ApiResponse({
    status: 201,
    description: 'Email template created successfully',
  })
  @ApiResponse({ status: 409, description: 'Template type already exists' })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  create(
    @CurrentUser() user: User,
    @Body() createDto: CreateEmailTemplateDto,
  ) {
    return this.emailTemplatesService.create(user.tenantId, createDto);
  }

  @Get()
  @RequirePermissions('settings:read')
  @ApiOperation({ summary: 'Get all email templates' })
  @ApiResponse({ status: 200, description: 'List of email templates' })
  findAll(@CurrentUser() user: User) {
    return this.emailTemplatesService.findAll(user.tenantId);
  }

  @Get('active')
  @RequirePermissions('settings:read')
  @ApiOperation({ summary: 'Get all active email templates' })
  @ApiResponse({ status: 200, description: 'List of active templates' })
  findAllActive(@CurrentUser() user: User) {
    return this.emailTemplatesService.findAllActive(user.tenantId);
  }

  @Get('type/:type')
  @RequirePermissions('settings:read')
  @ApiOperation({ summary: 'Get email template by type' })
  @ApiResponse({ status: 200, description: 'Email template found' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  // enumName is required — without it Swagger's schema factory treats a bare
  // enum @Param as a circular dependency and throws at bootstrap
  @ApiParam({ name: 'type', type: String, enum: EmailTemplateType, enumName: 'EmailTemplateType' })
  findByType(
    @Param('type') type: EmailTemplateType,
    @CurrentUser() user: User,
  ) {
    return this.emailTemplatesService.findByType(type, user.tenantId);
  }

  @Get(':id/preview')
  @RequirePermissions('settings:read')
  @ApiOperation({
    summary: 'Preview email template with sample or provided variables',
  })
  @ApiResponse({ status: 200, description: 'Template preview generated' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiQuery({
    name: 'variables',
    required: false,
    description: 'JSON string of variables to use for preview',
  })
  async previewTemplate(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Query('variables') variablesJson?: string,
  ) {
    let variables: Record<string, any> | undefined;

    if (variablesJson) {
      try {
        variables = JSON.parse(variablesJson);
      } catch (error) {
        return {
          error: 'Invalid JSON in variables parameter',
        };
      }
    }

    return this.emailTemplatesService.previewTemplate(
      id,
      variables,
      user.tenantId,
    );
  }

  @Post(':id/validate')
  @RequirePermissions('settings:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate template placeholders' })
  @ApiResponse({ status: 200, description: 'Validation results returned' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async validateTemplate(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    const template = await this.emailTemplatesService.findOne(
      id,
      user.tenantId,
    );

    const subjectValidation =
      this.emailTemplatesService.validateTemplatePlaceholders(
        template.subject,
      );
    const htmlValidation =
      this.emailTemplatesService.validateTemplatePlaceholders(
        template.htmlTemplate,
      );
    const textValidation =
      this.emailTemplatesService.validateTemplatePlaceholders(
        template.textTemplate,
      );

    return {
      subject: subjectValidation,
      html: htmlValidation,
      text: textValidation,
      overallValid:
        subjectValidation.isValid &&
        htmlValidation.isValid &&
        textValidation.isValid,
    };
  }

  @Get(':id')
  @RequirePermissions('settings:read')
  @ApiOperation({ summary: 'Get email template by ID' })
  @ApiResponse({ status: 200, description: 'Email template found' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(@Param('id') id: string, @CurrentUser() user: User) {
    return this.emailTemplatesService.findOne(id, user.tenantId);
  }

  @Patch(':id')
  @Audit({
    action: AuditAction.UPDATE,
    entityType: AuditEntityType.SETTINGS,
    description: 'update email template',
  })
  @RequirePermissions('settings:update')
  @ApiOperation({ summary: 'Update email template' })
  @ApiResponse({ status: 200, description: 'Template updated successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Template type conflict' })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  update(
    @Param('id') id: string,
    @Body() updateDto: UpdateEmailTemplateDto,
    @CurrentUser() user: User,
  ) {
    return this.emailTemplatesService.update(id, updateDto, user.tenantId);
  }

  @Delete(':id')
  @Audit({
    action: AuditAction.DELETE,
    entityType: AuditEntityType.SETTINGS,
    description: 'delete email template',
    severity: AuditSeverity.WARNING,
  })
  @RequirePermissions('settings:delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete email template' })
  @ApiResponse({ status: 204, description: 'Template deleted successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.emailTemplatesService.remove(id, user.tenantId);
  }
}