import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CountryCode, parsePhoneNumber } from 'libphonenumber-js';
import { Notification } from '../entities/notification.entity';

/**
 * WhatsApp notification channel — Unifonic.
 *
 * Unifonic is the common choice for Saudi-facing messaging; the REST contract is
 * form-encoded (`application/x-www-form-urlencoded`) and authenticated by an
 * `AppSid` carried in the body rather than a header.
 *
 * The base URL is configurable (`UNIFONIC_WHATSAPP_URL`) because Unifonic serves
 * different tenants from different hosts — the default below matches the public
 * documentation, but a provisioned account may be pointed elsewhere. Verify the
 * host against your account before relying on this in production.
 *
 * Errors are re-thrown, not swallowed: NotificationsService.sendNotification()
 * catches them, calls markAsFailed() and schedules a retry. A channel that
 * logged and returned would leave the notification stuck in PENDING forever.
 */
@Injectable()
export class WhatsappChannel {
  private readonly logger = new Logger(WhatsappChannel.name);

  private static readonly DEFAULT_URL =
    'https://api.unifonic.com/rest/WhatsApp/messages';

  private readonly appSid?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultRegion: CountryCode;

  constructor(private readonly configService: ConfigService) {
    this.appSid = this.configService.get<string>('UNIFONIC_APP_SID');
    this.baseUrl = this.configService.get<string>(
      'UNIFONIC_WHATSAPP_URL',
      WhatsappChannel.DEFAULT_URL,
    );
    this.timeoutMs = Number(
      this.configService.get<string>('UNIFONIC_TIMEOUT_MS', '10000'),
    );
    this.defaultRegion = this.configService.get<string>(
      'UNIFONIC_DEFAULT_REGION',
      'SA',
    ) as CountryCode;

    if (!this.appSid) {
      this.logger.warn(
        'UNIFONIC_APP_SID not configured — WhatsApp notifications will fail.',
      );
    }
  }

  async send(notification: Notification): Promise<void> {
    const phone = notification.recipientPhone;
    if (!phone) {
      throw new Error(
        'Recipient phone number is required for the WhatsApp channel',
      );
    }

    if (!this.appSid) {
      throw new Error('UNIFONIC_APP_SID not configured');
    }

    const recipient = this.formatPhoneNumber(phone);

    try {
      const response = await axios.post(
        this.baseUrl,
        new URLSearchParams({
          AppSid: this.appSid,
          Body: this.formatMessage(notification),
          Recipient: recipient,
          ContentType: 'text',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: this.timeoutMs,
        },
      );

      // Unifonic answers HTTP 200 with `success: false` on a rejected send
      // (bad recipient, unfunded balance, template not approved), so the status
      // code alone is not proof of delivery.
      const body = response.data;
      if (body && body.success === false) {
        throw new Error(
          `Unifonic rejected the message: ${
            body.message ?? body.errorCode ?? 'unknown error'
          }`,
        );
      }

      this.logger.log(
        `WhatsApp notification ${notification.id} sent to ${recipient} via Unifonic`,
      );
    } catch (error: any) {
      // axios puts the provider's own error body on error.response.data.
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      this.logger.error(`Unifonic WhatsApp failed for ${recipient}: ${detail}`);
      throw new Error(`Unifonic WhatsApp failed: ${detail}`);
    }
  }

  /**
   * WhatsApp supports a limited markdown subset — *bold* for the title.
   * Unlike SMS there is no 160-character ceiling, so the body is not truncated.
   */
  private formatMessage(notification: Notification): string {
    let message = `*${notification.title}*\n${notification.message}`;

    if (notification.action?.url) {
      message += `\n\n${notification.action.url}`;
    }

    return message;
  }

  /**
   * Normalise to E.164, which is what Unifonic expects as `Recipient`.
   *
   * Parsed with a default region (`UNIFONIC_DEFAULT_REGION`, default SA) rather
   * than SmsChannel's bare `'+' + digits`: that turns the Saudi local form
   * `0501234567` into `+0501234567`, which is not a valid E.164 number and is
   * rejected by the provider. With a region the same input yields
   * `+966501234567`. Already-international input is unaffected.
   */
  formatPhoneNumber(phone: string): string {
    try {
      const parsed = parsePhoneNumber(phone, this.defaultRegion);
      if (parsed?.isValid()) return parsed.format('E.164');
    } catch {
      // Fall through — an unparseable number is still worth attempting, so the
      // provider's own error is what surfaces rather than a local exception.
    }

    let formatted = phone.replace(/[^\d+]/g, '');
    if (!formatted.startsWith('+')) formatted = '+' + formatted;
    return formatted;
  }

  getStatus(): { provider: string; configured: boolean; url: string } {
    return {
      provider: 'Unifonic',
      configured: !!this.appSid,
      url: this.baseUrl,
    };
  }
}
