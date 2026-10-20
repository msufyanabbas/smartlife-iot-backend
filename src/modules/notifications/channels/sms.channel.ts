import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CountryCode, parsePhoneNumber } from 'libphonenumber-js';
import { Twilio } from 'twilio';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { envBoolean, envNumber, envString } from '@/config/env.utils';
import { Notification } from '../entities/notification.entity';

/**
 * SMS notification channel.
 *
 * ─── What changed, and why it mattered ────────────────────────────────────
 * Every provider call in this file used to be commented out, ending in
 * `logger.log('[TWILIO] Would send SMS…')` and returning normally. Because
 * `NotificationsService.sendSMS()` calls `markAsSent()` + `markAsDelivered()`
 * as soon as `send()` resolves, every SMS notification was recorded as
 * **delivered** while nothing ever left the host. An alarm escalation that
 * depends on SMS therefore read as successful in the database and as silence
 * on the operator's phone.
 *
 * The rule this file now follows: **`send()` resolves only when the provider
 * accepted the message.** Anything else throws, so the notification row is
 * marked failed and retried. There is no development short-circuit — a
 * simulated success is the bug, not a convenience.
 *
 * ─── Providers ────────────────────────────────────────────────────────────
 * `SMS_PROVIDER=twilio` (default) or `SMS_PROVIDER=aws_sns`. Both clients are
 * built lazily on first use and cached, so an unconfigured deployment pays
 * nothing and a misconfigured one fails at the send with a message naming the
 * variable that is missing, rather than at boot.
 */

export const SMS_PROVIDERS = ['twilio', 'aws_sns'] as const;
export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/**
 * Twilio message statuses that mean the message was rejected outright. Twilio
 * answers HTTP 201 for `queued`/`accepted`/`sent`, so the HTTP status alone is
 * not proof the message was taken — a `failed` or `undelivered` status comes
 * back on a 201 as well.
 */
const TWILIO_FAILED_STATUSES = new Set(['failed', 'undelivered', 'canceled']);

@Injectable()
export class SmsChannel {
  private readonly logger = new Logger(SmsChannel.name);

  private readonly isEnabled: boolean;
  private readonly provider: SmsProvider;
  private readonly defaultRegion: CountryCode;
  private readonly timeoutMs: number;

  /** Built on first send and kept; `null` means "not built yet". */
  private twilioClient: Twilio | null = null;
  private snsClient: SNSClient | null = null;

