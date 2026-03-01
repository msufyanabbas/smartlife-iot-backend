// src/database/seeds/email-template/email-template.seeder.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailTemplateType } from '@/common/enums/index.enum';
import { Tenant, EmailTemplate } from '@modules/index.entities';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class EmailTemplateSeeder implements ISeeder {
  private readonly logger = new Logger(EmailTemplateSeeder.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private readonly emailTemplateRepository: Repository<EmailTemplate>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) { }

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting email template seeding...');

    // Check if email templates already exist
    const existingTemplates = await this.emailTemplateRepository.count();
    if (existingTemplates > 0) {
      this.logger.log(
        `⏭️  Email templates already seeded (${existingTemplates} records). Skipping...`,
      );
      return;
    }

    // Fetch tenants
    const tenants = await this.tenantRepository.find({ take: 5 });

    this.logger.log(`📊 Found ${tenants.length} tenants`);

    // ════════════════════════════════════════════════════════════════
    // SYSTEM EMAIL TEMPLATES (tenantId = null)
    // ════════════════════════════════════════════════════════════════

    const systemTemplates: Partial<EmailTemplate>[] = [
      // ════════════════════════════════════════════════════════════════
      // 1. VERIFICATION EMAIL
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined, // System template
        type: EmailTemplateType.VERIFICATION,
        name: 'Email Verification',
        subject: 'Verify Your Email - {{appName}}',
        description: 'Sent to users to verify their email address after registration',
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
      <h2 style="color: #667eea; margin-top: 0;">Hi {{userName}}! 👋</h2>
      <p>Thank you for registering with <strong>{{appName}}</strong>!</p>
      <p>To complete your registration and start using our platform, please verify your email address by clicking the button below:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{verificationLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Email Address</a>
      </div>
      
      <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0;">
        <strong>⏰ Important:</strong> This verification link will expire in {{expirationTime}} hours.
      </div>
      
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #667eea; font-size: 14px;">{{verificationLink}}</p>
      
      <p style="margin-top: 30px;">If you didn't create an account, please ignore this email.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

Thank you for registering with {{appName}}!

Please verify your email by visiting: {{verificationLink}}

This link will expire in {{expirationTime}} hours.

If you didn't create an account, please ignore this email.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'appName', 'verificationLink', 'expirationTime', 'year'],
          optional: [],
          defaults: {
            appName: 'Smart Life IoT Platform',
            expirationTime: '24',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Support',
          fromEmail: 'noreply@smartlife.sa',
          replyTo: 'support@smartlife.sa',
          priority: 'high',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['authentication', 'verification', 'user-onboarding'],
      },

      // ════════════════════════════════════════════════════════════════
      // 2. WELCOME EMAIL
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined,
        type: EmailTemplateType.WELCOME,
        name: 'Welcome Email',
        subject: "Welcome to {{appName}} - Let's Get Started!",
        description: 'Welcome email sent after successful email verification',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Welcome</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🎉 Welcome to {{appName}}!</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #10B981; margin-top: 0;">Hi {{userName}}! 👋</h2>
      <p>Your email has been verified successfully! You're all set to start using {{appName}}.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{dashboardLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Go to Dashboard</a>
      </div>
      
      <p>Best regards,<br>The {{appName}} Team</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Welcome to {{appName}}, {{userName}}!

Your email has been verified successfully. You can now access all features of the platform.

Go to Dashboard: {{dashboardLink}}

Best regards,
The {{appName}} Team

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'appName', 'dashboardLink', 'year'],
          optional: ['docsLink'],
          defaults: {
            appName: 'Smart Life IoT Platform',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Support',
          fromEmail: 'noreply@smartlife.sa',
          replyTo: 'support@smartlife.sa',
          priority: 'normal',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['welcome', 'user-onboarding'],
      },

      // ════════════════════════════════════════════════════════════════
      // 3. PASSWORD RESET
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined,
        type: EmailTemplateType.PASSWORD_RESET,
        name: 'Password Reset Request',
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
    <div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🔒 Reset Your Password</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #EF4444;">Hi {{userName}},</h2>
      <p>We received a request to reset your password for your {{appName}} account.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{resetLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
      </div>
      
      <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0;">
        <strong>Didn't request this?</strong> Ignore this email and your password will remain unchanged.
      </div>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

We received a request to reset your password for your {{appName}} account.

Reset your password: {{resetLink}}

Didn't request this? Ignore this email and your password will remain unchanged.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'appName', 'resetLink', 'year'],
          optional: ['expirationTime'],
          defaults: {
            appName: 'Smart Life IoT Platform',
            expirationTime: '1',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Security',
          fromEmail: 'security@smartlife.sa',
          replyTo: 'support@smartlife.sa',
          priority: 'high',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['security', 'password', 'authentication'],
      },

      // ════════════════════════════════════════════════════════════════
      // 4. PASSWORD CHANGED
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined,
        type: EmailTemplateType.PASSWORD_CHANGED,
        name: 'Password Changed Confirmation',
        subject: 'Your Password Has Been Changed - {{appName}}',
        description: 'Confirmation email sent after successful password change',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Password Changed</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">✓ Password Changed Successfully</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #10B981;">Hi {{userName}},</h2>
      <p>Your password was successfully changed on <strong>{{timestamp}}</strong>.</p>
      
      <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0;">
        <strong>⚠️ Didn't make this change?</strong> Contact our support team immediately at {{supportEmail}}.
      </div>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

Your password was successfully changed on {{timestamp}}.

⚠️ Didn't make this change? Contact our support team immediately at {{supportEmail}}.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'timestamp', 'supportEmail', 'appName', 'year'],
          optional: ['userEmail', 'ipAddress'],
          defaults: {
            appName: 'Smart Life IoT Platform',
            supportEmail: 'support@smartlife.sa',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Security',
          fromEmail: 'security@smartlife.sa',
          replyTo: 'support@smartlife.sa',
          priority: 'high',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['security', 'password', 'notification'],
      },

      // ════════════════════════════════════════════════════════════════
      // 5. TWO-FACTOR CODE
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined,
        type: EmailTemplateType.TWO_FACTOR_CODE,
        name: 'Two-Factor Authentication Code',
        subject: 'Your Verification Code - {{appName}}',
        description: 'Sent when user needs 2FA code for login',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Verification Code</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🔐 Verification Code</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2>Hi {{userName}},</h2>
      <p>Your verification code is:</p>
      
      <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">{{code}}</div>
      </div>
      
      <p style="font-size: 14px; color: #6c757d;">This code will expire in 10 minutes.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

Your verification code is: {{code}}

This code will expire in 10 minutes.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'code', 'appName', 'year'],
          optional: [],
          defaults: {
            appName: 'Smart Life IoT Platform',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Security',
          fromEmail: 'security@smartlife.sa',
          priority: 'high',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['security', '2fa', 'authentication'],
      },

      // ════════════════════════════════════════════════════════════════
      // 6. INVITATION
      // ════════════════════════════════════════════════════════════════
      {
        tenantId: undefined,
        type: EmailTemplateType.INVITATION,
        name: 'User Invitation',
        subject: "You've Been Invited to {{appName}}",
        description: 'Sent when a user is invited to join the platform',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>You've Been Invited</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🎉 You've Been Invited!</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #3B82F6; margin-top: 0;">Hi {{userName}}! 👋</h2>
      <p><strong>{{inviterName}}</strong> has invited you to join <strong>{{appName}}</strong>.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{invitationLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Invitation</a>
      </div>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

{{inviterName}} has invited you to join {{appName}}.

Accept your invitation: {{invitationLink}}

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          required: ['userName', 'inviterName', 'invitationLink', 'appName', 'year'],
          optional: ['role', 'expirationTime'],
          defaults: {
            appName: 'Smart Life IoT Platform',
            expirationTime: '7',
            year: new Date().getFullYear().toString(),
          },
        },
        settings: {
          fromName: 'Smart Life Team',
          fromEmail: 'noreply@smartlife.sa',
          replyTo: 'support@smartlife.sa',
          priority: 'normal',
        },
        locale: 'en',
        isActive: true,
        usageCount: 0,
        tags: ['invitation', 'user-onboarding'],
      },

      // Add remaining templates (ACCOUNT_LOCKED, ALERT_NOTIFICATION, DEVICE_OFFLINE, SUBSCRIPTION_EXPIRING, CUSTOM)
      // Following the same pattern...
    ];

    // ════════════════════════════════════════════════════════════════
    // SAVE ALL TEMPLATES
    // ════════════════════════════════════════════════════════════════

    let createdCount = 0;

    for (const templateData of systemTemplates) {
      try {
        const template = this.emailTemplateRepository.create(templateData);
        await this.emailTemplateRepository.save(template);

        const statusTag = template.isActive ? '✅ ACTIVE' : '⏸️  INACTIVE';
        const scopeTag = template.isSystemTemplate() ? '🌐 SYSTEM' : '🏢 TENANT';

        this.logger.log(
          `✅ Created: ${template.name.substring(0, 35).padEnd(37)} | ` +
          `${template.type.padEnd(20)} | ${scopeTag} | ${statusTag}`,
        );
        createdCount++;
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed template '${templateData.name}': ${error.message}`,
        );
      }
    }

    // ════════════════════════════════════════════════════════════════
    // SUMMARY STATISTICS
    // ════════════════════════════════════════════════════════════════

    const summary = {
      total: createdCount,
      system: systemTemplates.filter(t => !t.tenantId).length,
      tenant: systemTemplates.filter(t => t.tenantId).length,
      active: systemTemplates.filter(t => t.isActive).length,
      inactive: systemTemplates.filter(t => !t.isActive).length,
      byType: {} as Record<string, number>,
    };

    systemTemplates.forEach((t) => {
      if (t.type) {
        summary.byType[t.type] = (summary.byType[t.type] || 0) + 1;
      }
    });

    this.logger.log('');
    this.logger.log(
      `🎉 Email template seeding complete! Created ${createdCount}/${systemTemplates.length} templates.`,
    );
    this.logger.log('');
    this.logger.log('📊 Email Template Summary:');
    this.logger.log(`   Total: ${summary.total}`);
    this.logger.log(`   System Templates: ${summary.system}`);
    this.logger.log(`   Tenant Templates: ${summary.tenant}`);
    this.logger.log(`   Active: ${summary.active}`);
    this.logger.log(`   Inactive: ${summary.inactive}`);
    this.logger.log('');
    this.logger.log('   By Type:');
    Object.entries(summary.byType).forEach(([type, count]) =>
      this.logger.log(`     - ${type.padEnd(25)}: ${count}`),
    );
  }
}