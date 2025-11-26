import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { NotificationsRepository } from './repositories/notifications.repository';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { PushChannel } from './channels/push.channel';
import { MailModule } from '../../modules/mail/mail.module';

@Module({
  imports: [TypeOrmModule.forFeature([Notification]), MailModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    EmailChannel,
    SmsChannel,
    PushChannel,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