  constructor(private readonly configService: ConfigService) {
    // `configService.get('SMS_ENABLED', false)` returned the STRING 'false'
    // for SMS_ENABLED=false, which is truthy — the channel reported itself
    // enabled when it had been explicitly switched off. envBoolean is the one
    // coercion used across the repo (see config/env.utils.ts).
    this.isEnabled = envBoolean(
      this.configService.get<string>('SMS_ENABLED'),
      false,
    );

    const configured = (
      envString(this.configService.get<string>('SMS_PROVIDER'), 'twilio') ??
      'twilio'
    ).toLowerCase();
    this.provider = (SMS_PROVIDERS as readonly string[]).includes(configured)
      ? (configured as SmsProvider)
      : 'twilio';

    if (configured !== this.provider) {
      this.logger.warn(
        `SMS_PROVIDER='${configured}' is not recognised (expected one of ` +
          `${SMS_PROVIDERS.join(' | ')}) — falling back to 'twilio'.`,
      );
    }

    // Same default region as WhatsappChannel: this platform is Saudi-facing
    // and the local form `0501234567` has to resolve to +966501234567.
    this.defaultRegion = (envString(
      this.configService.get<string>('SMS_DEFAULT_REGION'),
      'SA',
    ) ?? 'SA') as CountryCode;

    this.timeoutMs = envNumber(
      this.configService.get<string>('SMS_TIMEOUT_MS'),
      10000,
    );

    if (!this.isEnabled) {
      this.logger.warn(
        'SMS notifications are disabled. Set SMS_ENABLED=true to enable.',
      );
    } else if (!this.isConfigured()) {
      this.logger.warn(
        `SMS_ENABLED=true but the '${this.provider}' provider is not fully ` +
          'configured — sends will fail until its credentials are set.',
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC SURFACE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a notification row over SMS.
   *
   * Throws on every failure path. `NotificationsService.sendNotification()`
   * catches it, calls `markAsFailed()` and schedules a retry — which is the
   * only reason a failed send is visible anywhere.
   */
  async send(notification: Notification): Promise<void> {
    if (!notification.recipientPhone) {
      throw new Error('Recipient phone number is required for SMS channel');
    }

    if (!this.isEnabled) {
      // Deliberately NOT a silent success in development. The previous code
      // returned here when NODE_ENV=development, which marked the row
      // delivered; a developer then had no way to tell a working SMS path from
      // a disabled one.
      throw new Error(
        'SMS channel is disabled (SMS_ENABLED is not true), so the message ' +
          `to ${this.mask(notification.recipientPhone)} was not sent.`,
      );
    }

    const to = this.formatPhoneNumber(notification.recipientPhone);
    if (!this.isValidPhoneNumber(to)) {
      throw new Error(
        `'${notification.recipientPhone}' is not a valid phone number ` +
          `(normalised to '${to}'); expected E.164, e.g. +966501234567.`,
      );
    }

    const message = this.formatSmsMessage(notification);

    this.logger.log(
      `Sending SMS notification ${notification.id} to ${this.mask(to)} ` +
        `via ${this.provider}`,
    );

    try {
      const reference =
        this.provider === 'aws_sns'
          ? await this.sendViaAwsSns(to, message)
          : await this.sendViaTwilio(to, message);

      this.logger.log(
        `SMS notification ${notification.id} accepted by ${this.provider} ` +
          `(reference: ${reference})`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to send SMS notification ${notification.id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Send an arbitrary message to a phone number — used by the 2FA service,
   * which has a code to deliver and no notification row.
   *
   * Returns the provider's message reference so the caller can log it.
   */
  async sendText(phone: string, message: string): Promise<string> {
    if (!phone) throw new Error('A phone number is required to send an SMS');

    if (!this.isEnabled) {
      throw new Error(
        'SMS channel is disabled (SMS_ENABLED is not true), so the message ' +
          `to ${this.mask(phone)} was not sent.`,
      );
    }

    const to = this.formatPhoneNumber(phone);
    if (!this.isValidPhoneNumber(to)) {
      throw new Error(
        `'${phone}' is not a valid phone number (normalised to '${to}'); ` +
          'expected E.164, e.g. +966501234567.',
      );
    }

    return this.provider === 'aws_sns'
      ? this.sendViaAwsSns(to, message)
      : this.sendViaTwilio(to, message);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PROVIDERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Twilio Programmable Messaging.
   *
   * `MESSAGING_SERVICE_SID` is preferred over a bare `from` number when both
   * are set: a messaging service handles sender-pool selection and the
   * alphanumeric sender IDs required in several GCC countries.
   */
  private async sendViaTwilio(to: string, message: string): Promise<string> {
    const client = this.getTwilioClient();

    const messagingServiceSid = envString(
      this.configService.get<string>('TWILIO_MESSAGING_SERVICE_SID'),
    );
    const fromNumber = envString(
      this.configService.get<string>('TWILIO_PHONE_NUMBER'),
    );

    if (!messagingServiceSid && !fromNumber) {
      throw new Error(
        'Twilio sender not configured — set TWILIO_PHONE_NUMBER or ' +
          'TWILIO_MESSAGING_SERVICE_SID.',
      );
    }

    try {
      const result = await client.messages.create({
        body: message,
        to,
        ...(messagingServiceSid
          ? { messagingServiceSid }
          : { from: fromNumber! }),
      });

      // A 201 with status 'failed' is a rejected message, not a sent one.
      if (result.status && TWILIO_FAILED_STATUSES.has(result.status)) {
        throw new Error(
          `Twilio rejected the message (status: ${result.status}` +
            `${result.errorCode ? `, code: ${result.errorCode}` : ''}` +
            `${result.errorMessage ? `, ${result.errorMessage}` : ''}).`,
        );
      }

      return result.sid;
    } catch (error: any) {
      // The Twilio SDK puts its own code/moreInfo on the error object.
      const detail = [
        error.message,
        error.code ? `code ${error.code}` : null,
        error.moreInfo ?? null,
      ]
        .filter(Boolean)
        .join(' — ');
      throw new Error(`Twilio send failed: ${detail}`);
    }
  }

  /**
   * AWS SNS SMS.
   *
   * `SMSType` is set to Transactional: SNS defaults to Promotional, which is
   * lower priority and is silently dropped by some carriers for OTP traffic.
   * `SenderID` is set only when configured, because it is rejected in
   * countries that do not support it (the US among them).
   */
  private async sendViaAwsSns(to: string, message: string): Promise<string> {
    const client = this.getSnsClient();

    const senderId = envString(
      this.configService.get<string>('AWS_SNS_SENDER_ID'),
    );
    const smsType =
      envString(
        this.configService.get<string>('AWS_SNS_SMS_TYPE'),
        'Transactional',
      ) ?? 'Transactional';

    try {
      const result = await client.send(
        new PublishCommand({
          PhoneNumber: to,
          Message: message,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: smsType,
            },
            ...(senderId
              ? {
                  'AWS.SNS.SMS.SenderID': {
                    DataType: 'String',
                    StringValue: senderId,
                  },
                }
              : {}),
          },
        }),
      );

      if (!result.MessageId) {
        // SNS without a MessageId is not a successful publish, whatever the
        // HTTP status was.
        throw new Error('SNS returned no MessageId');
      }

      return result.MessageId;
    } catch (error: any) {
      const detail = [error.name, error.message].filter(Boolean).join(': ');
      throw new Error(`AWS SNS send failed: ${detail}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAZY CLIENTS
  // ══════════════════════════════════════════════════════════════════════════

  private getTwilioClient(): Twilio {
    if (this.twilioClient) return this.twilioClient;

    const accountSid = envString(
      this.configService.get<string>('TWILIO_ACCOUNT_SID'),
    );
    const authToken = envString(
      this.configService.get<string>('TWILIO_AUTH_TOKEN'),
    );

    const missing = [
      accountSid ? null : 'TWILIO_ACCOUNT_SID',
      authToken ? null : 'TWILIO_AUTH_TOKEN',
    ].filter(Boolean);

    if (missing.length > 0) {
      throw new Error(`Twilio credentials not configured: ${missing.join(', ')}`);
    }

    this.twilioClient = new Twilio(accountSid!, authToken!, {
      // Without this the SDK waits on its own default, which is long enough
      // that a notification worker stalls rather than failing and retrying.
      timeout: this.timeoutMs,
    });

    return this.twilioClient;
  }

  private getSnsClient(): SNSClient {
    if (this.snsClient) return this.snsClient;

    const region = envString(
      this.configService.get<string>('AWS_SNS_REGION') ??
        this.configService.get<string>('AWS_REGION'),
    );
    if (!region) {
      throw new Error(
        'AWS SNS region not configured — set AWS_SNS_REGION or AWS_REGION.',
      );
    }

    const accessKeyId = envString(
      this.configService.get<string>('AWS_ACCESS_KEY_ID'),
    );
    const secretAccessKey = envString(
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
    );

    this.snsClient = new SNSClient({
      region,
      requestHandler: { requestTimeout: this.timeoutMs },
      // Explicit keys when they are given; otherwise the SDK's own provider
      // chain, so a task running with an IAM role needs no keys in env at all.
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });

    return this.snsClient;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FORMATTING & VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Format notification message for SMS (keep it concise).
   *
   * The action URL is appended BEFORE truncation is measured, so a long body
   * no longer pushes the link off the end of the message — the body is what
   * gets shortened.
   */
  private formatSmsMessage(notification: Notification): string {
    const maxLength = 160;
    const suffix = notification.action?.url
      ? `\n\n${notification.action.url}`
      : '';

    let head = `${notification.title}\n\n${notification.message}`;
    const budget = maxLength - suffix.length;

    if (head.length > budget) {
      head = head.substring(0, Math.max(0, budget - 3)) + '...';
    }

    return `${head}${suffix}`;
  }

  /** E.164: `+` then 1–15 digits, first digit non-zero. */
  isValidPhoneNumber(phone: string): boolean {
    return /^\+[1-9]\d{1,14}$/.test(phone);
  }

  /**
   * Normalise to E.164.
   *
   * Parsed with `libphonenumber-js` against a default region
   * (`SMS_DEFAULT_REGION`, default SA) rather than the old `'+' + digits`,
   * which turned the Saudi local form `0501234567` into `+0501234567` — not a
   * valid E.164 number, and rejected by both providers. Already-international
   * input is unaffected.
   */
  formatPhoneNumber(phone: string): string {
    try {
      const parsed = parsePhoneNumber(phone, this.defaultRegion);
      if (parsed?.isValid()) return parsed.format('E.164');
    } catch {
      // Fall through to the mechanical form so the caller's validation — not a
      // parser exception — is what decides.
    }

    let formatted = phone.replace(/[^\d+]/g, '');
    if (!formatted.startsWith('+')) formatted = '+' + formatted;
    return formatted;
  }

  /** Keep the country code and the last two digits; redact the rest. */
  private mask(phone: string): string {
    if (phone.length <= 6) return '***';
    return `${phone.slice(0, 4)}***${phone.slice(-2)}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ══════════════════════════════════════════════════════════════════════════

  /** True when the SELECTED provider has everything it needs. */
  isConfigured(): boolean {
    if (this.provider === 'aws_sns') {
      return !!(
        envString(this.configService.get<string>('AWS_SNS_REGION')) ??
        envString(this.configService.get<string>('AWS_REGION'))
      );
    }

    return (
      !!envString(this.configService.get<string>('TWILIO_ACCOUNT_SID')) &&
      !!envString(this.configService.get<string>('TWILIO_AUTH_TOKEN')) &&
      (!!envString(this.configService.get<string>('TWILIO_PHONE_NUMBER')) ||
        !!envString(
          this.configService.get<string>('TWILIO_MESSAGING_SERVICE_SID'),
        ))
    );
  }

  getStatus(): {
    enabled: boolean;
    provider: SmsProvider;
    configured: boolean;
    defaultRegion: string;
  } {
    return {
      enabled: this.isEnabled,
      provider: this.provider,
      configured: this.isConfigured(),
      defaultRegion: this.defaultRegion,
    };
  }
}
