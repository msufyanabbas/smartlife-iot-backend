import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

export interface GoogleProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
  emailVerified: boolean;
  accessToken?: string; // ✅ Add for storing
  refreshToken?: string; // ✅ Add for storing
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID')!,
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL')!,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
  ): Promise<GoogleProfile> {
    const { id, emails, displayName, photos } = profile;

    if (!emails || emails.length === 0) {
      throw new Error('No email provided by Google');
    }

    const user: GoogleProfile = {
      id,
      email: emails[0].value,
      name: displayName || 'Google User',
      picture: photos && photos.length > 0 ? photos[0].value : undefined,
      emailVerified: emails[0].verified || false,
      accessToken,
      refreshToken,
    };

    return user;
  }
}
