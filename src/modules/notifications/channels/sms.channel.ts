import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';

/**
 * SMS notification channel
 * Handles sending notifications via SMS
 *
 * Currently configured for Twilio, but can be adapted for:
 * - AWS SNS
 * - Nexmo/Vonage
 * - MessageBird
 * - etc.
 */
@Injectable()
export class SmsChannel {
  private readonly logger = new Logger(SmsChannel.name);
  private readonly isEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get('SMS_ENABLED', false);

    if (!this.isEnabled) {
      this.logger.warn(
        'SMS notifications are disabled. Set SMS_ENABLED=true to enable.',
      );
    }
  }

  /**
   * Send notification via SMS
   */
  async send(notification: Notification): Promise<void> {
    if (!notification.recipientPhone) {
      throw new Error('Recipient phone number is required for SMS channel');
    }

    if (!this.isEnabled) {
      this.logger.warn(
        `SMS channel is disabled. Would send to ${notification.recipientPhone}: ${notification.message}`,
      );
      // In development, we'll simulate success
      if (this.configService.get('NODE_ENV') === 'development') {
        return;
      }
      throw new Error('SMS channel is not enabled');
    }

    try {
      this.logger.log(
        `Sending SMS notification ${notification.id} to ${notification.recipientPhone}`,
      );

      // Format message for SMS (keep it short)
      const smsMessage = this.formatSmsMessage(notification);

      // Send via configured SMS provider
      await this.sendViaTwilio(notification.recipientPhone, smsMessage);

      this.logger.log(`SMS notification ${notification.id} sent successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to send SMS notification ${notification.id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Send via Twilio
   */
  private async sendViaTwilio(to: string, message: string): Promise<void> {
    const accountSid = this.configService.get('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get('TWILIO_AUTH_TOKEN');
    const fromNumber = this.configService.get('TWILIO_PHONE_NUMBER');

    if (!accountSid || !authToken || !fromNumber) {
      throw new Error('Twilio credentials not configured');
    }

    try {
      // Uncomment when Twilio is installed: npm install twilio

      // const twilio = require('twilio');
      // const client = twilio(accountSid, authToken);

      // await client.messages.create({
      //   body: message,
      //   from: fromNumber,
      //   to: to,
      // });

      // For now, just log
      this.logger.log(`[TWILIO] Would send SMS to ${to}: ${message}`);
    } catch (error) {
      this.logger.error(`Twilio error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send via AWS SNS (alternative)
   */
  private async sendViaAwsSns(to: string, message: string): Promise<void> {
    // Uncomment when AWS SDK is installed: npm install @aws-sdk/client-sns

    // import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

    // const client = new SNSClient({
    //   region: this.configService.get('AWS_REGION'),
    //   credentials: {
    //     accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
    //     secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
    //   },
    // });

    // const command = new PublishCommand({
    //   PhoneNumber: to,
    //   Message: message,
    // });

    // await client.send(command);

    this.logger.log(`[AWS SNS] Would send SMS to ${to}: ${message}`);
  }

  /**
   * Format notification message for SMS (keep it concise)
   */
  private formatSmsMessage(notification: Notification): string {
    let message = `${notification.title}\n\n${notification.message}`;

    // Truncate if too long (SMS has 160 character limit for single message)
    const maxLength = 160;
    if (message.length > maxLength) {
      message = message.substring(0, maxLength - 3) + '...';
    }

    // Add action link if available
    if (notification.action?.url) {
      // Use URL shortener in production
      message += `\n\n${notification.action.url}`;
    }

    return message;
  }

  /**
   * Validate phone number format
   */
  isValidPhoneNumber(phone: string): boolean {
    // Basic validation - customize based on your requirements
    // This accepts E.164 format: +[country code][number]
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phone);
  }

  /**
   * Format phone number to E.164 format
   */
  formatPhoneNumber(phone: string): string {
    // Remove all non-digit characters except leading +
    let formatted = phone.replace(/[^\d+]/g, '');

    // Ensure it starts with +
    if (!formatted.startsWith('+')) {
      formatted = '+' + formatted;
    }

    return formatted;
  }

  /**
   * Get SMS provider status
   */
  getStatus(): {
    enabled: boolean;
    provider: string;
    configured: boolean;
  } {
    const twilioConfigured =
      !!this.configService.get('TWILIO_ACCOUNT_SID') &&
      !!this.configService.get('TWILIO_AUTH_TOKEN') &&
      !!this.configService.get('TWILIO_PHONE_NUMBER');

    return {
      enabled: this.isEnabled,
      provider: 'Twilio', // or 'AWS SNS', 'Nexmo', etc.
      configured: twilioConfigured,
    };
  }
}
