import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  EmailTemplate,
} from './entities/email-template.entity';
import { EmailTemplateType } from '@common/enums/index.enum';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';

@Injectable()
export class EmailTemplatesService {
  private readonly logger = new Logger(EmailTemplatesService.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private emailTemplateRepository: Repository<EmailTemplate>,
  ) { }

  /**
   * Create a new email template
   */
  /**
   * ── Tenant scoping ────────────────────────────────────────────────────────
   *
   * The entity was built for this all along: `tenantId` is nullable with the
   * comment "null = system template, non-null = tenant-specific override", a
   * UNIQUE index on `(tenantId, type)`, and an `isSystemTemplate()` helper.
   * The service then ignored every bit of it — `create` never set `tenantId`,
   * and `findByType` matched on type alone.
   *
   * The consequence was not a missing feature, it was a cross-tenant one:
   * the FIRST tenant to save a `password_reset` template owned the
   * password-reset email every OTHER tenant's MailService rendered, including
   * its wording, its links and its branding. The uniqueness check made it
   * worse by refusing a second tenant a template of their own at all.
   *
   * Reads now resolve a tenant's own override first and fall back to the
   * system template; writes are confined to the caller's tenant.
   */
  async create(
    tenantId: string | undefined,
    createDto: CreateEmailTemplateDto,
  ): Promise<EmailTemplate> {
    // Uniqueness is per tenant, matching the UNIQUE (tenantId, type) index.
    const existing = await this.emailTemplateRepository.findOne({
      where: { type: createDto.type, tenantId: tenantId ?? IsNull() },
    });

    if (existing) {
      throw new ConflictException(
        `Email template with type '${createDto.type}' already exists for this tenant`,
      );
    }

    // A SUPER_ADMIN with no tenantId authors the SYSTEM template every tenant
    // falls back to; everyone else authors their own override.
    const template = this.emailTemplateRepository.create(
      createDto as Partial<EmailTemplate>,
    );
    template.tenantId = tenantId ?? undefined;
    return this.emailTemplateRepository.save(template);
  }

  /**
   * Get all email templates
   */
  async findAll(tenantId?: string): Promise<EmailTemplate[]> {
    return this.emailTemplateRepository.find({
      where: tenantId
        ? [{ tenantId }, { tenantId: IsNull() }]
        : { tenantId: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get active email templates only
   */
  async findAllActive(tenantId?: string): Promise<EmailTemplate[]> {
    return this.emailTemplateRepository.find({
      where: tenantId
        ? [
            { isActive: true, tenantId },
            { isActive: true, tenantId: IsNull() },
          ]
        : { isActive: true, tenantId: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get email template by ID
   */
  async findOne(id: string, tenantId?: string): Promise<EmailTemplate> {
    const template = await this.emailTemplateRepository.findOne({
      where: { id },
    });

    // A system template (tenantId null) is readable by everyone — it is the
    // fallback they actually receive. Another TENANT's override is not, and
    // answers 404 rather than 403 so ids cannot be probed.
    if (
      !template ||
      (template.tenantId != null && tenantId !== undefined && template.tenantId !== tenantId)
    ) {
      throw new NotFoundException(`Email template with ID '${id}' not found`);
    }

    return template;
  }

  /**
   * Get email template by type
   */
  /**
   * Resolve the template a given tenant should actually receive: their own
   * override if they have one, otherwise the system template.
   */
  async findByType(
    type: EmailTemplateType,
    tenantId?: string,
  ): Promise<EmailTemplate> {
    if (tenantId) {
      const override = await this.emailTemplateRepository.findOne({
        where: { type, isActive: true, tenantId },
      });
      if (override) return override;
    }

    const system = await this.emailTemplateRepository.findOne({
      where: { type, isActive: true, tenantId: IsNull() },
    });

    if (!system) {
      throw new NotFoundException(
        `Active email template with type '${type}' not found`,
      );
    }

    return system;
  }

  /**
   * Update email template
   */
  async update(
    id: string,
    updateDto: UpdateEmailTemplateDto,
    tenantId?: string,
  ): Promise<EmailTemplate> {
    const template = await this.findOne(id, tenantId);
    this.assertWritable(template, tenantId);

    // If updating type, check it doesn't conflict — within this tenant.
    if (updateDto.type && updateDto.type !== template.type) {
      const existing = await this.emailTemplateRepository.findOne({
        where: { type: updateDto.type, tenantId: tenantId ?? IsNull() },
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
  async remove(id: string, tenantId?: string): Promise<void> {
    const template = await this.findOne(id, tenantId);
    this.assertWritable(template, tenantId);
    await this.emailTemplateRepository.remove(template);
  }

  /**
   * A tenant may edit only its own override. The system template is readable
   * by all and writable only by a caller with no tenant of their own, i.e.
   * SUPER_ADMIN — otherwise the first tenant to click Edit would rewrite the
   * default every other tenant falls back to.
   */
  private assertWritable(template: EmailTemplate, tenantId?: string): void {
    if (template.tenantId == null && tenantId !== undefined) {
      throw new ForbiddenException(
        'This is a system template. Create your own version of it instead of editing the default.',
      );
    }
    if (template.tenantId != null && template.tenantId !== tenantId) {
      throw new NotFoundException('Email template not found');
    }
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
    tenantId?: string,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = await this.findByType(type, tenantId);

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
    tenantId?: string,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = await this.findOne(id, tenantId);

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