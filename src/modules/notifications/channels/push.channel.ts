import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
// Modular subpath imports, not the `import * as admin from 'firebase-admin'`
// namespace style. firebase-admin 14 is modular: `admin.apps`,
// `admin.credential.cert()` and `admin.messaging()` do not exist on the root
// export any more, and using them is a compile error rather than a runtime
// surprise.
import {
  cert,
  getApp,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import {
  getMessaging,
  type AndroidConfig,
  type ApnsConfig,
  type Messaging,
} from 'firebase-admin/messaging';
import * as webpush from 'web-push';
import { envBoolean, envNumber, envString } from '@/config/env.utils';
import { Notification } from '../entities/notification.entity';
import {
  PushSubscription,
  type PushPlatform,
} from '../entities/push-subscription.entity';

/**
 * Push notification channel.
 *
 * ─── What changed, and why it mattered ────────────────────────────────────
 * Every provider call was commented out. `sendViaFcm()` ended in
 * `logger.log('[FCM] Would send…')` and returned; `sendToMultipleDevices()`
 * set `success = deviceTokens.length` and reported a clean sweep without
 * contacting anything. Since `NotificationsService.sendPush()` marks the row
 * sent **and delivered** the moment `send()` resolves, every push notification
 * in the database was a lie.
 *
 * Now: FCM through `firebase-admin` for Android and iOS, Web Push through
 * `web-push` for browsers, and a throw on every failure so the row is marked
 * failed and retried.
 *
 * ─── APNs ─────────────────────────────────────────────────────────────────
 * There is **no direct APNs transport here**, and none is faked. The `apn`
 * package is not installed in this repo (verified: absent from package.json
 * and from node_modules) and installing it is out of scope for this change, so
 * `sendViaApns()` does not exist any more — the method that used to log
 * "[APNS] Would send…" has been removed rather than left as a trap.
 *
 * iOS devices are delivered **through FCM**, which is a supported production
 * path: the Firebase project is configured with the APNs auth key, and
 * firebase-admin relays to APNs server-side. The only thing this costs is the
 * handful of APNs features FCM does not expose (per-message collapse IDs
 * beyond FCM's own, and alternate push types). An `ios` row still gets the
 * `apns` payload block below, which is how sound/badge/content-available reach
 * the device.
 *
 * ─── Degraded states are explicit ─────────────────────────────────────────
 * `PUSH_ENABLED=false`, missing Firebase credentials and missing VAPID keys
 * all produce a throw naming the variable that is missing. None of them
 * resolves successfully. That is the whole point of this file.
 */

/** FCM error codes that mean the token is dead and should be pruned. */
const FCM_DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Web Push statuses that mean the subscription is gone. */
const WEB_PUSH_DEAD_STATUSES = new Set([404, 410]);

export interface PushSendOutcome {
  token: string;
  platform: PushPlatform;
  ok: boolean;
  /** Provider message id, when the provider returned one. */
  reference?: string;
  error?: string;
  /** True when the provider said this token no longer exists. */
  dead?: boolean;
}

export interface PushMulticastResult {
  success: number;
  failure: number;
  outcomes: PushSendOutcome[];
  /** Tokens the provider reported as unregistered; disabled in the table. */
  deadTokens: string[];
}

@Injectable()
export class PushChannel {
  private readonly logger = new Logger(PushChannel.name);

  private readonly isEnabled: boolean;
  private readonly ttlSeconds: number;

  /**
   * The Firebase app, built once, lazily.
   *
   * `undefined` = not attempted yet. `null` = attempted and unconfigured —
   * cached so a misconfigured deployment does not re-derive the same failure
   * on every notification.
   */
  private firebaseApp?: App | null;
  private vapidReady?: boolean;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(PushSubscription)
    private readonly subscriptionRepository: Repository<PushSubscription>,
  ) {
    // `configService.get('PUSH_ENABLED', false)` returned the string 'false'
    // for PUSH_ENABLED=false — truthy, so the channel reported itself enabled
    // when it had been switched off.
    this.isEnabled = envBoolean(
      this.configService.get<string>('PUSH_ENABLED'),
      false,
    );
    this.ttlSeconds = envNumber(
      this.configService.get<string>('PUSH_TTL_SECONDS'),
      3600,
    );

    if (!this.isEnabled) {
      this.logger.warn(
        'Push notifications are disabled. Set PUSH_ENABLED=true to enable.',
      );
    } else {
      const status = this.getStatus();
      if (!status.fcmConfigured && !status.webPushConfigured) {
        this.logger.warn(
          'PUSH_ENABLED=true but neither FCM (FIREBASE_PROJECT_ID / ' +
            'FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) nor Web Push ' +
            '(VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT) is ' +
            'configured — every push send will fail until one of them is.',
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SINGLE SEND
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send one notification to `notification.recipientDeviceToken`.
   *
   * The token is looked up in `push_subscriptions` so the platform (and, for
   * Web Push, the encryption keys) are known. A token with no row is still
   * attempted — treated as `web` when it looks like an endpoint URL and as FCM
   * otherwise — because a caller that already holds a token should not be
   * refused for a bookkeeping reason.
   */
  async send(notification: Notification): Promise<void> {
    const token = notification.recipientDeviceToken;
    if (!token) {
      throw new Error('Recipient device token is required for push channel');
    }

    this.assertEnabled();

    const subscription = await this.subscriptionRepository.findOne({
      where: { token, deletedAt: IsNull() },
    });

    if (subscription && !subscription.enabled) {
      throw new Error(
        'That push subscription was disabled after the provider reported it ' +
          `as unregistered${
            subscription.lastError ? `: ${subscription.lastError}` : ''
          }. The device must register again.`,
      );
    }

    const platform: PushPlatform =
      subscription?.platform ?? (this.looksLikeWebPushEndpoint(token) ? 'web' : 'unknown');

    const outcome = await this.deliver(
      token,
      platform,
      subscription?.keys ?? null,
      notification,
    );

    if (!outcome.ok) {
      if (outcome.dead) await this.disableToken(token, outcome.error ?? 'unregistered');
      throw new Error(outcome.error ?? 'Push delivery failed');
    }

    if (subscription) {
      subscription.touch();
      await this.subscriptionRepository.save(subscription);
    }

    this.logger.log(
      `Push notification ${notification.id} delivered to a ${platform} ` +
        `device (reference: ${outcome.reference ?? 'n/a'})`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MULTICAST
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send to many tokens.
   *
   * Returns real counts. The old implementation returned
   * `{ success: deviceTokens.length, failure: 0 }` without a network call, so
   * a broadcast to 10,000 stale tokens read as 10,000 successes.
   *
   * FCM tokens go out through `sendEachForMulticast` in batches of 500 (the
   * API's hard limit); web endpoints are sent individually because Web Push
   * has no batch API — each one is a separate authenticated HTTP request to
   * the browser vendor's service.
   */
  async sendToMultipleDevices(
    deviceTokens: string[],
    notification: Notification,
  ): Promise<PushMulticastResult> {
    const result: PushMulticastResult = {
      success: 0,
      failure: 0,
      outcomes: [],
      deadTokens: [],
    };

    const tokens = [...new Set(deviceTokens.filter(Boolean))];
    if (tokens.length === 0) return result;

    this.assertEnabled();

    // One query rather than one per token: the platform and keys for the whole
    // batch, so a 500-token send is 1 read and not 500.
    const rows = await this.subscriptionRepository.find({
      where: tokens.map((token) => ({ token, deletedAt: IsNull() })),
    });
    const byToken = new Map(rows.map((row) => [row.token, row]));

    const fcmTokens: string[] = [];
    const webTokens: string[] = [];

    for (const token of tokens) {
      const row = byToken.get(token);
      if (row && !row.enabled) {
        result.failure += 1;
        result.outcomes.push({
          token,
          platform: row.platform,
          ok: false,
          error: 'Subscription disabled — the provider reported it unregistered',
        });
        continue;
      }
      const platform =
        row?.platform ?? (this.looksLikeWebPushEndpoint(token) ? 'web' : 'unknown');
      if (platform === 'web') webTokens.push(token);
      else fcmTokens.push(token);
    }

    if (fcmTokens.length > 0) {
      await this.sendFcmBatches(fcmTokens, byToken, notification, result);
    }

    for (const token of webTokens) {
      const row = byToken.get(token);
      const outcome = await this.deliver(
        token,
        'web',
        row?.keys ?? null,
        notification,
      );
      this.record(result, outcome);
    }

    // Prune everything the providers declared dead, in one statement.
    if (result.deadTokens.length > 0) {
      await this.disableTokens(result.deadTokens);
    }

    // Touch the ones that worked, so a subscription that is still in use does
    // not look abandoned to a future cleanup job.
    const delivered = result.outcomes
      .filter((o) => o.ok)
      .map((o) => o.token)
      .filter((token) => byToken.has(token));
    if (delivered.length > 0) {
      await this.subscriptionRepository
        .createQueryBuilder()
        .update(PushSubscription)
        .set({ lastSeenAt: new Date() })
        .where('token IN (:...tokens)', { tokens: delivered })
        .execute();
    }

    this.logger.log(
      `Push multicast: ${result.success} delivered, ${result.failure} failed, ` +
        `${result.deadTokens.length} token(s) disabled`,
    );

    return result;
  }

  private async sendFcmBatches(
    tokens: string[],
    byToken: Map<string, PushSubscription>,
    notification: Notification,
    result: PushMulticastResult,
  ): Promise<void> {
    const messaging = this.getMessaging();
    const BATCH = 500; // FCM's documented maximum per multicast request.

    for (let index = 0; index < tokens.length; index += BATCH) {
      const slice = tokens.slice(index, index + BATCH);

      try {
        const response = await messaging.sendEachForMulticast({
          tokens: slice,
          ...this.buildFcmPayload(notification),
        });

        response.responses.forEach((individual, position) => {
          const token = slice[position];
          const platform = byToken.get(token)?.platform ?? 'unknown';
          if (individual.success) {
            this.record(result, {
              token,
              platform,
              ok: true,
              reference: individual.messageId,
            });
          } else {
            const code = individual.error?.code;
            this.record(result, {
              token,
              platform,
              ok: false,
              error: individual.error?.message ?? 'FCM rejected the message',
              dead: !!code && FCM_DEAD_TOKEN_CODES.has(code),
            });
          }
        });
      } catch (error: any) {
        // A whole-batch failure (bad credentials, network) — every token in
        // the slice failed, and none of them is dead.
        for (const token of slice) {
          this.record(result, {
            token,
            platform: byToken.get(token)?.platform ?? 'unknown',
            ok: false,
            error: `FCM batch failed: ${error.message}`,
          });
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELIVERY
  // ══════════════════════════════════════════════════════════════════════════

  private async deliver(
    token: string,
    platform: PushPlatform,
    keys: { p256dh: string; auth: string } | null,
    notification: Notification,
  ): Promise<PushSendOutcome> {
    if (platform === 'web') {
      return this.sendViaWebPush(token, keys, notification);
    }
    return this.sendViaFcm(token, platform, notification);
  }

  /**
   * Firebase Cloud Messaging — Android, iOS (relayed to APNs by Firebase) and
   * any other FCM-registered client.
   */
  private async sendViaFcm(
    token: string,
    platform: PushPlatform,
    notification: Notification,
  ): Promise<PushSendOutcome> {
    try {
      const messageId = await this.getMessaging().send({
        token,
        ...this.buildFcmPayload(notification),
      });
      return { token, platform, ok: true, reference: messageId };
    } catch (error: any) {
      const code: string | undefined = error?.code;
      return {
        token,
        platform,
        ok: false,
        error: `FCM send failed${code ? ` (${code})` : ''}: ${error.message}`,
        dead: !!code && FCM_DEAD_TOKEN_CODES.has(code),
      };
    }
  }

  /**
   * Web Push (VAPID) — browsers.
   *
   * The payload is JSON the service worker reads in its `push` handler; Web
   * Push has no server-side notion of title/body, so the whole notification is
   * serialised and the worker decides how to render it.
   */
  private async sendViaWebPush(
    endpoint: string,
    keys: { p256dh: string; auth: string } | null,
    notification: Notification,
  ): Promise<PushSendOutcome> {
    if (!keys?.p256dh || !keys?.auth) {
      return {
        token: endpoint,
        platform: 'web',
        ok: false,
        error:
          'Web Push needs the subscription keys (p256dh, auth). Register the ' +
          'browser subscription through POST /notifications/push-subscriptions ' +
          'so they are stored.',
      };
    }

    this.ensureVapid();

    try {
      const response = await webpush.sendNotification(
        { endpoint, keys },
        JSON.stringify({
          notificationId: notification.id,
          title: notification.title,
          body: notification.message,
          type: notification.type,
          priority: notification.priority,
          action: notification.action ?? null,
          metadata: notification.metadata ?? null,
        }),
        {
          TTL: this.ttlSeconds,
          urgency: notification.priority === 'urgent' ? 'high' : 'normal',
        },
      );

      return {
        token: endpoint,
        platform: 'web',
        ok: true,
        reference: String(response.statusCode),
      };
    } catch (error: any) {
      const statusCode: number | undefined = error?.statusCode;
      return {
        token: endpoint,
        platform: 'web',
        ok: false,
        error: `Web Push failed${
          statusCode ? ` (HTTP ${statusCode})` : ''
        }: ${error.message}`,
        dead: !!statusCode && WEB_PUSH_DEAD_STATUSES.has(statusCode),
      };
    }
  }

  /** The common FCM message body, shared by single and multicast sends. */
  private buildFcmPayload(notification: Notification) {
    return {
      notification: {
        title: notification.title,
        body: notification.message,
      },
      // FCM data values must all be strings — a number or an object here is
      // rejected with messaging/invalid-argument at send time.
      data: {
        notificationId: String(notification.id ?? ''),
        type: String(notification.type ?? ''),
        priority: String(notification.priority ?? ''),
        ...(notification.action?.url ? { actionUrl: notification.action.url } : {}),
        ...(notification.action?.label
          ? { actionLabel: notification.action.label }
          : {}),
        ...(notification.metadata
          ? { metadata: JSON.stringify(notification.metadata) }
          : {}),
      },
      android: {
        priority: this.getAndroidPriority(notification.priority),
        ttl: this.ttlSeconds * 1000,
        notification: {
          sound: 'default',
          channelId: this.getChannelId(notification.type),
        },
      } as AndroidConfig,
      // Attached for iOS. firebase-admin forwards this to APNs, which is the
      // only APNs path this repo has.
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            contentAvailable: true,
          },
        },
      } as ApnsConfig,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TOPICS
  // ══════════════════════════════════════════════════════════════════════════

  /** FCM topic subscription. Web Push has no topics — those tokens are refused. */
  async subscribeToTopic(deviceToken: string, topic: string): Promise<void> {
    this.assertEnabled();
    if (this.looksLikeWebPushEndpoint(deviceToken)) {
      throw new Error(
        'FCM topics do not apply to a Web Push subscription — fan out to the ' +
          'browser endpoints instead.',
      );
    }
    const response = await this.getMessaging().subscribeToTopic(
      [deviceToken],
      topic,
    );
    if (response.failureCount > 0) {
      throw new Error(
        `FCM refused the topic subscription: ${
          response.errors[0]?.error?.message ?? 'unknown error'
        }`,
      );
    }
    this.logger.log(`Device subscribed to FCM topic '${topic}'`);
  }

  async unsubscribeFromTopic(
    deviceToken: string,
    topic: string,
  ): Promise<void> {
    this.assertEnabled();
    if (this.looksLikeWebPushEndpoint(deviceToken)) {
      throw new Error(
        'FCM topics do not apply to a Web Push subscription.',
      );
    }
    const response = await this.getMessaging().unsubscribeFromTopic(
      [deviceToken],
      topic,
    );
    if (response.failureCount > 0) {
      throw new Error(
        `FCM refused the topic unsubscription: ${
          response.errors[0]?.error?.message ?? 'unknown error'
        }`,
      );
    }
    this.logger.log(`Device unsubscribed from FCM topic '${topic}'`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAZY PROVIDER INITIALISATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The Firebase app, initialised once.
   *
   * Given its own name rather than using the default app, so this does not
   * collide with another firebase-admin consumer added later, and so the
   * initialisation is idempotent across hot reloads: `getApps()` is consulted
   * first and an existing app of that name is reused.
   */
  private getFirebaseApp(): App {
    if (this.firebaseApp) return this.firebaseApp;
    if (this.firebaseApp === null) {
      throw new Error(this.firebaseMissingMessage());
    }

    const projectId = envString(
      this.configService.get<string>('FIREBASE_PROJECT_ID'),
    );
    const clientEmail = envString(
      this.configService.get<string>('FIREBASE_CLIENT_EMAIL'),
    );
    // The private key arrives from env with literal \n sequences — PEM parsing
    // fails without this replacement, with an error that names neither the
    // variable nor the cause.
    const privateKey = this.configService
      .get<string>('FIREBASE_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.firebaseApp = null;
      throw new Error(this.firebaseMissingMessage());
    }

    const appName = 'smartlife-push';
    const existing = getApps().find((app) => app?.name === appName);

    this.firebaseApp = existing
      ? getApp(appName)
      : initializeApp(
          {
            credential: cert({ projectId, clientEmail, privateKey }),
          },
          appName,
        );

    this.logger.log(
      `Firebase Admin initialised for project '${projectId}' (push)`,
    );
    return this.firebaseApp;
  }

  private getMessaging(): Messaging {
    return getMessaging(this.getFirebaseApp());
  }

  private firebaseMissingMessage(): string {
    const missing = [
      envString(this.configService.get<string>('FIREBASE_PROJECT_ID'))
        ? null
        : 'FIREBASE_PROJECT_ID',
      envString(this.configService.get<string>('FIREBASE_CLIENT_EMAIL'))
        ? null
        : 'FIREBASE_CLIENT_EMAIL',
      envString(this.configService.get<string>('FIREBASE_PRIVATE_KEY'))
        ? null
        : 'FIREBASE_PRIVATE_KEY',
    ].filter(Boolean);
    return (
      'Firebase Cloud Messaging is not configured — missing ' +
      `${missing.join(', ')}. Push to mobile devices is unavailable.`
    );
  }

  /** VAPID details, applied once to the module-level web-push client. */
  private ensureVapid(): void {
    if (this.vapidReady) return;

    const publicKey = envString(
      this.configService.get<string>('VAPID_PUBLIC_KEY'),
    );
    const privateKey = envString(
      this.configService.get<string>('VAPID_PRIVATE_KEY'),
    );
    const subject = envString(
      this.configService.get<string>('VAPID_SUBJECT'),
    );

    const missing = [
      publicKey ? null : 'VAPID_PUBLIC_KEY',
      privateKey ? null : 'VAPID_PRIVATE_KEY',
      // A mailto: or https: subject is mandatory per RFC 8292; browsers reject
      // a JWT without it.
      subject ? null : 'VAPID_SUBJECT (mailto:… or https://…)',
    ].filter(Boolean);

    if (missing.length > 0) {
      throw new Error(
        `Web Push is not configured — missing ${missing.join(', ')}. ` +
          'Generate a key pair with `npx web-push generate-vapid-keys`.',
      );
    }

    webpush.setVapidDetails(subject!, publicKey!, privateKey!);
    this.vapidReady = true;
  }

  private assertEnabled(): void {
    if (!this.isEnabled) {
      // No development short-circuit. The old code returned successfully when
      // NODE_ENV=development, which marked the notification delivered.
      throw new Error(
        'Push channel is disabled (PUSH_ENABLED is not true), so nothing was sent.',
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private record(result: PushMulticastResult, outcome: PushSendOutcome): void {
    result.outcomes.push(outcome);
    if (outcome.ok) result.success += 1;
    else {
      result.failure += 1;
      if (outcome.dead) result.deadTokens.push(outcome.token);
    }
  }

  private async disableToken(token: string, reason: string): Promise<void> {
    await this.disableTokens([token], reason);
  }

  private async disableTokens(
    tokens: string[],
    reason = 'Provider reported the token as unregistered',
  ): Promise<void> {
    if (tokens.length === 0) return;
    try {
      await this.subscriptionRepository
        .createQueryBuilder()
        .update(PushSubscription)
        .set({ enabled: false, lastError: reason, lastErrorAt: new Date() })
        .where('token IN (:...tokens)', { tokens })
        .execute();
      this.logger.warn(
        `${tokens.length} push subscription(s) disabled — ${reason}`,
      );
    } catch (error: any) {
      // Pruning is housekeeping; failing it must not turn a delivered push
      // into a failed one.
      this.logger.error(
        `Failed to disable ${tokens.length} dead push token(s): ${error.message}`,
      );
    }
  }

  /**
   * A Web Push subscription's identity is its endpoint, which is always an
   * https URL at the browser vendor (fcm.googleapis.com/fcm/send/…,
   * updates.push.services.mozilla.com/…, …). An FCM registration token never
   * is, so the shape is a reliable discriminator for a token with no row.
   */
  private looksLikeWebPushEndpoint(token: string): boolean {
    return /^https?:\/\//i.test(token);
  }

  private getAndroidPriority(priority: string): 'high' | 'normal' {
    return priority === 'urgent' || priority === 'high' ? 'high' : 'normal';
  }

  private getChannelId(type: string): string {
    const channels: Record<string, string> = {
      alarm: 'alarms',
      device: 'devices',
      system: 'system',
      user: 'user',
      report: 'reports',
    };
    return channels[type] || 'default';
  }

  /** Basic validation — FCM tokens and Web Push endpoints are both long. */
  isValidDeviceToken(token: string): boolean {
    return !!token && token.length > 20;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * What is actually available. Two transports, reported separately, because
   * "configured" was previously a single boolean about FCM only — so a
   * deployment with working Web Push and no Firebase reported itself
   * unconfigured, and one with Firebase reported itself able to reach browsers.
   */
  getStatus(): {
    enabled: boolean;
    providers: string[];
    fcmConfigured: boolean;
    webPushConfigured: boolean;
    apnsDirect: false;
    apnsNote: string;
    configured: boolean;
  } {
    const fcmConfigured =
      !!envString(this.configService.get<string>('FIREBASE_PROJECT_ID')) &&
      !!envString(this.configService.get<string>('FIREBASE_CLIENT_EMAIL')) &&
      !!envString(this.configService.get<string>('FIREBASE_PRIVATE_KEY'));

    const webPushConfigured =
      !!envString(this.configService.get<string>('VAPID_PUBLIC_KEY')) &&
      !!envString(this.configService.get<string>('VAPID_PRIVATE_KEY')) &&
      !!envString(this.configService.get<string>('VAPID_SUBJECT'));

    return {
      enabled: this.isEnabled,
      providers: [
        ...(fcmConfigured ? ['fcm'] : []),
        ...(webPushConfigured ? ['web-push'] : []),
      ],
      fcmConfigured,
      webPushConfigured,
      apnsDirect: false,
      apnsNote:
        'No direct APNs transport: the `apn` package is not installed. iOS ' +
        'devices are delivered through FCM, which relays to APNs server-side.',
      configured: fcmConfigured || webPushConfigured,
    };
  }
}
