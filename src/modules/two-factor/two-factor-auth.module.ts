import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { TwoFactorAuthController } from './two-factor-auth.controller';
import { TwoFactorAuth } from './entities/two-factor-auth.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';
// SmsChannel, not NotificationsModule: the whole of notifications imports
// UsersModule, and 2FA only needs one provider that depends on ConfigService.
import { SmsModule } from '../notifications/channels/sms.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TwoFactorAuth, User]),
    MailModule,
    SmsModule,
  ],
  controllers: [TwoFactorAuthController],
  providers: [TwoFactorAuthService],
  exports: [TwoFactorAuthService],
})
export class TwoFactorAuthModule {}
