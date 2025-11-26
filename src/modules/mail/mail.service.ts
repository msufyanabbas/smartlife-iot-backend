import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import { EmailOptions } from './interfaces/mail.interface';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { EmailTemplateType } from '../email-templates/entities/email-template.entity';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private emailEnabled: boolean = false;

  constructor(
    private configService: ConfigService,
    private emailTemplatesService: EmailTemplatesService,
  ) {
    this.createTransporter();
  }

  private createTransporter() {
    const smtpHost = this.configService.get<string>('SMTP_HOST');
    const smtpPort = this.configService.get<number>('SMTP_PORT');
    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');
    const smtpFrom = this.configService.get<string>('SMTP_FROM');

    // Check if SMTP is configured
    if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      this.logger.warn(
        '⚠️  SMTP not configured. Email functionality is disabled. ' +
          'Add SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS to your .env file to enable emails.',
      );
      this.emailEnabled = false;
      return;
    }

    // Validate SMTP_FROM
    if (!smtpFrom || !smtpFrom.includes('@')) {
      this.logger.error(
        '❌ SMTP_FROM is missing or invalid. Must be a valid email address (e.g., noreply@yourdomain.com). ' +
          'Email functionality is disabled.',
      );
      this.emailEnabled = false;
      return;
    }

    try {
      // Create transporter
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465, // true for 465, false for other ports
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        // Add connection timeout
        connectionTimeout: 5000,
        greetingTimeout: 5000,
      });

      // Verify connection (non-blocking)
      this.transporter.verify((error, success) => {
        if (error) {
          this.logger.error('❌ SMTP connection failed:', error.message);
          this.logger.warn(
            'Email functionality is disabled. Please check your SMTP configuration in .env',
          );
          this.emailEnabled = false;
          this.transporter = null;
        } else {
          this.logger.log('✅ SMTP server is ready to send emails');
          this.logger.log(`📧 Sending emails from: ${smtpFrom}`);
          this.emailEnabled = true;
        }
      });
    } catch (error) {
      this.logger.error('Failed to create SMTP transporter:', error);
      this.emailEnabled = false;
      this.transporter = null;
    }
  }

  /**
   * Check if email service is available
   */
  isEmailEnabled(): boolean {
    return this.emailEnabled && this.transporter !== null;
  }

  /**
   * Send email
   */
  async sendEmail(options: EmailOptions): Promise<boolean> {
    // Check if email is enabled
    if (!this.isEmailEnabled()) {
      this.logger.warn(
        `📧 Email not sent to ${options.to} (SMTP not configured). ` +
          `Subject: "${options.subject}"`,
      );
      return false;
    }

    try {
      const smtpFrom = this.configService.get<string>('SMTP_FROM');
      const appName = this.configService.get<string>(
        'APP_NAME',
        'IoT Platform',
      );

      // Validate sender email
      if (!smtpFrom || !smtpFrom.includes('@')) {
        this.logger.error(
          `❌ Cannot send email: SMTP_FROM is invalid or missing. ` +
            `Current value: "${smtpFrom}". Must be a valid email address.`,
        );
        return false;
      }

      const mailOptions = {
        from: `"${appName}" <${smtpFrom}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      };

      const info = await this.transporter!.sendMail(mailOptions);
      this.logger.log(`✅ Email sent to ${options.to}: ${info.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(
        `❌ Failed to send email to ${options.to}:`,
        error.message,
      );
      return false;
    }
  }

  /**
   * Send verification email using database template
   */
  async sendVerificationEmail(
    email: string,
    name: string,
    token: string,
  ): Promise<boolean> {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const appName = this.configService.get<string>('APP_NAME', 'IoT Platform');
    const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;

    try {
      // Get template from database
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.VERIFICATION,
          {
            userName: name,
            appName,
            verificationUrl,
            year: new Date().getFullYear().toString(),
          },
        );

      return this.sendEmail({
        to: email,
        subject,
        html,
        text,
      });
    } catch (error) {
      this.logger.error(
        `Failed to get verification template: ${error.message}. Using fallback.`,
      );

      // Fallback to inline template if database template not found
      const html = this.getVerificationEmailTemplate(name, verificationUrl);
      const text = `Hi ${name},\n\nPlease verify your email by visiting: ${verificationUrl}\n\nThis link will expire in 24 hours.`;

      return this.sendEmail({
        to: email,
        subject: `Verify Your Email - ${appName}`,
        html,
        text,
      });
    }
  }

  /**
   * Send welcome email using database template
   */
  async sendWelcomeEmail(email: string, name: string): Promise<boolean> {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const appName = this.configService.get<string>('APP_NAME', 'IoT Platform');

    try {
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.WELCOME,
          {
            name,
            appName,
            dashboardUrl: `${frontendUrl}/overview`,
            year: new Date().getFullYear().toString(),
          },
        );

      return this.sendEmail({
        to: email,
        subject,
        html,
        text,
      });
    } catch (error) {
      this.logger.error(
        `Failed to get welcome template: ${error.message}. Using fallback.`,
      );

      // Fallback
      const html = this.getWelcomeEmailTemplate(name);
      const text = `Welcome to ${appName}, ${name}!\n\nYour email has been verified successfully. You can now access all features of the platform.`;

      return this.sendEmail({
        to: email,
        subject: `Welcome to ${appName}!`,
        html,
        text,
      });
    }
  }

  /**
   * Send password reset email using database template
   */
  async sendPasswordResetEmail(
    email: string,
    name: string,
    token: string,
  ): Promise<boolean> {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const appName = this.configService.get<string>('APP_NAME', 'IoT Platform');
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    try {
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.PASSWORD_RESET,
          {
            name,
            appName,
            resetUrl,
            year: new Date().getFullYear().toString(),
          },
        );

      return this.sendEmail({
        to: email,
        subject,
        html,
        text,
      });
    } catch (error) {
      this.logger.error(
        `Failed to get password reset template: ${error.message}. Using fallback.`,
      );

      // Fallback
      const html = this.getPasswordResetEmailTemplate(name, resetUrl);
      const text = `Hi ${name},\n\nYou requested to reset your password. Please visit: ${resetUrl}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.`;

      return this.sendEmail({
        to: email,
        subject: `Reset Your Password - ${appName}`,
        html,
        text,
      });
    }
  }

  /**
   * Email verification template (fallback)
   */
  private getVerificationEmailTemplate(
    name: string,
    verificationUrl: string,
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your Email</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; }
    .content h2 { color: #667eea; margin-top: 0; }
    .button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; transition: transform 0.2s; }
    .button:hover { transform: scale(1.05); }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
    .footer a { color: #667eea; text-decoration: none; }
    .note { background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔐 Email Verification</h1>
    </div>
    <div class="content">
      <h2>Hi ${name}! 👋</h2>
      <p>Thank you for registering with <strong>IoT Platform</strong>!</p>
      <p>To complete your registration and start using our platform, please verify your email address by clicking the button below:</p>
      
      <div style="text-align: center;">
        <a href="${verificationUrl}" class="button">Verify Email Address</a>
      </div>
      
      <div class="note">
        <strong>⏰ Important:</strong> This verification link will expire in 24 hours.
      </div>
      
      <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #667eea; font-size: 14px;">${verificationUrl}</p>
      
      <p style="margin-top: 30px;">If you didn't create an account, please ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} IoT Platform. All rights reserved.</p>
      <p>Need help? <a href="mailto:support@iotplatform.com">Contact Support</a></p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Welcome email template (fallback)
   */
  private getWelcomeEmailTemplate(name: string): string {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; }
    .content h2 { color: #667eea; margin-top: 0; }
    .button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; }
    .feature { background: #f8f9fa; padding: 15px; margin: 10px 0; border-radius: 6px; }
    .feature h3 { margin: 0 0 10px 0; color: #667eea; font-size: 16px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎉 Welcome to IoT Platform!</h1>
    </div>
    <div class="content">
      <h2>Hi ${name}! 👋</h2>
      <p>Your email has been verified successfully! You're all set to start using IoT Platform.</p>
      
      <h3 style="color: #667eea; margin-top: 30px;">What's Next?</h3>
      
      <div class="feature">
        <h3>📊 Connect Your Devices</h3>
        <p>Start adding your IoT devices to the platform and monitor them in real-time.</p>
      </div>
      
      <div class="feature">
        <h3>📈 Analytics & Insights</h3>
        <p>Get powerful insights from your device data with our analytics dashboard.</p>
      </div>
      
      <div class="feature">
        <h3>⚡ Automation</h3>
        <p>Set up rules and automation to make your devices work smarter.</p>
      </div>
      
      <div style="text-align: center;">
        <a href="${frontendUrl}/overview" class="button">Go to Dashboard</a>
      </div>
      
      <p style="margin-top: 30px;">If you have any questions, our support team is here to help!</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} IoT Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Password reset email template (fallback)
   */
  private getPasswordResetEmailTemplate(
    name: string,
    resetUrl: string,
  ): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Password</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; }
    .button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; }
    .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔒 Reset Your Password</h1>
    </div>
    <div class="content">
      <h2>Hi ${name},</h2>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      
      <div style="text-align: center;">
        <a href="${resetUrl}" class="button">Reset Password</a>
      </div>
      
      <div class="warning">
        <strong>⚠️ Security Notice:</strong> This link will expire in 1 hour for security reasons.
      </div>
      
      <p>If you didn't request a password reset, please ignore this email and your password will remain unchanged.</p>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">For security reasons, we cannot display your current password. If you remember your password, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} IoT Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;
  }
}
