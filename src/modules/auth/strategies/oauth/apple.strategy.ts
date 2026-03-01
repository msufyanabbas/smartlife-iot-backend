// src/modules/auth/strategies/oauth/apple.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-apple';
import { ConfigService } from '@nestjs/config';

export interface AppleProfile {
  id: string;
  email: string;
  name?: string;
  emailVerified: boolean;
  accessToken?: string;
  refreshToken?: string;
}

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('APPLE_CLIENT_ID')!,
      teamID: configService.get<string>('APPLE_TEAM_ID')!,
      keyID: configService.get<string>('APPLE_KEY_ID')!,
      privateKeyString: configService.get<string>('APPLE_PRIVATE_KEY')!,
      callbackURL: configService.get<string>('APPLE_CALLBACK_URL')!,
      scope: ['email', 'name'],
      passReqToCallback: false,
    });
  }

  // PassportStrategy calls this method — the constructor callback was redundant
  async validate(
    accessToken: string,
    refreshToken: string,
    idToken: any,
    profile: any,
  ): Promise<AppleProfile> {
    const { sub, email, email_verified } = idToken || {};

    return {
      id: sub || profile?.id || 'unknown',
      email: email || profile?.email || `${sub}@appleid.apple.com`,
      name: profile?.name
        ? `${profile.name.firstName || ''} ${profile.name.lastName || ''}`.trim()
        : undefined,
      emailVerified: email_verified === 'true' || email_verified === true,
      accessToken,
      refreshToken,
    };
  }
}