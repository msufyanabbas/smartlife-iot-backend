import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-github2';
import { ConfigService } from '@nestjs/config';

export interface GitHubProfile {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  username: string;
  accessToken?: string;
  refreshToken?: string;
}

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GITHUB_CLIENT_ID')!,
      clientSecret: configService.get<string>('GITHUB_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GITHUB_CALLBACK_URL')!,
      scope: ['user:email'],
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
  ): Promise<GitHubProfile> {
    const { id, emails, displayName, photos, username } = profile;

    const email =
      emails && emails.length > 0
        ? emails[0].value
        : `${username}@github-user.com`;

    const name = displayName || username || 'GitHub User';

    const user: GitHubProfile = {
      id: String(id),
      email,
      name,
      avatar: photos && photos.length > 0 ? photos[0].value : undefined,
      username: username || String(id),
      accessToken,
      refreshToken,
    };

    return user;
  }
}
