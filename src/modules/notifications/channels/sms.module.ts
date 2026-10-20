import { Module } from '@nestjs/common';
import { SmsChannel } from './sms.channel';

/**
 * SmsChannel on its own, so anything that has an SMS to send can import it
 * without importing NotificationsModule.
 *
 * TwoFactorAuthModule is the reason this exists: it needs to deliver an OTP
 * (it used to `logger.warn()` the code instead), and NotificationsModule
 * imports UsersModule, which would drag a dependency cycle through the auth
 * stack for the sake of one provider that only needs ConfigService.
 */
@Module({
  providers: [SmsChannel],
  exports: [SmsChannel],
})
export class SmsModule {}
