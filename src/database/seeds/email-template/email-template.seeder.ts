import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EmailTemplate,
  EmailTemplateType,
} from '@modules/email-templates/entities/email-template.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class EmailTemplateSeeder implements ISeeder {
  private readonly logger = new Logger(EmailTemplateSeeder.name);

  constructor(
    @InjectRepository(EmailTemplate)
    private readonly emailTemplateRepository: Repository<EmailTemplate>,
  ) {}

  async seed(): Promise<void> {
    this.logger.log('🌱 Starting email template seeding...');

    const emailTemplates = [
      // ========================================
      // VERIFICATION EMAIL TEMPLATE
      // ========================================
      {
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
          userName: 'User full name',
          appName: 'Application name',
          verificationLink: 'Email verification URL',
          expirationTime: 'Link expiration time in hours',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // WELCOME EMAIL TEMPLATE
      // ========================================
      {
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
      
      <h3 style="color: #10B981; margin-top: 30px;">What's Next?</h3>
      
      <div style="background: #f0fdf4; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid #10B981;">
        <h3 style="margin: 0 0 10px 0; color: #10B981; font-size: 16px;">📊 Connect Your Devices</h3>
        <p style="margin: 0;">Start adding your IoT devices to the platform and monitor them in real-time.</p>
      </div>
      
      <div style="background: #f0fdf4; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid #10B981;">
        <h3 style="margin: 0 0 10px 0; color: #10B981; font-size: 16px;">📈 Analytics & Insights</h3>
        <p style="margin: 0;">Get powerful insights from your device data with our analytics dashboard.</p>
      </div>
      
      <div style="background: #f0fdf4; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid #10B981;">
        <h3 style="margin: 0 0 10px 0; color: #10B981; font-size: 16px;">⚡ Automation</h3>
        <p style="margin: 0;">Set up rules and automation to make your devices work smarter.</p>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{dashboardLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Go to Dashboard</a>
      </div>
      
      <p style="margin-top: 30px;">Need help getting started? Check out our <a href="{{docsLink}}" style="color: #10B981;">documentation</a> or contact our support team.</p>
      
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

What's Next?
- Connect Your Devices: Start adding your IoT devices and monitor them in real-time
- Analytics & Insights: Get powerful insights from your device data
- Automation: Set up rules and automation

Go to Dashboard: {{dashboardLink}}
Documentation: {{docsLink}}

Need help? Our support team is here to help!

Best regards,
The {{appName}} Team

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          appName: 'Application name',
          dashboardLink: 'Dashboard URL',
          docsLink: 'Documentation URL',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // PASSWORD RESET EMAIL TEMPLATE
      // ========================================
      {
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
      <p>Click the button below to create a new password:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{resetLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
      </div>
      
      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
        <strong>⚠️ Security Notice:</strong> This link will expire in {{expirationTime}} hour(s) for security reasons.
      </div>
      
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #EF4444; font-size: 14px;">{{resetLink}}</p>
      
      <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0;">
        <strong>Didn't request this?</strong><br>
        If you didn't request a password reset, please ignore this email and your password will remain unchanged. Someone may have entered your email by mistake.
      </div>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">For security reasons, we never ask for your password via email.</p>
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

This link will expire in {{expirationTime}} hour(s) for security reasons.

⚠️ Didn't request this?
If you didn't request a password reset, please ignore this email and your password will remain unchanged.

For security reasons, we never ask for your password via email.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          appName: 'Application name',
          resetLink: 'Password reset URL',
          expirationTime: 'Link expiration time in hours',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // PASSWORD CHANGED EMAIL TEMPLATE
      // ========================================
      {
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
      <p>This is a confirmation that your password was successfully changed on <strong>{{timestamp}}</strong>.</p>
      
      <div style="background: #F0FDF4; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0;">
        <strong>Account Details:</strong><br>
        Email: {{userEmail}}<br>
        Changed: {{timestamp}}<br>
        IP Address: {{ipAddress}}
      </div>
      
      <div style="background: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0;">
        <strong>⚠️ Didn't make this change?</strong><br>
        If you didn't change your password, please contact our support team immediately at {{supportEmail}} or reset your password right away.
      </div>
      
      <p><strong>For your security, we recommend:</strong></p>
      <ul>
        <li>Using a unique password for your {{appName}} account</li>
        <li>Enabling two-factor authentication</li>
        <li>Never sharing your password with anyone</li>
      </ul>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>Support: {{supportEmail}}</p>
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Password Changed Successfully

Hi {{userName}},

This is a confirmation that your password was successfully changed on {{timestamp}}.

Account Details:
- Email: {{userEmail}}
- Changed: {{timestamp}}
- IP Address: {{ipAddress}}

⚠️ Didn't make this change?
If you didn't change your password, please contact our support team immediately at {{supportEmail}}.

For your security, we recommend:
- Using a unique password for your {{appName}} account
- Enabling two-factor authentication
- Never sharing your password with anyone

Support: {{supportEmail}}
© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          userEmail: 'User email address',
          timestamp: 'Change timestamp',
          ipAddress: 'IP address of the change',
          supportEmail: 'Support email address',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // TWO FACTOR CODE EMAIL TEMPLATE
      // ========================================
      {
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
      <p>You're attempting to sign in to your {{appName}} account. Please use the verification code below:</p>
      
      <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">{{code}}</div>
      </div>
      
      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
        <strong>⏰ Important:</strong> This code will expire in 10 minutes.
      </div>
      
      <div style="background: #f8d7da; border-left: 4px solid #dc3545; padding: 15px; margin: 20px 0;">
        <strong>⚠️ Security Warning:</strong> If you didn't request this code, please ignore this email and ensure your account is secure.
      </div>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">This is an automated security email. Please do not reply to this message.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

You're attempting to sign in to your {{appName}} account.

Your verification code is: {{code}}

This code will expire in 10 minutes.

⚠️ If you didn't request this code, please ignore this email and ensure your account is secure.

This is an automated security email. Please do not reply.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          code: '6-digit verification code',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // INVITATION EMAIL TEMPLATE ⭐ (MISSING)
      // ========================================
      {
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
      
      <div style="background: #eff6ff; border-left: 4px solid #3B82F6; padding: 15px; margin: 20px 0;">
        <strong>Your Role:</strong> {{role}}
      </div>
      
      <p>Click the button below to accept your invitation and create your account:</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{invitationLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Accept Invitation</a>
      </div>
      
      <div style="background: #f8f9fa; border-left: 4px solid #3B82F6; padding: 15px; margin: 20px 0; font-size: 14px;">
        <strong>⏰ Important:</strong> This invitation link will expire in {{expirationTime}} days.
      </div>
      
      <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #3B82F6; font-size: 14px;">{{invitationLink}}</p>
      
      <p style="margin-top: 30px;">If you don't recognize this invitation, please ignore this email.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `Hi {{userName}},

{{inviterName}} has invited you to join {{appName}} as a {{role}}.

Accept your invitation by visiting: {{invitationLink}}

This invitation will expire in {{expirationTime}} days.

If you don't recognize this invitation, please ignore this email.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'Invited user name',
          inviterName: 'Name of person who sent invitation',
          role: 'User role in the platform',
          invitationLink: 'Invitation acceptance URL',
          expirationTime: 'Invitation expiration time in days',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // ACCOUNT LOCKED EMAIL TEMPLATE
      // ========================================
      {
        type: EmailTemplateType.ACCOUNT_LOCKED,
        name: 'Account Locked Notification',
        subject: 'Your Account Has Been Locked - Action Required',
        description: 'Email sent when user account is locked due to security reasons',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Account Locked</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">⚠️ Account Locked</h1>
    </div>
    <div style="padding: 40px 30px;">
      <h2 style="color: #F59E0B;">Hi {{userName}},</h2>
      
      <div style="background: #FFFBEB; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0;">
        <strong>Your {{appName}} account has been temporarily locked.</strong><br>
        Reason: {{lockReason}}<br>
        Locked at: {{timestamp}}
      </div>
      
      <p>{{lockMessage}}</p>
      
      <p><strong>To unlock your account, please:</strong></p>
      <ol>
        <li>Wait for {{unlockDuration}} minutes, or</li>
        <li>Contact our support team for immediate assistance</li>
      </ol>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{supportLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Contact Support</a>
      </div>
      
      <p><strong>To prevent future lockouts:</strong></p>
      <ul>
        <li>Ensure you're using the correct password</li>
        <li>Enable two-factor authentication for added security</li>
        <li>Keep your account recovery information up to date</li>
      </ul>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>Support: {{supportEmail}}</p>
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `⚠️ Account Locked

Hi {{userName}},

Your {{appName}} account has been temporarily locked.

Reason: {{lockReason}}
Locked at: {{timestamp}}

{{lockMessage}}

To unlock your account, please:
1. Wait for {{unlockDuration}} minutes, or
2. Contact our support team for immediate assistance

Contact Support: {{supportLink}}

To prevent future lockouts:
- Ensure you're using the correct password
- Enable two-factor authentication for added security
- Keep your account recovery information up to date

Support: {{supportEmail}}
© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          lockReason: 'Reason for account lock',
          lockMessage: 'Detailed lock message',
          timestamp: 'Lock timestamp',
          unlockDuration: 'Auto-unlock duration in minutes',
          supportLink: 'Support contact URL',
          supportEmail: 'Support email address',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // ALERT NOTIFICATION EMAIL TEMPLATE
      // ========================================
      {
        type: EmailTemplateType.ALERT_NOTIFICATION,
        name: 'Alert Notification',
        subject: '[{{severity}}] {{alertName}} - {{appName}}',
        description: 'Email notification sent when an alert is triggered',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Alert Notification</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #DC2626 0%, #991B1B 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">🚨 Alert Triggered</h1>
    </div>
    <div style="padding: 40px 30px;">
      <div style="background: #FEE2E2; border-left: 4px solid #DC2626; padding: 20px; margin: 20px 0;">
        <h2 style="margin: 0 0 15px 0; color: #DC2626;">{{alertName}}</h2>
        <p style="margin: 5px 0;"><strong>Severity:</strong> {{severity}}</p>
        <p style="margin: 5px 0;"><strong>Device:</strong> {{deviceName}}</p>
        <p style="margin: 5px 0;"><strong>Triggered:</strong> {{timestamp}}</p>
      </div>
      
      <h3 style="color: #DC2626;">Alert Details:</h3>
      <div style="background: white; padding: 15px; margin: 20px 0; border-radius: 5px; border: 1px solid #E5E7EB;">
        <p><strong>Message:</strong> {{message}}</p>
        <p><strong>Current Value:</strong> {{currentValue}}</p>
        <p><strong>Threshold:</strong> {{threshold}}</p>
        <p><strong>Condition:</strong> {{condition}}</p>
      </div>
      
      <p>{{additionalInfo}}</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{alertLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #DC2626 0%, #991B1B 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">View Alert Details</a>
      </div>
      
      <p style="font-size: 14px; color: #6c757d;">To manage your alert preferences, visit your account settings.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `🚨 Alert Triggered

{{alertName}}
Severity: {{severity}}
Device: {{deviceName}}
Triggered: {{timestamp}}

Alert Details:
- Message: {{message}}
- Current Value: {{currentValue}}
- Threshold: {{threshold}}
- Condition: {{condition}}

{{additionalInfo}}

View Alert Details: {{alertLink}}

To manage your alert preferences, visit your account settings.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          alertName: 'Alert name',
          severity: 'Alert severity level (CRITICAL, HIGH, MEDIUM, LOW)',
          deviceName: 'Device name that triggered alert',
          message: 'Alert message',
          currentValue: 'Current measured value',
          threshold: 'Threshold value',
          condition: 'Trigger condition',
          timestamp: 'Alert timestamp',
          additionalInfo: 'Additional information',
          alertLink: 'Link to alert details page',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // DEVICE OFFLINE EMAIL TEMPLATE
      // ========================================
      {
        type: EmailTemplateType.DEVICE_OFFLINE,
        name: 'Device Offline Notification',
        subject: 'Device Offline: {{deviceName}} - {{appName}}',
        description: 'Email notification sent when a device goes offline',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Device Offline</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">⚠️ Device Offline</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p>Hi {{userName}},</p>
      
      <div style="background: #FFFBEB; border-left: 4px solid #F59E0B; padding: 20px; margin: 20px 0;">
        <h2 style="margin: 0 0 10px 0; color: #F59E0B;">{{deviceName}} is offline</h2>
        <p style="margin: 5px 0;"><strong>Last Seen:</strong> {{lastSeen}}</p>
        <p style="margin: 5px 0;"><strong>Offline Duration:</strong> {{offlineDuration}}</p>
      </div>
      
      <h3 style="color: #F59E0B;">Device Information:</h3>
      <div style="background: white; padding: 15px; margin: 20px 0; border-radius: 5px; border: 1px solid #E5E7EB;">
        <p><strong>Device ID:</strong> {{deviceId}}</p>
        <p><strong>Type:</strong> {{deviceType}}</p>
        <p><strong>Location:</strong> {{location}}</p>
        <p><strong>Status:</strong> <span style="color: #DC2626;">Offline</span></p>
      </div>
      
      <p><strong>Recommended Actions:</strong></p>
      <ul>
        <li>Check device power connection</li>
        <li>Verify network connectivity</li>
        <li>Restart the device if accessible</li>
        <li>Check for any error indicators on the device</li>
      </ul>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{deviceLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">View Device Details</a>
      </div>
      
      <p style="font-size: 14px; color: #6c757d;">This notification was sent because you have enabled offline alerts for this device.</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `⚠️ Device Offline

Hi {{userName}},

{{deviceName}} is offline

Last Seen: {{lastSeen}}
Offline Duration: {{offlineDuration}}

Device Information:
- Device ID: {{deviceId}}
- Type: {{deviceType}}
- Location: {{location}}
- Status: Offline

Recommended Actions:
- Check device power connection
- Verify network connectivity
- Restart the device if accessible
- Check for any error indicators on the device

View Device Details: {{deviceLink}}

This notification was sent because you have enabled offline alerts for this device.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          deviceName: 'Device name',
          deviceId: 'Device ID',
          deviceType: 'Device type',
          location: 'Device location',
          lastSeen: 'Last seen timestamp',
          offlineDuration: 'Duration device has been offline',
          deviceLink: 'Link to device details page',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // SUBSCRIPTION EXPIRING EMAIL TEMPLATE
      // ========================================
      {
        type: EmailTemplateType.SUBSCRIPTION_EXPIRING,
        name: 'Subscription Expiring Soon',
        subject: 'Your {{appName}} Subscription Expires in {{daysRemaining}} Days',
        description: 'Email reminder sent when subscription is about to expire',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Subscription Expiring</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">⏰ Subscription Expiring Soon</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p>Hi {{userName}},</p>
      
      <div style="background: #F5F3FF; border-left: 4px solid #8B5CF6; padding: 20px; margin: 20px 0;">
        <h2 style="margin: 0 0 15px 0; color: #8B5CF6;">Your subscription is expiring soon!</h2>
        <p style="margin: 5px 0;"><strong>Expiration Date:</strong> {{expirationDate}}</p>
        <p style="margin: 5px 0;"><strong>Days Remaining:</strong> {{daysRemaining}}</p>
      </div>
      
      <h3 style="color: #8B5CF6;">Current Plan Details:</h3>
      <div style="background: white; padding: 15px; margin: 20px 0; border-radius: 5px; border: 1px solid #E5E7EB;">
        <p><strong>Plan:</strong> {{planName}}</p>
        <p><strong>Price:</strong> {{planPrice}}</p>
        <p><strong>Billing Cycle:</strong> {{billingCycle}}</p>
      </div>
      
      <p>To continue enjoying uninterrupted access to all features, please renew your subscription.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="{{renewLink}}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold;">Renew Subscription</a>
      </div>
      
      <p><strong>What happens if you don't renew:</strong></p>
      <ul>
        <li>Loss of access to premium features</li>
        <li>Device monitoring may be limited</li>
        <li>Historical data access may be restricted</li>
        <li>Alert notifications may be disabled</li>
      </ul>
      
      <p>Have questions? Our support team is here to help at {{supportEmail}}</p>
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `⏰ Subscription Expiring Soon

Hi {{userName}},

Your subscription is expiring soon!

Expiration Date: {{expirationDate}}
Days Remaining: {{daysRemaining}}

Current Plan Details:
- Plan: {{planName}}
- Price: {{planPrice}}
- Billing Cycle: {{billingCycle}}

To continue enjoying uninterrupted access to all features, please renew your subscription.

Renew Subscription: {{renewLink}}

What happens if you don't renew:
- Loss of access to premium features
- Device monitoring may be limited
- Historical data access may be restricted
- Alert notifications may be disabled

Have questions? Our support team is here to help at {{supportEmail}}

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          userName: 'User full name',
          expirationDate: 'Subscription expiration date',
          daysRemaining: 'Days until expiration',
          planName: 'Current plan name',
          planPrice: 'Plan price',
          billingCycle: 'Billing cycle (monthly/yearly)',
          renewLink: 'Subscription renewal link',
          supportEmail: 'Support email address',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },

      // ========================================
      // CUSTOM EMAIL TEMPLATE
      // ========================================
      {
        type: EmailTemplateType.CUSTOM,
        name: 'Custom Email Template',
        subject: '{{subject}}',
        description: 'Customizable template for ad-hoc or special purpose emails',
        htmlTemplate: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{title}}</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4;">
  <div style="max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #6B7280 0%, #4B5563 100%); color: #fff; padding: 40px 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 28px;">{{title}}</h1>
    </div>
    <div style="padding: 40px 30px;">
      {{content}}
    </div>
    <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px;">
      <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`,
        textTemplate: `{{title}}

{{content}}

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          subject: 'Email subject line',
          title: 'Email title/header',
          content: 'Email main content (HTML or plain text)',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },
    ];

    // ========================================
    // SEED TEMPLATES
    // ========================================
    for (const templateData of emailTemplates) {
      try {
        const existing = await this.emailTemplateRepository.findOne({
          where: { type: templateData.type },
        });

        if (!existing) {
          const template = this.emailTemplateRepository.create(templateData);
          await this.emailTemplateRepository.save(template);
          this.logger.log(
            `✅ Created email template: ${templateData.name} (${templateData.type})`,
          );
        } else {
          this.logger.log(
            `⏭️  Email template already exists: ${templateData.name} (${templateData.type})`,
          );
        }
      } catch (error) {
        this.logger.error(
          `❌ Failed to seed template ${templateData.name}:`,
          error.message,
        );
      }
    }

    this.logger.log('🎉 Email template seeding completed!');
  }
}