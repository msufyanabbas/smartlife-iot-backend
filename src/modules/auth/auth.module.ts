import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { MailModule } from '../mail/mail.module';
import { OAuthAccount } from './entities/oauth-account.entity';
import { GoogleStrategy } from './strategies/oauth/google.strategy';
import { GitHubStrategy } from './strategies/oauth/github.strategy';
import { AppleStrategy } from './strategies/oauth/apple.strategy';
import { TokenBlacklist } from '../index.entities';
import { redisService } from '@/lib/redis/redis.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      RefreshToken,
      OAuthAccount,
      TokenBlacklist,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') ||
          'your-super-secret-jwt-key-change-this-in-production',
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION', '15m') as any, // 👈 cast
        },
      }),
    }),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtRefreshStrategy,
    LocalStrategy,
    GoogleStrategy,
    GitHubStrategy,
    AppleStrategy,
    {
      provide: 'REDIS_SERVICE',
      useValue: redisService 
    }
  ],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
