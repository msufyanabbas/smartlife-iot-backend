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
        'Smart Life IoT Platform',
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
   * ✅ FIXED: Uses correct variable names matching the template
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
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

    // ✅ Build the verification URL
    const verificationLink = `${frontendUrl}/verify-email?token=${token}`;

    try {
      // ✅ Get template from database with CORRECT variable names
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.VERIFICATION,
          {
            userName: name, // ✅ Template expects: userName
            appName, // ✅ Template expects: appName
            verificationLink, // ✅ Template expects: verificationLink (NOT verificationUrl)
            expirationTime: '24', // ✅ Template expects: expirationTime
            year: new Date().getFullYear().toString(), // ✅ Auto-added but explicit is better
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
      const html = this.getVerificationEmailTemplate(name, verificationLink);
      const text = `Hi ${name},\n\nPlease verify your email by visiting: ${verificationLink}\n\nThis link will expire in 24 hours.`;

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
   * ✅ FIXED: Uses correct variable names matching the template
   */
  async sendWelcomeEmail(email: string, name: string): Promise<boolean> {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

    try {
      // ✅ Template expects: userName, appName, dashboardLink, docsLink, year
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.WELCOME,
          {
            userName: name, // ✅ Template expects: userName (NOT just name)
            appName,
            dashboardLink: `${frontendUrl}/dashboard`, // ✅ Template expects: dashboardLink
            docsLink: `${frontendUrl}/docs`, // ✅ Template expects: docsLink
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
   * ✅ FIXED: Uses correct variable names matching the template
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
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

    // ✅ Build the reset URL
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

    try {
      // ✅ Template expects: userName, appName, resetLink, expirationTime, year
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.PASSWORD_RESET,
          {
            userName: name, // ✅ Template expects: userName
            appName,
            resetLink, // ✅ Template expects: resetLink (NOT resetUrl)
            expirationTime: '1', // ✅ Template expects: expirationTime (in hours)
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
      const html = this.getPasswordResetEmailTemplate(name, resetLink);
      const text = `Hi ${name},\n\nYou requested to reset your password. Please visit: ${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.`;

      return this.sendEmail({
        to: email,
        subject: `Reset Your Password - ${appName}`,
        html,
        text,
      });
    }
  }

  /**
   * Send two-factor authentication code email using database template
   * ✅ FIXED: Uses correct variable names matching the template
   */
  async sendTwoFactorCode(
    email: string,
    name: string,
    code: string,
  ): Promise<boolean> {
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

    try {
      // ✅ Template expects: userName, code, appName, year
      const { subject, html, text } =
        await this.emailTemplatesService.getRenderedEmail(
          EmailTemplateType.TWO_FACTOR_CODE,
          {
            userName: name, // ✅ Template expects: userName
            code, // ✅ Template expects: code
            appName,
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
        `Failed to get 2FA code template: ${error.message}. Using fallback.`,
      );

      // Fallback to inline template if database template not found
      const html = this.getTwoFactorCodeEmailTemplate(name, code);
      const text = `Hi ${name},\n\nYour two-factor authentication code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email or contact support.`;

      return this.sendEmail({
        to: email,
        subject: `Your Two-Factor Authentication Code - ${appName}`,
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
    verificationLink: string,
  ): string {
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

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
      <p>Thank you for registering with <strong>${appName}</strong>!</p>
      <p>To complete your registration and start using our platform, please verify your email address by clicking the button below:</p>
      
      <div style="text-align: center;">
        <a href="${verificationLink}" class="button">Verify Email Address</a>
      </div>
      
      <div class="note">
        <strong>⏰ Important:</strong> This verification link will expire in 24 hours.
      </div>
      
      <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #667eea; font-size: 14px;">${verificationLink}</p>
      
      <p style="margin-top: 30px;">If you didn't create an account, please ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
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
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
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
    .header { background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; }
    .content h2 { color: #10B981; margin-top: 0; }
    .button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; }
    .feature { background: #f0fdf4; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid #10B981; }
    .feature h3 { margin: 0 0 10px 0; color: #10B981; font-size: 16px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎉 Welcome to ${appName}!</h1>
    </div>
    <div class="content">
      <h2>Hi ${name}! 👋</h2>
      <p>Your email has been verified successfully! You're all set to start using ${appName}.</p>
      
      <h3 style="color: #10B981; margin-top: 30px;">What's Next?</h3>
      
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
        <a href="${frontendUrl}/dashboard" class="button">Go to Dashboard</a>
      </div>
      
      <p style="margin-top: 30px;">If you have any questions, our support team is here to help!</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
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
    resetLink: string,
  ): string {
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

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
    .header { background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; }
    .button { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: #fff !important; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; }
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
        <a href="${resetLink}" class="button">Reset Password</a>
      </div>
      
      <div class="warning">
        <strong>⚠️ Security Notice:</strong> This link will expire in 1 hour for security reasons.
      </div>
      
      <p>If you didn't request a password reset, please ignore this email and your password will remain unchanged.</p>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">For security reasons, we cannot display your current password. If you remember your password, you can safely ignore this email.</p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `;
  }

  /**
   * Two-factor authentication code email template (fallback)
   */
  private getTwoFactorCodeEmailTemplate(name: string, code: string): string {
    const appName = this.configService.get<string>(
      'APP_NAME',
      'Smart Life IoT Platform',
    );

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Two-Factor Authentication Code</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 40px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; }
    .content { padding: 40px 30px; text-align: center; }
    .code-box { background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 30px; margin: 30px 0; }
    .code { font-size: 36px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace; }
    .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; text-align: left; }
    .note { background: #f8f9fa; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; font-size: 14px; text-align: left; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔐 Two-Factor Authentication</h1>
    </div>
    <div class="content">
      <h2 style="color: #667eea; margin-top: 0;">Hi ${name}! 👋</h2>
      <p>You requested a two-factor authentication code. Here it is:</p>
      
      <div class="code-box">
        <div class="code">${code}</div>
      </div>
      
      <div class="note">
        <strong>⏰ Important:</strong> This code will expire in <strong>10 minutes</strong>.
      </div>
      
      <div class="warning">
        <strong>🔒 Security Notice:</strong> If you didn't request this code, please ignore this email or contact our support team immediately.
      </div>
      
      <p style="margin-top: 30px; font-size: 14px; color: #6c757d;">
        Never share this code with anyone. ${appName} staff will never ask you for this code.
      </p>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
  }
}