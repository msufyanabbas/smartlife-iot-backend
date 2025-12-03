import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { TokenBlacklist } from '../entities/token-blacklist.entity';
import { SessionService } from '../session/session.service';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: string;
  sessionId: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(TokenBlacklist)
    private tokenBlacklistRepository: Repository<TokenBlacklist>,
    private sessionService: SessionService, 
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>('JWT_SECRET') ||
        'your-super-secret-jwt-key-change-this-in-production',
      passReqToCallback: true, // This is important - allows us to access the request object
    });
  }

  async validate(request: any, payload: JwtPayload): Promise<User> {
    const { sub: id, sessionId } = payload;

    // Extract the token from the request
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request);

    console.log({ token });

    // Check if token is blacklisted
    if (token) {
      const isBlacklisted = await this.tokenBlacklistRepository.findOne({
        where: { token },
      });

      if (isBlacklisted) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

     // 🆕 CRITICAL: Validate session is still active
    if (sessionId) {
      const isSessionValid = await this.sessionService.isSessionValid(
        id,
        sessionId,
      );

      if (!isSessionValid) {
        throw new UnauthorizedException(
          'Session has expired or was terminated. You may have logged in from another device.',
        );
      }
    } else {
      // For backward compatibility - tokens without sessionId should still work
      // but consider forcing re-login for better security
      console.warn(`Token for user ${id} does not have sessionId - consider forcing re-login`);
    }

    // Find user
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    return user;
  }
}
