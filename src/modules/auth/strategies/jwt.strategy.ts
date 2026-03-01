// src/modules/auth/strategies/jwt.strategy.ts
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '@modules/users/entities/user.entity';
import { TokenBlacklist } from '../entities/token-blacklist.entity';
import { SessionService } from '../session/session.service';

export interface JwtPayload {
  sub: string;             // user id
  email: string;
  role: string;
  tenantId: string | undefined; // null matches User entity (nullable column, TypeORM returns null)
  customerId: string | undefined;
  sessionId: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(TokenBlacklist)
    private readonly tokenBlacklistRepository: Repository<TokenBlacklist>,
    private readonly sessionService: SessionService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is not set');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true, // Gives access to request object for token extraction
    });
  }

  async validate(request: any, payload: JwtPayload): Promise<User> {
    const { sub: userId, sessionId } = payload;

    // Extract token from Authorization header
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(request);

    // ── Check if token is blacklisted ─────────────────────────────────────
    if (token) {
      const isBlacklisted = await this.tokenBlacklistRepository.findOne({ where: { token } });
      if (isBlacklisted) {
        throw new UnauthorizedException('Token has been revoked');
      }
    }

    // ── Validate session is still active ──────────────────────────────────
    if (sessionId) {
      const isSessionValid = await this.sessionService.isSessionValid(userId, sessionId);
      if (!isSessionValid) {
        throw new UnauthorizedException(
          'Session has expired or was terminated. You may have logged in from another device.',
        );
      }
    } else {
      // Tokens without sessionId are from before the session system was added.
      // Consider forcing re-login for better security.
      this.logger.warn(
        `Token for user ${userId} does not have sessionId — consider forcing re-login`,
      );
    }

    // ── Load user ──────────────────────────────────────────────────────────
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) throw new UnauthorizedException('User not found');
    if (!user.isActive()) throw new UnauthorizedException('User account is not active');

    return user;
  }
}