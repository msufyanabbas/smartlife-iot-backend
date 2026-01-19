// src/modules/notifications/notifications.module.ts
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
import { UsersModule } from '../users/users.module'; // ✅ Add this
import { User } from '../index.entities';
import { UsersService } from '../users/users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, User]),
    MailModule,
    UsersModule, // ✅ Add this
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    UsersService,
    NotificationsRepository,
    EmailChannel,
    SmsChannel,
    PushChannel,
  ],
  exports: [NotificationsService, UsersService],
})
export class NotificationsModule {}