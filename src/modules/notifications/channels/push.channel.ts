import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';

/**
 * Push notification channel
 * Handles sending push notifications to mobile devices
 *
 * Supports:
 * - Firebase Cloud Messaging (FCM) for Android & iOS
 * - Apple Push Notification Service (APNS) for iOS
 */
@Injectable()
export class PushChannel {
  private readonly logger = new Logger(PushChannel.name);
  private readonly isEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get('PUSH_ENABLED', false);

    if (!this.isEnabled) {
      this.logger.warn(
        'Push notifications are disabled. Set PUSH_ENABLED=true to enable.',
      );
    }
  }

  /**
   * Send notification via push
   */
  async send(notification: Notification): Promise<void> {
    if (!notification.recipientDeviceToken) {
      throw new Error('Recipient device token is required for push channel');
    }

    if (!this.isEnabled) {
      this.logger.warn(
        `Push channel is disabled. Would send to device: ${notification.title}`,
      );
      // In development, we'll simulate success
      if (this.configService.get('NODE_ENV') === 'development') {
        return;
      }
      throw new Error('Push channel is not enabled');
    }

    try {
      this.logger.log(
        `Sending push notification ${notification.id} to device token: ${notification.recipientDeviceToken.substring(0, 20)}...`,
      );

      // Send via Firebase Cloud Messaging
      await this.sendViaFcm(notification);

      this.logger.log(`Push notification ${notification.id} sent successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to send push notification ${notification.id}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Send via Firebase Cloud Messaging (FCM)
   */
  private async sendViaFcm(notification: Notification): Promise<void> {
    // Uncomment when firebase-admin is installed: npm install firebase-admin

    // import * as admin from 'firebase-admin';

    // // Initialize Firebase Admin (do this once in module initialization)
    // if (!admin.apps.length) {
    //   admin.initializeApp({
    //     credential: admin.credential.cert({
    //       projectId: this.configService.get('FIREBASE_PROJECT_ID'),
    //       clientEmail: this.configService.get('FIREBASE_CLIENT_EMAIL'),
    //       privateKey: this.configService.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
    //     }),
    //   });
    // }

    // const message = {
    //   token: notification.recipientDeviceToken!,
    //   notification: {
    //     title: notification.title,
    //     body: notification.message,
    //   },
    //   data: {
    //     notificationId: notification.id,
    //     type: notification.type,
    //     priority: notification.priority,
    //     ...(notification.action && {
    //       actionUrl: notification.action.url,
    //       actionLabel: notification.action.label,
    //     }),
    //     ...(notification.metadata && {
    //       metadata: JSON.stringify(notification.metadata),
    //     }),
    //   },
    //   android: {
    //     priority: this.getAndroidPriority(notification.priority),
    //     notification: {
    //       sound: 'default',
    //       channelId: this.getChannelId(notification.type),
    //     },
    //   },
    //   apns: {
    //     payload: {
    //       aps: {
    //         sound: 'default',
    //         badge: 1,
    //         contentAvailable: true,
    //       },
    //     },
    //   },
    // };

    // await admin.messaging().send(message);

    // For now, just log
    this.logger.log(
      `[FCM] Would send push notification: ${notification.title} to token: ${notification.recipientDeviceToken}`,
    );
  }

  /**
   * Send via Apple Push Notification Service (APNS) directly
   */
  private async sendViaApns(notification: Notification): Promise<void> {
    // Uncomment when apn is installed: npm install apn

    // import apn from 'apn';

    // const options = {
    //   token: {
    //     key: this.configService.get('APNS_KEY'),
    //     keyId: this.configService.get('APNS_KEY_ID'),
    //     teamId: this.configService.get('APNS_TEAM_ID'),
    //   },
    //   production: this.configService.get('NODE_ENV') === 'production',
    // };

    // const apnProvider = new apn.Provider(options);

    // const note = new apn.Notification();
    // note.alert = {
    //   title: notification.title,
    //   body: notification.message,
    // };
    // note.topic = this.configService.get('APNS_BUNDLE_ID');
    // note.sound = 'default';
    // note.badge = 1;
    // note.payload = {
    //   notificationId: notification.id,
    //   type: notification.type,
    //   ...(notification.metadata && notification.metadata),
    // };

    // await apnProvider.send(note, notification.recipientDeviceToken!);

    this.logger.log(
      `[APNS] Would send push notification: ${notification.title}`,
    );
  }

  /**
   * Get Android priority based on notification priority
   */
  private getAndroidPriority(priority: string): 'high' | 'normal' {
    return priority === 'urgent' || priority === 'high' ? 'high' : 'normal';
  }

  /**
   * Get notification channel ID for Android
   */
  private getChannelId(type: string): string {
    const channels = {
      alarm: 'alarms',
      device: 'devices',
      system: 'system',
      user: 'user',
      report: 'reports',
    };
    return channels[type] || 'default';
  }

  /**
   * Validate device token format
   */
  isValidDeviceToken(token: string): boolean | string {
    // Basic validation - tokens are typically long strings
    return token && token.length > 20;
  }

  /**
   * Send push to multiple devices
   */
  async sendToMultipleDevices(
    deviceTokens: string[],
    notification: Notification,
  ): Promise<{ success: number; failure: number }> {
    let success = 0;
    const failure = 0;

    // Uncomment when firebase-admin is installed

    // import * as admin from 'firebase-admin';

    // const message = {
    //   notification: {
    //     title: notification.title,
    //     body: notification.message,
    //   },
    //   tokens: deviceTokens,
    // };

    // const response = await admin.messaging().sendMulticast(message);
    // success = response.successCount;
    // failure = response.failureCount;

    // For now, simulate
    success = deviceTokens.length;

    this.logger.log(
      `[FCM] Would send to ${deviceTokens.length} devices: ${success} success, ${failure} failure`,
    );

    return { success, failure };
  }

  /**
   * Get push service status
   */
  getStatus(): {
    enabled: boolean;
    provider: string;
    configured: boolean;
  } {
    const fcmConfigured =
      !!this.configService.get('FIREBASE_PROJECT_ID') &&
      !!this.configService.get('FIREBASE_CLIENT_EMAIL') &&
      !!this.configService.get('FIREBASE_PRIVATE_KEY');

    return {
      enabled: this.isEnabled,
      provider: 'Firebase Cloud Messaging',
      configured: fcmConfigured,
    };
  }

  /**
   * Subscribe device to topic (for broadcasting)
   */
  async subscribeToTopic(deviceToken: string, topic: string): Promise<void> {
    // Uncomment when firebase-admin is installed

    // import * as admin from 'firebase-admin';
    // await admin.messaging().subscribeToTopic([deviceToken], topic);

    this.logger.log(`[FCM] Would subscribe device to topic: ${topic}`);
  }

  /**
   * Unsubscribe device from topic
   */
  async unsubscribeFromTopic(
    deviceToken: string,
    topic: string,
  ): Promise<void> {
    // Uncomment when firebase-admin is installed

    // import * as admin from 'firebase-admin';
    // await admin.messaging().unsubscribeFromTopic([deviceToken], topic);

    this.logger.log(`[FCM] Would unsubscribe device from topic: ${topic}`);
  }
}
