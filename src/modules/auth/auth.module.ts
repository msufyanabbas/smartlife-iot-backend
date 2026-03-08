import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService, TenantsService } from '@modules/index.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { User, RefreshToken, OAuthAccount, Customer, Invitation, Subscription, Tenant, TokenBlacklist, TwoFactorAuth } from '@modules/index.entities';
import { MailModule } from '../mail/mail.module';
import { GoogleStrategy } from './strategies/oauth/google.strategy';
import { GitHubStrategy } from './strategies/oauth/github.strategy';
import { AppleStrategy } from './strategies/oauth/apple.strategy';
import { RedisService } from '@/lib/redis/redis.service';
import { SubscriptionsModule } from '../index.module';
import { SessionService } from './session/session.service';
import { TwoFactorAuthModule } from '../two-factor/two-factor-auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Subscription,
      RefreshToken,
      OAuthAccount,
      TokenBlacklist,
      Invitation,
      Tenant,
      Customer
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: (() => {
        const secret = configService.get<string>('jwt.secret');
        if (!secret) throw new Error('JWT_SECRET environment variable is required');
        return secret;
          })(),
        signOptions: {
          expiresIn: configService.get<string>('jwt.expiration', '7d') as any,
        },
      }),
    }),
    MailModule,
    TwoFactorAuthModule,
    forwardRef(() => SubscriptionsModule)
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    JwtStrategy,
    GoogleStrategy,
    GitHubStrategy,
    AppleStrategy,
    TenantsService,
    {
      provide: 'REDIS_SERVICE',
      useClass: RedisService
    }
  ],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
