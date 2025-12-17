import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EmailTemplate,
  EmailTemplateType,
} from './entities/email-template.entity';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';

@Injectable()
export class EmailTemplatesService {
  private readonly logger = new Logger(EmailTemplatesService.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private emailTemplateRepository: Repository<EmailTemplate>,
  ) {}

  /**
   * Create a new email template
   */
  async create(createDto: CreateEmailTemplateDto): Promise<EmailTemplate> {
    // Check if template type already exists
    const existing = await this.emailTemplateRepository.findOne({
      where: { type: createDto.type },
    });

    if (existing) {
      throw new ConflictException(
        `Email template with type '${createDto.type}' already exists`,
      );
    }

    const template = this.emailTemplateRepository.create(createDto);
    return this.emailTemplateRepository.save(template);
  }

  /**
   * Get all email templates
   */
  async findAll(): Promise<EmailTemplate[]> {
    return this.emailTemplateRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get active email templates only
   */
  async findAllActive(): Promise<EmailTemplate[]> {
    return this.emailTemplateRepository.find({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get email template by ID
   */
  async findOne(id: string): Promise<EmailTemplate> {
    const template = await this.emailTemplateRepository.findOne({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`Email template with ID '${id}' not found`);
    }

    return template;
  }

  /**
   * Get email template by type
   */
  async findByType(type: EmailTemplateType): Promise<EmailTemplate> {
    const template = await this.emailTemplateRepository.findOne({
      where: { type, isActive: true },
    });

    if (!template) {
      throw new NotFoundException(
        `Active email template with type '${type}' not found`,
      );
    }

    return template;
  }

  /**
   * Update email template
   */
  async update(
    id: string,
    updateDto: UpdateEmailTemplateDto,
  ): Promise<EmailTemplate> {
    const template = await this.findOne(id);

    // If updating type, check it doesn't conflict
    if (updateDto.type && updateDto.type !== template.type) {
      const existing = await this.emailTemplateRepository.findOne({
        where: { type: updateDto.type },
      });

      if (existing && existing.id !== id) {
        throw new ConflictException(
          `Email template with type '${updateDto.type}' already exists`,
        );
      }
    }

    Object.assign(template, updateDto);
    return this.emailTemplateRepository.save(template);
  }

  /**
   * Delete email template
   */
  async remove(id: string): Promise<void> {
    const template = await this.findOne(id);
    await this.emailTemplateRepository.remove(template);
  }

  /**
   * Render template with variables - Enhanced version with better error handling
   */
  renderTemplate(
    template: string,
    variables: Record<string, any>,
  ): string {
    if (!template) {
      this.logger.warn('Empty template provided for rendering');
      return '';
    }

    let rendered = template;

    // Replace all {{variableName}} with actual values
    // This regex handles both {{variable}} and {{ variable }} (with spaces)
    const regex = /\{\{\s*(\w+)\s*\}\}/g;
    
    rendered = rendered.replace(regex, (match, variableName) => {
      const value = variables[variableName];
      
      if (value === undefined || value === null) {
        this.logger.warn(
          `Variable '${variableName}' not found in provided variables. Available: ${Object.keys(variables).join(', ')}`,
        );
        return match; // Keep the placeholder if variable not found
      }
      
      return String(value);
    });

    return rendered;
  }

  /**
   * Get rendered email content
   */
  async getRenderedEmail(
    type: EmailTemplateType,
    variables: Record<string, any>,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = await this.findByType(type);

    // Add default variables if not provided
    const enrichedVariables = {
      appName: process.env.APP_NAME || 'Smart Life IoT Platform',
      year: new Date().getFullYear().toString(),
      ...variables,
    };

    return {
      subject: this.renderTemplate(template.subject, enrichedVariables),
      html: this.renderTemplate(template.htmlTemplate, enrichedVariables),
      text: this.renderTemplate(template.textTemplate, enrichedVariables),
    };
  }

  /**
   * Preview template with sample variables
   */
  async previewTemplate(
    id: string,
    sampleVariables?: Record<string, any>,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = await this.findOne(id);

    // Use provided sample variables or generate defaults from template variables
    const variables = sampleVariables || this.generateSampleVariables(template);

    return {
      subject: this.renderTemplate(template.subject, variables),
      html: this.renderTemplate(template.htmlTemplate, variables),
      text: this.renderTemplate(template.textTemplate, variables),
    };
  }

  /**
   * Generate sample variables based on template's variable definitions
   */
  private generateSampleVariables(
    template: EmailTemplate,
  ): Record<string, any> {
    const sampleData: Record<string, any> = {
      appName: 'Smart Life IoT Platform',
      year: new Date().getFullYear().toString(),
      userName: 'John Doe',
      name: 'John Doe',
      userEmail: 'john.doe@example.com',
      email: 'john.doe@example.com',
      deviceName: 'Temperature Sensor #1',
      deviceId: 'DEV-12345',
      code: '123456',
      verificationLink: 'https://example.com/verify/token123',
      verificationUrl: 'https://example.com/verify/token123',
      resetLink: 'https://example.com/reset/token456',
      resetUrl: 'https://example.com/reset/token456',
      dashboardLink: 'https://example.com/dashboard',
      dashboardUrl: 'https://example.com/dashboard',
      timestamp: new Date().toLocaleString(),
      expirationTime: '24',
    };

    // If template has specific variables defined, use those keys
    if (template.variables && typeof template.variables === 'object') {
      Object.keys(template.variables).forEach((key) => {
        if (!sampleData[key]) {
          sampleData[key] = `[${key}]`;
        }
      });
    }

    return sampleData;
  }

  /**
   * Validate template placeholders
   */
  validateTemplatePlaceholders(template: string): {
    isValid: boolean;
    placeholders: string[];
    errors: string[];
  } {
    const placeholderRegex = /\{\{\s*(\w+)\s*\}\}/g;
    const placeholders: string[] = [];
    const errors: string[] = [];
    let match;

    while ((match = placeholderRegex.exec(template)) !== null) {
      const placeholder = match[1];
      if (!placeholders.includes(placeholder)) {
        placeholders.push(placeholder);
      }
    }

    // Check for malformed placeholders
    const malformedRegex = /\{[^{]|[^}]\}/g;
    if (malformedRegex.test(template)) {
      errors.push('Template contains malformed placeholders (single braces)');
    }

    return {
      isValid: errors.length === 0,
      placeholders,
      errors,
    };
  }
}