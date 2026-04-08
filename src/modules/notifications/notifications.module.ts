import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { NotificationsRepository } from './repositories/notifications.repository';
import { EmailChannel } from './channels/email.channel';
import { SmsChannel } from './channels/sms.channel';
import { PushChannel } from './channels/push.channel';
import { MailModule } from '../../modules/mail/mail.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),  // ← remove User, UsersModule handles it
    MailModule,
    forwardRef(() => UsersModule),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // ← UsersService removed from providers
    NotificationsRepository,
    EmailChannel,
    SmsChannel,
    PushChannel,
  ],
  exports: [NotificationsService],  // ← UsersService removed from exports
})
export class NotificationsModule {}