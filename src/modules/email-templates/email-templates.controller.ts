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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { EmailTemplatesService } from './email-templates.service';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EmailTemplateType } from './entities/email-template.entity';

@ApiTags('Email Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly emailTemplatesService: EmailTemplatesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new email template' })
  @ApiResponse({
    status: 201,
    description: 'Email template created successfully',
  })
  @ApiResponse({ status: 409, description: 'Template type already exists' })
  create(@Body() createDto: CreateEmailTemplateDto) {
    return this.emailTemplatesService.create(createDto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all email templates' })
  @ApiResponse({ status: 200, description: 'List of email templates' })
  findAll() {
    return this.emailTemplatesService.findAll();
  }

  @Get('active')
  @ApiOperation({ summary: 'Get all active email templates' })
  @ApiResponse({ status: 200, description: 'List of active templates' })
  findAllActive() {
    return this.emailTemplatesService.findAllActive();
  }

  @Get('type/:type')
  @ApiOperation({ summary: 'Get email template by type' })
  @ApiResponse({ status: 200, description: 'Email template found' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findByType(@Param('type') type: EmailTemplateType) {
    return this.emailTemplatesService.findByType(type);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get email template by ID' })
  @ApiResponse({ status: 200, description: 'Email template found' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(@Param('id') id: string) {
    return this.emailTemplatesService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update email template' })
  @ApiResponse({ status: 200, description: 'Template updated successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Template type conflict' })
  update(@Param('id') id: string, @Body() updateDto: UpdateEmailTemplateDto) {
    return this.emailTemplatesService.update(id, updateDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete email template' })
  @ApiResponse({ status: 204, description: 'Template deleted successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  remove(@Param('id') id: string) {
    return this.emailTemplatesService.remove(id);
  }

  @Post('seed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Seed default email templates' })
  @ApiResponse({ status: 200, description: 'Templates seeded successfully' })
  async seedTemplates() {
    await this.emailTemplatesService.seedDefaultTemplates();
    return { message: 'Default templates seeded successfully' };
  }
}
