import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { TwoFactorAuthController } from './two-factor-auth.controller';
import { TwoFactorAuth } from './entities/two-factor-auth.entity';
import { User } from '../users/entities/user.entity';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TwoFactorAuth, User]),
    MailModule,
  ],
  controllers: [TwoFactorAuthController],
  providers: [TwoFactorAuthService],
  exports: [TwoFactorAuthService],
})
export class TwoFactorAuthModule {}