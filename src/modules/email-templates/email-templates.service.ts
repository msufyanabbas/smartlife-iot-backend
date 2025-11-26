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
   * Render template with variables
   */
  renderTemplate(template: string, variables: Record<string, any>): string {
    let rendered = template;

    // Replace all {{variableName}} with actual values
    Object.keys(variables).forEach((key) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      rendered = rendered.replace(regex, variables[key] || '');
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

    return {
      subject: this.renderTemplate(template.subject, variables),
      html: this.renderTemplate(template.htmlTemplate, variables),
      text: this.renderTemplate(template.textTemplate, variables),
    };
  }

  /**
   * Seed default templates (run on first startup)
   */
  async seedDefaultTemplates(): Promise<void> {
    const templates: CreateEmailTemplateDto[] = [
      {
        type: EmailTemplateType.VERIFICATION,
        name: 'Email Verification',
        subject: 'Verify Your Email - {{appName}}',
        description: 'Sent to users to verify their email address',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Verify Your Email</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🔐 Email Verification</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #667eea; margin-top: 0;">Hi {{name}}! 👋</h2>
      <p>Thank you for registering with <strong>{{appName}}</strong>!</p>
      <p>To complete your registration and start using our platform, please verify your email address by clicking the button below:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{verificationUrl}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Email Address</a>
      </div>
      
      <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0;">
        <strong>⏰ Important:</strong> This verification link will expire in 24 hours.
      </div>
      
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #667eea; font-size: 14px;">{{verificationUrl}}</p>
      
      <p style="margin-top: 30px;">If you didn't create an account, please ignore this email.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{name}},

Thank you for registering with {{appName}}!

Please verify your email by visiting: {{verificationUrl}}

This link will expire in 24 hours.

If you didn't create an account, please ignore this email.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          name: 'User name',
          appName: 'Application name',
          verificationUrl: 'Email verification URL',
          year: 'Current year',
        },
        isActive: true,
      },
      {
        type: EmailTemplateType.WELCOME,
        name: 'Welcome Email',
        subject: 'Welcome to {{appName}}!',
        description: 'Sent after email verification is complete',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Welcome</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🎉 Welcome to {{appName}}!</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #667eea; margin-top: 0;">Hi {{name}}! 👋</h2>
      <p>Your email has been verified successfully! You're all set to start using {{appName}}.</p>
      
      <h3 style="color: #667eea; margin-top: 30px;">What's Next?</h3>
      
      <div style="background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 6px;">
        <h3 style="margin: 0 0 10px 0; color: #667eea; font-size: 16px;">📊 Connect Your Devices</h3>
        <p style="margin: 0;">Start adding your IoT devices to the platform and monitor them in real-time.</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 6px;">
        <h3 style="margin: 0 0 10px 0; color: #667eea; font-size: 16px;">📈 Analytics & Insights</h3>
        <p style="margin: 0;">Get powerful insights from your device data with our analytics dashboard.</p>
      </div>
      
      <div style="background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 6px;">
        <h3 style="margin: 0 0 10px 0; color: #667eea; font-size: 16px;">⚡ Automation</h3>
        <p style="margin: 0;">Set up rules and automation to make your devices work smarter.</p>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{dashboardUrl}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Go to Dashboard</a>
      </div>
      
      <p style="margin-top: 30px;">If you have any questions, our support team is here to help!</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Welcome to {{appName}}, {{name}}!

Your email has been verified successfully. You can now access all features of the platform.

What's Next?
- Connect Your Devices
- Analytics & Insights  
- Automation

Go to Dashboard: {{dashboardUrl}}

If you have any questions, our support team is here to help!

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          name: 'User name',
          appName: 'Application name',
          dashboardUrl: 'Dashboard URL',
          year: 'Current year',
        },
        isActive: true,
      },
      {
        type: EmailTemplateType.PASSWORD_RESET,
        name: 'Password Reset',
        subject: 'Reset Your Password - {{appName}}',
        description: 'Sent when user requests password reset',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Password</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🔒 Reset Your Password</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2>Hi {{name}},</h2>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{resetUrl}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
      </div>
      
      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
        <strong>⚠️ Security Notice:</strong> This link will expire in 1 hour for security reasons.
      </div>
      
      <p>If you didn't request a password reset, please ignore this email and your password will remain unchanged.</p>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">For security reasons, we cannot display your current password. If you remember your password, you can safely ignore this email.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{name}},

We received a request to reset your password.

Reset your password: {{resetUrl}}

This link will expire in 1 hour for security reasons.

If you didn't request a password reset, please ignore this email.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          name: 'User name',
          appName: 'Application name',
          resetUrl: 'Password reset URL',
          year: 'Current year',
        },
        isActive: true,
      },
    ];

    for (const templateDto of templates) {
      try {
        const existing = await this.emailTemplateRepository.findOne({
          where: { type: templateDto.type },
        });

        if (!existing) {
          await this.create(templateDto);
          this.logger.log(`✅ Seeded template: ${templateDto.name}`);
        } else {
          this.logger.log(`⏭️  Template already exists: ${templateDto.name}`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to seed template ${templateDto.name}:`,
          error.message,
        );
      }
    }
  }
}
