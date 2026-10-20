import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { PushSubscription } from './entities/push-subscription.entity';
import { NotificationsRepository } from './repositories/notifications.repository';
import { EmailChannel } from './channels/email.channel';
import { SmsModule } from './channels/sms.module';
import { PushChannel } from './channels/push.channel';
import { WhatsappChannel } from './channels/whatsapp.channel';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { MailModule } from '../../modules/mail/mail.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    // PushSubscription joins Notification here: PushChannel reads the platform
    // and Web Push keys for a token, and the channel is a provider of THIS
    // module, so the repository has to be registered here.
    TypeOrmModule.forFeature([Notification, PushSubscription]),
    MailModule,
    // SmsChannel moved into its own module so TwoFactorAuthModule can deliver
    // an OTP without importing all of notifications (which imports users).
    SmsModule,
    forwardRef(() => UsersModule),
  ],
  controllers: [NotificationsController, PushSubscriptionsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    EmailChannel,
    PushChannel,
    PushSubscriptionsService,
    WhatsappChannel,
  ],
  exports: [NotificationsService, PushChannel, PushSubscriptionsService],
})
export class NotificationsModule {}
