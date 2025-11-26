import { Injectable, Logger } from '@nestjs/common';
import { Notification } from '../entities/notification.entity';
import { MailService } from '@modules/mail/mail.service';

/**
 * Email notification channel
 * Handles sending notifications via email using MailService
 */
@Injectable()
export class EmailChannel {
  private readonly logger = new Logger(EmailChannel.name);

  constructor(private readonly mailService: MailService) {}

  /**
   * Send notification via email
   */
  async send(notification: Notification): Promise<void> {
    if (!notification.recipientEmail) {
      throw new Error('Recipient email is required for email channel');
    }

    try {
      this.logger.log(
        `Sending email notification ${notification.id} to ${notification.recipientEmail}`,
      );

      await this.mailService.sendEmail({
        to: notification.recipientEmail,
        subject: notification.title,
        text: notification.message,
        html:
          notification.htmlContent || this.generateHtmlContent(notification),
      });

      this.logger.log(
        `Email notification ${notification.id} sent successfully`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send email notification ${notification.id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Generate HTML content from notification if not provided
   */
  private generateHtmlContent(notification: Notification): string {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 30px;
              text-align: center;
              border-radius: 8px 8px 0 0;
            }
            .content {
              background: white;
              padding: 30px;
              border: 1px solid #e0e0e0;
              border-top: none;
            }
            .priority-${notification.priority} {
              border-left: 4px solid ${this.getPriorityColor(notification.priority)};
            }
            .button {
              display: inline-block;
              padding: 12px 24px;
              background: #667eea;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              margin-top: 20px;
            }
            .footer {
              text-align: center;
              padding: 20px;
              color: #666;
              font-size: 12px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>${notification.title}</h1>
            </div>
            <div class="content priority-${notification.priority}">
              <p>${notification.message}</p>
              ${
                notification.action
                  ? `
                <a href="${notification.action.url}" class="button">
                  ${notification.action.label}
                </a>
              `
                  : ''
              }
              ${
                notification.metadata
                  ? `
                <div style="margin-top: 20px; padding: 15px; background: #f5f5f5; border-radius: 4px;">
                  <strong>Additional Information:</strong>
                  <pre style="margin: 10px 0; white-space: pre-wrap;">${JSON.stringify(notification.metadata, null, 2)}</pre>
                </div>
              `
                  : ''
              }
            </div>
            <div class="footer">
              <p>This is an automated notification from IoT Platform</p>
              <p>Sent at ${new Date().toLocaleString()}</p>
            </div>
          </div>
        </body>
      </html>
    `;

    return html;
  }

  /**
   * Get color based on priority
   */
  private getPriorityColor(priority: string): string {
    const colors = {
      urgent: '#ef4444',
      high: '#f59e0b',
      normal: '#3b82f6',
      low: '#10b981',
    };
    return colors[priority] || colors.normal;
  }

  /**
   * Validate email address
   */
  isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}
