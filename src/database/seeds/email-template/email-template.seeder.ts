import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EmailTemplate,
  EmailTemplateType,
} from '@modules/email-templates/entities/email-template.entity';
import { ISeeder } from '../seeder.interface';

@Injectable()
export class EmailTemplateSeeder implements ISeeder {
  constructor(
    @InjectRepository(EmailTemplate)
    private readonly emailTemplateRepository: Repository<EmailTemplate>,
  ) {}

  async seed(): Promise<void> {
    const emailTemplates = [
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
      <h2>Hi {{name}},</h2>
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
        textTemplate: `Hi {{name}},

You're attempting to sign in to your {{appName}} account.

Your verification code is: {{code}}

This code will expire in 10 minutes.

⚠️ If you didn't request this code, please ignore this email and ensure your account is secure.

© {{year}} {{appName}}. All rights reserved.`,
        variables: {
          name: 'User name',
          code: 'Verification code',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
      },
      {
        type: EmailTemplateType.VERIFICATION,
        name: 'Email Verification',
        subject: 'Verify Your Email Address',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .button { display: inline-block; padding: 12px 30px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Welcome to {{appName}}!</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <p>Thank you for signing up! Please verify your email address by clicking the button below:</p>
                  <a href="{{verificationLink}}" class="button">Verify Email Address</a>
                  <p>Or copy and paste this link into your browser:</p>
                  <p>{{verificationLink}}</p>
                  <p>This link will expire in {{expirationTime}} hours.</p>
                  <p>If you didn't create an account, please ignore this email.</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          Welcome to {{appName}}!
          
          Hi {{userName}},
          
          Thank you for signing up! Please verify your email address by visiting:
          {{verificationLink}}
          
          This link will expire in {{expirationTime}} hours.
          
          If you didn't create an account, please ignore this email.
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          verificationLink: 'Verification URL',
          expirationTime: 'Link expiration time in hours',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description:
          'Email sent to users to verify their email address after registration',
      },
      {
        type: EmailTemplateType.WELCOME,
        name: 'Welcome Email',
        subject: "Welcome to {{appName}} - Let's Get Started!",
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #10B981; color: white; padding: 30px; text-align: center; }
                .content { padding: 30px; background-color: #ffffff; }
                .feature { margin: 20px 0; padding: 15px; background-color: #f0fdf4; border-left: 4px solid #10B981; }
                .button { display: inline-block; padding: 12px 30px; background-color: #10B981; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Welcome Aboard, {{userName}}! 🎉</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <p>We're thrilled to have you join {{appName}}! Your account is now active and ready to use.</p>
                  <h3>Here's what you can do:</h3>
                  <div class="feature">
                    <strong>📊 Monitor Your Devices</strong><br>
                    Connect and track all your IoT devices in real-time
                  </div>
                  <div class="feature">
                    <strong>🔔 Set Up Alerts</strong><br>
                    Get notified instantly when something needs your attention
                  </div>
                  <div class="feature">
                    <strong>📈 View Analytics</strong><br>
                    Access detailed insights and reports on your device performance
                  </div>
                  <a href="{{dashboardLink}}" class="button">Go to Dashboard</a>
                  <p>Need help getting started? Check out our <a href="{{docsLink}}">documentation</a> or contact our support team.</p>
                  <p>Best regards,<br>The {{appName}} Team</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          Welcome Aboard, {{userName}}!
          
          Hi {{userName}},
          
          We're thrilled to have you join {{appName}}! Your account is now active and ready to use.
          
          Here's what you can do:
          
          - Monitor Your Devices: Connect and track all your IoT devices in real-time
          - Set Up Alerts: Get notified instantly when something needs your attention
          - View Analytics: Access detailed insights and reports on your device performance
          
          Get started: {{dashboardLink}}
          
          Need help? Check out our documentation: {{docsLink}}
          
          Best regards,
          The {{appName}} Team
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          dashboardLink: 'Dashboard URL',
          docsLink: 'Documentation URL',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description:
          'Welcome email sent to new users after successful email verification',
      },
      {
        type: EmailTemplateType.PASSWORD_RESET,
        name: 'Password Reset Request',
        subject: 'Reset Your Password - {{appName}}',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #EF4444; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .button { display: inline-block; padding: 12px 30px; background-color: #EF4444; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .warning { background-color: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Password Reset Request</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <p>We received a request to reset your password for your {{appName}} account.</p>
                  <p>Click the button below to reset your password:</p>
                  <a href="{{resetLink}}" class="button">Reset Password</a>
                  <p>Or copy and paste this link into your browser:</p>
                  <p>{{resetLink}}</p>
                  <p>This link will expire in {{expirationTime}} hours.</p>
                  <div class="warning">
                    <strong>⚠️ Security Notice:</strong><br>
                    If you didn't request a password reset, please ignore this email and your password will remain unchanged. Someone may have entered your email by mistake.
                  </div>
                  <p>For security reasons, we never ask for your password via email.</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          Password Reset Request
          
          Hi {{userName}},
          
          We received a request to reset your password for your {{appName}} account.
          
          Reset your password by visiting:
          {{resetLink}}
          
          This link will expire in {{expirationTime}} hours.
          
          ⚠️ Security Notice:
          If you didn't request a password reset, please ignore this email and your password will remain unchanged.
          
          For security reasons, we never ask for your password via email.
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          resetLink: 'Password reset URL',
          expirationTime: 'Link expiration time in hours',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Email sent to users when they request a password reset',
      },
      {
        type: EmailTemplateType.PASSWORD_CHANGED,
        name: 'Password Changed Confirmation',
        subject: 'Your Password Has Been Changed',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #10B981; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .info-box { background-color: #F0FDF4; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0; }
                .warning { background-color: #FEF2F2; border-left: 4px solid #EF4444; padding: 15px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>Password Changed Successfully ✓</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <p>This is a confirmation that your password was successfully changed on {{timestamp}}.</p>
                  <div class="info-box">
                    <strong>Account Details:</strong><br>
                    Email: {{userEmail}}<br>
                    Changed: {{timestamp}}<br>
                    IP Address: {{ipAddress}}
                  </div>
                  <div class="warning">
                    <strong>⚠️ Didn't make this change?</strong><br>
                    If you didn't change your password, please contact our support team immediately at {{supportEmail}} or reset your password right away.
                  </div>
                  <p>For your security, we recommend:</p>
                  <ul>
                    <li>Using a unique password for your {{appName}} account</li>
                    <li>Enabling two-factor authentication</li>
                    <li>Never sharing your password with anyone</li>
                  </ul>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          Password Changed Successfully
          
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
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          userEmail: 'User email',
          timestamp: 'Change timestamp',
          ipAddress: 'IP address of the change',
          supportEmail: 'Support email address',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Confirmation email sent after successful password change',
      },
      {
        type: EmailTemplateType.ACCOUNT_LOCKED,
        name: 'Account Locked Notification',
        subject: 'Your Account Has Been Locked - Action Required',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .warning { background-color: #FFFBEB; border-left: 4px solid #F59E0B; padding: 15px; margin: 20px 0; }
                .button { display: inline-block; padding: 12px 30px; background-color: #F59E0B; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>⚠️ Account Locked</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <div class="warning">
                    <strong>Your {{appName}} account has been temporarily locked.</strong><br>
                    Reason: {{lockReason}}<br>
                    Locked at: {{timestamp}}
                  </div>
                  <p>{{lockMessage}}</p>
                  <p>To unlock your account, please:</p>
                  <ol>
                    <li>Wait for {{unlockDuration}} minutes, or</li>
                    <li>Contact our support team for immediate assistance</li>
                  </ol>
                  <a href="{{supportLink}}" class="button">Contact Support</a>
                  <p>To prevent future lockouts:</p>
                  <ul>
                    <li>Ensure you're using the correct password</li>
                    <li>Enable two-factor authentication for added security</li>
                    <li>Keep your account recovery information up to date</li>
                  </ul>
                </div>
                <div class="footer">
                  <p>Support: {{supportEmail}}</p>
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          ⚠️ Account Locked
          
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
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          lockReason: 'Reason for account lock',
          lockMessage: 'Detailed lock message',
          timestamp: 'Lock timestamp',
          unlockDuration: 'Auto-unlock duration in minutes',
          supportLink: 'Support contact URL',
          supportEmail: 'Support email',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description:
          'Email sent when user account is locked due to security reasons',
      },
      {
        type: EmailTemplateType.TWO_FACTOR_CODE,
        name: 'Two-Factor Authentication Code',
        subject: 'Your {{appName}} Verification Code',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #6366F1; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; text-align: center; }
                .code { font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #6366F1; background-color: #EEF2FF; padding: 20px; margin: 30px 0; border-radius: 10px; }
                .info { background-color: #EEF2FF; border-left: 4px solid #6366F1; padding: 15px; margin: 20px 0; text-align: left; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>🔐 Verification Code</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <p>Your verification code is:</p>
                  <div class="code">{{verificationCode}}</div>
                  <div class="info">
                    <strong>ℹ️ Important Information:</strong><br>
                    - This code expires in {{expirationTime}} minutes<br>
                    - Use this code to complete your login<br>
                    - Never share this code with anyone
                  </div>
                  <p>If you didn't request this code, please ignore this email and ensure your account is secure.</p>
                </div>
                <div class="footer">
                  <p>Request time: {{timestamp}}</p>
                  <p>IP Address: {{ipAddress}}</p>
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          🔐 Verification Code
          
          Hi {{userName}},
          
          Your verification code is: {{verificationCode}}
          
          Important Information:
          - This code expires in {{expirationTime}} minutes
          - Use this code to complete your login
          - Never share this code with anyone
          
          If you didn't request this code, please ignore this email and ensure your account is secure.
          
          Request time: {{timestamp}}
          IP Address: {{ipAddress}}
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          verificationCode: '6-digit verification code',
          expirationTime: 'Code expiration time in minutes',
          timestamp: 'Request timestamp',
          ipAddress: 'Request IP address',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Email containing two-factor authentication code',
      },
      {
        type: EmailTemplateType.ALERT_NOTIFICATION,
        name: 'Alert Notification',
        subject: '[{{severity}}] {{alertName}} - {{appName}}',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #DC2626; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .alert-box { background-color: #FEE2E2; border-left: 4px solid #DC2626; padding: 20px; margin: 20px 0; }
                .details { background-color: white; padding: 15px; margin: 20px 0; border-radius: 5px; }
                .button { display: inline-block; padding: 12px 30px; background-color: #DC2626; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>🚨 Alert Triggered</h1>
                </div>
                <div class="content">
                  <div class="alert-box">
                    <h2>{{alertName}}</h2>
                    <p><strong>Severity:</strong> {{severity}}</p>
                    <p><strong>Device:</strong> {{deviceName}}</p>
                    <p><strong>Triggered:</strong> {{timestamp}}</p>
                  </div>
                  <h3>Alert Details:</h3>
                  <div class="details">
                    <p><strong>Message:</strong> {{message}}</p>
                    <p><strong>Current Value:</strong> {{currentValue}}</p>
                    <p><strong>Threshold:</strong> {{threshold}}</p>
                    <p><strong>Condition:</strong> {{condition}}</p>
                  </div>
                  <p>{{additionalInfo}}</p>
                  <a href="{{alertLink}}" class="button">View Alert Details</a>
                  <p>To manage your alert preferences, visit your account settings.</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          🚨 Alert Triggered
          
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
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          alertName: 'Alert name',
          severity: 'Alert severity level',
          deviceName: 'Device name',
          message: 'Alert message',
          currentValue: 'Current measured value',
          threshold: 'Threshold value',
          condition: 'Trigger condition',
          timestamp: 'Alert timestamp',
          additionalInfo: 'Additional information',
          alertLink: 'Link to alert details',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Email notification sent when an alert is triggered',
      },
      {
        type: EmailTemplateType.DEVICE_OFFLINE,
        name: 'Device Offline Notification',
        subject: 'Device Offline: {{deviceName}}',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .warning-box { background-color: #FFFBEB; border-left: 4px solid #F59E0B; padding: 20px; margin: 20px 0; }
                .device-info { background-color: white; padding: 15px; margin: 20px 0; border-radius: 5px; }
                .button { display: inline-block; padding: 12px 30px; background-color: #F59E0B; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>⚠️ Device Offline</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <div class="warning-box">
                    <h2>{{deviceName}} is offline</h2>
                    <p><strong>Last Seen:</strong> {{lastSeen}}</p>
                    <p><strong>Offline Duration:</strong> {{offlineDuration}}</p>
                  </div>
                  <h3>Device Information:</h3>
                  <div class="device-info">
                    <p><strong>Device ID:</strong> {{deviceId}}</p>
                    <p><strong>Type:</strong> {{deviceType}}</p>
                    <p><strong>Location:</strong> {{location}}</p>
                    <p><strong>Status:</strong> Offline</p>
                  </div>
                  <p><strong>Recommended Actions:</strong></p>
                  <ul>
                    <li>Check device power connection</li>
                    <li>Verify network connectivity</li>
                    <li>Restart the device if accessible</li>
                    <li>Check for any error indicators on the device</li>
                  </ul>
                  <a href="{{deviceLink}}" class="button">View Device Details</a>
                  <p>This notification was sent because you have enabled offline alerts for this device.</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          ⚠️ Device Offline
          
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
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          deviceName: 'Device name',
          deviceId: 'Device ID',
          deviceType: 'Device type',
          location: 'Device location',
          lastSeen: 'Last seen timestamp',
          offlineDuration: 'Duration device has been offline',
          deviceLink: 'Link to device details',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Email notification sent when a device goes offline',
      },
      {
        type: EmailTemplateType.SUBSCRIPTION_EXPIRING,
        name: 'Subscription Expiring Soon',
        subject: 'Your {{appName}} Subscription Expires Soon',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #8B5CF6; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .notice-box { background-color: #F5F3FF; border-left: 4px solid #8B5CF6; padding: 20px; margin: 20px 0; }
                .plan-info { background-color: white; padding: 15px; margin: 20px 0; border-radius: 5px; }
                .button { display: inline-block; padding: 12px 30px; background-color: #8B5CF6; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>⏰ Subscription Expiring Soon</h1>
                </div>
                <div class="content">
                  <p>Hi {{userName}},</p>
                  <div class="notice-box">
                    <h2>Your subscription is expiring soon!</h2>
                    <p><strong>Expiration Date:</strong> {{expirationDate}}</p>
                    <p><strong>Days Remaining:</strong> {{daysRemaining}}</p>
                  </div>
                  <h3>Current Plan Details:</h3>
                  <div class="plan-info">
                    <p><strong>Plan:</strong> {{planName}}</p>
                    <p><strong>Price:</strong> {{planPrice}}</p>
                    <p><strong>Billing Cycle:</strong> {{billingCycle}}</p>
                  </div>
                  <p>To continue enjoying uninterrupted access to all features, please renew your subscription.</p>
                  <a href="{{renewLink}}" class="button">Renew Subscription</a>
                  <p><strong>What happens if you don't renew:</strong></p>
                  <ul>
                    <li>Loss of access to premium features</li>
                    <li>Device monitoring may be limited</li>
                    <li>Historical data access may be restricted</li>
                    <li>Alert notifications may be disabled</li>
                  </ul>
                  <p>Have questions? Our support team is here to help at {{supportEmail}}</p>
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          ⏰ Subscription Expiring Soon
          
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
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          userName: 'User name',
          expirationDate: 'Subscription expiration date',
          daysRemaining: 'Days until expiration',
          planName: 'Current plan name',
          planPrice: 'Plan price',
          billingCycle: 'Billing cycle',
          renewLink: 'Renewal link',
          supportEmail: 'Support email',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Email reminder sent when subscription is about to expire',
      },
      {
        type: EmailTemplateType.CUSTOM,
        name: 'Custom Template',
        subject: '{{subject}}',
        htmlTemplate: `
          <!DOCTYPE html>
          <html>
            <head>
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #6B7280; color: white; padding: 20px; text-align: center; }
                .content { padding: 30px; background-color: #f9f9f9; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <h1>{{title}}</h1>
                </div>
                <div class="content">
                  {{content}}
                </div>
                <div class="footer">
                  <p>&copy; {{year}} {{appName}}. All rights reserved.</p>
                </div>
              </div>
            </body>
          </html>
        `,
        textTemplate: `
          {{title}}
          
          {{content}}
          
          © {{year}} {{appName}}. All rights reserved.
        `,
        variables: {
          subject: 'Email subject',
          title: 'Email title',
          content: 'Email content (HTML or plain text)',
          appName: 'Application name',
          year: 'Current year',
        },
        isActive: true,
        description: 'Customizable template for ad-hoc emails',
      },
    ];

    for (const templateData of emailTemplates) {
      const existing = await this.emailTemplateRepository.findOne({
        where: { type: templateData.type },
      });

      if (!existing) {
        const template = this.emailTemplateRepository.create(templateData);
        await this.emailTemplateRepository.save(template);
        console.log(
          `✅ Created email template: ${templateData.name} (${templateData.type})`,
        );
      } else {
        console.log(`⏭️  Email template already exists: ${templateData.name}`);
      }
    }

    console.log('🎉 Email template seeding completed!');
  }
}
