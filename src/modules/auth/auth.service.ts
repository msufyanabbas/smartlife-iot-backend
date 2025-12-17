import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  OAuthAccount,
  OAuthProviderEnum,
} from './entities/oauth-account.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { TwoFactorChallengeDto } from '../two-factor/dto/two-factor-challenge.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { MailService } from '../mail/mail.service';
import { GoogleProfile } from './strategies/oauth/google.strategy';
import { GitHubProfile } from './strategies/oauth/github.strategy';
import { AppleProfile } from './strategies/oauth/apple.strategy';
import { TokenBlacklist } from './entities/token-blacklist.entity';
import { Cron } from '@nestjs/schedule';
import { SubscriptionPlan } from '../subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SessionService } from './session/session.service';
import { TwoFactorAuthService } from '../two-factor/two-factor-auth.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(OAuthAccount)
    private oauthAccountRepository: Repository<OAuthAccount>,
    @InjectRepository(TokenBlacklist)
    private tokenBlacklistRepository: Repository<TokenBlacklist>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
    private sessionService: SessionService,
    private twoFactorAuthService: TwoFactorAuthService,
  ) {}

  /**
   * Register a new user
   */
  async register(
    registerDto: RegisterDto,
  ): Promise<{ message: string; email: string }> {
    const { email, password, name, phone } = registerDto;

    const existingUser = await this.userRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    if (phone) {
      const existingUserByPhone = await this.userRepository.findOne({
        where: { phone },
      });

      if (existingUserByPhone) {
        throw new ConflictException(
          'User with this phone number already exists',
        );
      }
    }

    const verificationToken = this.generateVerificationToken();

    const user = this.userRepository.create({
      email,
      password,
      name,
      phone,
      emailVerified: false,
      emailVerificationToken: verificationToken,
    });

    await this.userRepository.save(user);

    try {
      await this.subscriptionsService.create(user.id, {
        plan: SubscriptionPlan.FREE,
      });
      this.logger.log(`FREE subscription created for user: ${email}`);
    } catch (error) {
      this.logger.error(`Failed to create subscription for ${email}:`, error);
    }

    this.logger.log(`New user registered: ${email}`);

    try {
      await this.mailService.sendVerificationEmail(
        email,
        name,
        verificationToken,
      );
      this.logger.log(`Verification email sent to: ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${email}:`,
        error,
      );
    }

    return {
      message:
        'Registration successful. Please check your email to verify your account.',
      email,
    };
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { emailVerificationToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (user.emailVerified) {
      throw new BadRequestException('Email already verified');
    }

    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    await this.userRepository.save(user);

    this.logger.log(`Email verified for user: ${user.email}`);

    try {
      await this.mailService.sendWelcomeEmail(user.email, user.name);
      this.logger.log(`Welcome email sent to: ${user.email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send welcome email to ${user.email}:`,
        error,
      );
    }

    return {
      message: 'Email verified successfully. You can now log in.',
    };
  }

  /**
   * Resend verification email
   */
  async resendVerificationEmail(email: string): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.emailVerified) {
      throw new BadRequestException('Email already verified');
    }

    const verificationToken = this.generateVerificationToken();
    user.emailVerificationToken = verificationToken;
    await this.userRepository.save(user);

    try {
      await this.mailService.sendVerificationEmail(
        email,
        user.name,
        verificationToken,
      );
      this.logger.log(`Verification email resent to: ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to resend verification email to ${email}:`,
        error,
      );
      throw new BadRequestException('Failed to send verification email');
    }

    return {
      message: 'Verification email sent. Please check your inbox.',
    };
  }

  /**
   * Login user (LOCAL AUTH)
   * ✅ Includes session management and 2FA
   */
  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    const { email, password, twoFactorCode } = loginDto;

    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.emailVerified) {
      throw new UnauthorizedException(
        'Please verify your email before logging in. Check your inbox for the verification link.',
      );
    }

    // ✅ Check if 2FA is enabled
    const has2FA = await this.twoFactorAuthService.isEnabled(user.id);

    if (has2FA) {
      if (!twoFactorCode) {
        const twoFASettings =
          await this.twoFactorAuthService.getSettings(user.id);

        // Send code automatically for SMS/Email
        if (twoFASettings.method === 'sms') {
          await this.twoFactorAuthService.sendSMSCode(user.id);
        } else if (twoFASettings.method === 'email') {
          await this.twoFactorAuthService.sendEmailCode(user.id);
        }

        // Return 2FA challenge
        return {
          requires2FA: true,
          userId: user.id,
          method: twoFASettings.method || 'authenticator',
        };
      }

      // Verify 2FA code
      const isValid = await this.twoFactorAuthService.verifyCode(
        user.id,
        twoFactorCode,
      );

      if (!isValid) {
        throw new UnauthorizedException('Invalid 2FA code');
      }
    }

    user.updateLastLogin();
    await this.userRepository.save(user);

    this.logger.log(`User logged in: ${email}`);

    return this.generateAuthResponse(user, ipAddress, userAgent, 'local');
  }

  /**
   * Validate user credentials
   */
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user) {
      return null;
    }

    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  /**
   * OAuth Login - Google
   * ✅ Includes session management and 2FA
   */
  async googleLogin(
    profile: GoogleProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    return this.handleOAuthLogin(
      OAuthProviderEnum.GOOGLE,
      profile.id,
      profile.email,
      profile.name,
      profile.emailVerified,
      profile.picture,
      profile,
      profile.accessToken,
      profile.refreshToken,
      ipAddress,
      userAgent,
    );
  }

  /**
   * OAuth Login - GitHub
   * ✅ Includes session management and 2FA
   */
  async githubLogin(
    profile: GitHubProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    return this.handleOAuthLogin(
      OAuthProviderEnum.GITHUB,
      profile.id,
      profile.email,
      profile.name,
      true,
      profile.avatar,
      profile,
      profile.accessToken,
      profile.refreshToken,
      ipAddress,
      userAgent,
    );
  }

  /**
   * OAuth Login - Apple
   * ✅ Includes session management and 2FA
   */
  async appleLogin(
    profile: AppleProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    return this.handleOAuthLogin(
      OAuthProviderEnum.APPLE,
      profile.id,
      profile.email,
      profile.name || 'Apple User',
      profile.emailVerified,
      undefined,
      profile,
      profile.accessToken,
      profile.refreshToken,
      ipAddress,
      userAgent,
    );
  }

  /**
   * Handle OAuth login/registration
   * ✅ Includes 2FA check for OAuth users
   */
  private async handleOAuthLogin(
    provider: OAuthProviderEnum,
    providerId: string,
    email: string,
    name: string,
    emailVerified: boolean,
    avatar?: string,
    profile?: any,
    accessToken?: string,
    refreshToken?: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    let oauthAccount = await this.oauthAccountRepository.findOne({
      where: { provider, providerId },
      relations: ['user'],
    });

    let user: User | null = null;

    if (oauthAccount) {
      user = oauthAccount.user;

      oauthAccount.providerEmail = email;
      oauthAccount.profile = profile;
      oauthAccount.accessToken = accessToken;
      oauthAccount.refreshToken = refreshToken;
      oauthAccount.tokenExpiresAt = accessToken
        ? new Date(Date.now() + 3600 * 1000)
        : undefined;
      await this.oauthAccountRepository.save(oauthAccount);
    } else {
      user = await this.userRepository.findOne({
        where: { email },
      });

      if (user) {
        oauthAccount = this.oauthAccountRepository.create({
          userId: user.id,
          provider,
          providerId,
          providerEmail: email,
          profile,
          accessToken,
          refreshToken,
          tokenExpiresAt: accessToken
            ? new Date(Date.now() + 3600 * 1000)
            : undefined,
        });
        await this.oauthAccountRepository.save(oauthAccount);

        this.logger.log(
          `OAuth account linked to existing user: ${email} (${provider})`,
        );
      } else {
        user = this.userRepository.create({
          email,
          name,
          emailVerified,
          avatar,
          password: this.generateRandomPassword(),
        });
        await this.userRepository.save(user);

        try {
  await this.subscriptionsService.getOrCreateFreeSubscription(user.id);
  this.logger.log(`FREE subscription ensured for OAuth user: ${email}`);
} catch (error) {
  this.logger.error(
    `Failed to ensure subscription for OAuth user ${email}:`,
    error,
  );
}

        oauthAccount = this.oauthAccountRepository.create({
          userId: user.id,
          provider,
          providerId,
          providerEmail: email,
          profile,
          accessToken,
          refreshToken,
          tokenExpiresAt: accessToken
            ? new Date(Date.now() + 3600 * 1000)
            : undefined,
        });
        await this.oauthAccountRepository.save(oauthAccount);

        this.logger.log(`New user created via OAuth: ${email} (${provider})`);

        try {
          await this.mailService.sendWelcomeEmail(email, name);
        } catch (error) {
          this.logger.error(`Failed to send welcome email to ${email}:`, error);
        }
      }
    }

    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    // ✅ Check if 2FA is enabled for OAuth users
    const has2FA = await this.twoFactorAuthService.isEnabled(user.id);

    if (has2FA) {
      const twoFASettings = await this.twoFactorAuthService.getSettings(user.id);

      // Send code automatically for SMS/Email
      if (twoFASettings.method === 'sms') {
        await this.twoFactorAuthService.sendSMSCode(user.id);
      } else if (twoFASettings.method === 'email') {
        await this.twoFactorAuthService.sendEmailCode(user.id);
      }

      // Return 2FA challenge for OAuth flow
      return {
        requires2FA: true,
        userId: user.id,
        method: twoFASettings.method || 'authenticator',
      };
    }

    user.updateLastLogin();
    await this.userRepository.save(user);

    this.logger.log(`User logged in via OAuth: ${email} (${provider})`);

    return this.generateAuthResponse(
      user,
      ipAddress,
      userAgent,
      provider.toLowerCase() as any,
    );
  }

  /**
   * ✅ NEW: Verify OAuth 2FA and complete login
   */
  async verifyOAuth2FA(
    userId: string,
    twoFactorCode: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    // Verify 2FA code
    const isValid = await this.twoFactorAuthService.verifyCode(
      userId,
      twoFactorCode,
    );

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    user.updateLastLogin();
    await this.userRepository.save(user);

    this.logger.log(`OAuth 2FA verified for user: ${user.email}`);

    // Pass undefined since we don't track which OAuth provider initiated 2FA
    return this.generateAuthResponse(user, ipAddress, userAgent, undefined);
  }

  /**
   * Link OAuth account to existing user
   */
  async linkOAuthAccount(
    userId: string,
    provider: OAuthProviderEnum,
    providerId: string,
    email: string,
    profile?: any,
  ): Promise<{ message: string }> {
    const existingOAuth = await this.oauthAccountRepository.findOne({
      where: { provider, providerId },
    });

    if (existingOAuth) {
      if (existingOAuth.userId === userId) {
        throw new BadRequestException(
          'This OAuth account is already linked to your account',
        );
      }
      throw new ConflictException(
        'This OAuth account is linked to another user',
      );
    }

    const oauthAccount = this.oauthAccountRepository.create({
      userId,
      provider,
      providerId,
      providerEmail: email,
      profile,
    });

    await this.oauthAccountRepository.save(oauthAccount);

    this.logger.log(`OAuth account linked: ${userId} (${provider})`);

    return {
      message: `Successfully linked ${provider} account`,
    };
  }

  /**
   * Unlink OAuth account
   */
  async unlinkOAuthAccount(
    userId: string,
    provider: OAuthProviderEnum,
  ): Promise<{ message: string }> {
    const oauthAccount = await this.oauthAccountRepository.findOne({
      where: { userId, provider },
    });

    if (!oauthAccount) {
      throw new NotFoundException(`No ${provider} account linked`);
    }

    const user: any = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user.password || user.password.startsWith('oauth_')) {
      const otherOAuthAccounts = await this.oauthAccountRepository.count({
        where: { userId },
      });

      if (otherOAuthAccounts <= 1) {
        throw new BadRequestException(
          'Cannot unlink OAuth account. Please set a password first or link another OAuth provider.',
        );
      }
    }

    await this.oauthAccountRepository.remove(oauthAccount);

    this.logger.log(`OAuth account unlinked: ${userId} (${provider})`);

    return {
      message: `Successfully unlinked ${provider} account`,
    };
  }

  /**
   * Get user's linked OAuth accounts
   */
  async getLinkedOAuthAccounts(userId: string): Promise<OAuthAccount[]> {
    return this.oauthAccountRepository.find({
      where: { userId },
      select: ['id', 'provider', 'providerEmail', 'createdAt'],
    });
  }

  /**
   * Refresh access token
   * ✅ Validates session BEFORE allowing refresh
   */
  async refreshTokens(
    refreshTokenString: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenString },
      relations: ['user'],
    });

    if (!refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!refreshToken.isValid()) {
      throw new UnauthorizedException('Refresh token expired or revoked');
    }

    const user = refreshToken.user;

    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    const existingSession = await this.sessionService.getSession(user.id);

    if (!existingSession) {
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      this.logger.warn(
        `Refresh token rejected for user ${user.email}: No active session`,
      );

      throw new UnauthorizedException(
        'Session has expired or was terminated. Please log in again.',
      );
    }

    const isTokenValidForSession =
      await this.sessionService.isRefreshTokenValidForSession(
        user.id,
        refreshTokenString,
      );

    if (!isTokenValidForSession) {
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      this.logger.warn(
        `Refresh token rejected for user ${user.email}: Token from old session`,
      );

      throw new UnauthorizedException(
        'This session is no longer valid. You may have logged in from another device. Please log in again.',
      );
    }

    refreshToken.isRevoked = true;
    await this.refreshTokenRepository.save(refreshToken);

    await this.sessionService.extendSession(user.id);

    this.logger.log(`Tokens refreshed for user: ${user.email}`);

    const sessionId = existingSession.sessionId;

    return this.generateAuthResponseWithSessionId(
      user,
      sessionId,
      ipAddress,
      userAgent,
    );
  }

  /**
   * Logout user
   * ✅ Deletes session
   */
  async logout(refreshTokenString: string, accessToken: string): Promise<void> {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenString },
    });

    if (refreshToken) {
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      if (accessToken) {
        await this.blacklistToken(accessToken, refreshToken.userId);
      }

      await this.sessionService.deleteSession(refreshToken.userId);

      this.logger.log(`User logged out, token revoked, session deleted`);
    }
  }

  /**
   * Logout from all devices
   * ✅ Deletes session
   */
  async logoutAll(userId: string, accessToken: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    if (accessToken) {
      await this.blacklistToken(accessToken, userId);
    }

    await this.sessionService.deleteSession(userId);

    this.logger.log(`User logged out from all devices: ${userId}`);
  }

  /**
   * Blacklist an access token
   */
  async blacklistToken(token: string, userId: string): Promise<void> {
    try {
      const decoded = this.jwtService.decode(token);
      const expiresAt = new Date(decoded.exp * 1000);

      await this.tokenBlacklistRepository.save({
        token,
        userId,
        expiresAt,
      });

      this.logger.log(`Access token blacklisted for user: ${userId}`);
    } catch (error) {
      this.logger.error('Failed to blacklist token:', error);
    }
  }

  /**
   * Check if token is blacklisted
   */
  async isTokenBlacklisted(token: string): Promise<boolean> {
    const blacklisted = await this.tokenBlacklistRepository.findOne({
      where: { token },
    });

    return !!blacklisted;
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const user = await this.userRepository.findOne({
      where: { email },
    });

    if (!user) {
      return {
        message: 'If the email exists, a password reset link has been sent.',
      };
    }

    if (!user.emailVerified) {
      throw new BadRequestException(
        'Please verify your email first. Check your inbox for the verification link.',
      );
    }

    const resetToken = this.generateVerificationToken();
    const resetExpiry = new Date();
    resetExpiry.setHours(resetExpiry.getHours() + 1);

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = resetExpiry;
    await this.userRepository.save(user);

    try {
      await this.mailService.sendPasswordResetEmail(
        email,
        user.name,
        resetToken,
      );
      this.logger.log(`Password reset email sent to: ${email}`);
    } catch (error) {
      this.logger.error(
        `Failed to send password reset email to ${email}:`,
        error,
      );
    }

    return {
      message: 'If the email exists, a password reset link has been sent.',
    };
  }

  /**
   * Reset password with token
   */
  async resetPassword(
  token: string,
  newPassword: string,
): Promise<{ message: string }> {
  const user = await this.userRepository.findOne({
    where: { passwordResetToken: token },
  });

  if (!user || !user.passwordResetExpires) {
    throw new BadRequestException('Invalid or expired reset token');
  }

  if (new Date() > user.passwordResetExpires) {
    throw new BadRequestException('Reset token has expired');
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await this.userRepository.save(user);

  // ✅ FIX: Manually revoke tokens instead of using logoutAll()
  await this.refreshTokenRepository.update(
    { userId: user.id, isRevoked: false },
    { isRevoked: true },
  );

  await this.sessionService.deleteSession(user.id);

  this.logger.log(`Password reset for user: ${user.email}`);

  return {
    message:
      'Password reset successfully. You can now log in with your new password.',
  };
}

  /**
   * Change password
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isPasswordValid = await user.comparePassword(oldPassword);

    if (!isPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    user.password = newPassword;
    await this.userRepository.save(user);

    await this.logoutAll(userId, '');

    this.logger.log(`Password changed for user: ${user.email}`);
  }

  /**
   * Generate authentication response with NEW session
   */
  private async generateAuthResponse(
    user: User,
    ipAddress?: string,
    userAgent?: string,
    loginMethod?: 'local' | 'google' | 'github' | 'apple',
  ): Promise<AuthResponseDto> {
    const sessionId = uuidv4();

    await this.sessionService.createSession(user.id, sessionId, {
      ipAddress,
      userAgent,
      loginMethod,
    });

    return this.generateAuthResponseWithSessionId(
      user,
      sessionId,
      ipAddress,
      userAgent,
    );
  }

  /**
   * Generate authentication response with SPECIFIC session ID
   */
  private async generateAuthResponseWithSessionId(
    user: User,
    sessionId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sessionId,
    };

    const accessToken = this.jwtService.sign(payload);

    const refreshTokenString = this.generateRefreshToken();
    const refreshTokenExpiry = new Date();
    refreshTokenExpiry.setDate(
      refreshTokenExpiry.getDate() +
        parseInt(
          this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7'),
          10,
        ),
    );

    const refreshToken = this.refreshTokenRepository.create({
      token: refreshTokenString,
      userId: user.id,
      expiresAt: refreshTokenExpiry,
      ipAddress,
      userAgent,
    });

    await this.refreshTokenRepository.save(refreshToken);

    await this.sessionService.addRefreshTokenToSession(
      user.id,
      sessionId,
      refreshTokenString,
    );

    await this.cleanupExpiredTokens(user.id);

    return {
      accessToken,
      refreshToken: refreshTokenString,
      expiresIn: 900,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /**
   * Generate random refresh token
   */
  private generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Generate verification token
   */
  private generateVerificationToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate random password for OAuth users
   */
  private generateRandomPassword(): string {
    return 'oauth_' + crypto.randomBytes(32).toString('hex');
  }

  /**
   * Clean up expired and old refresh tokens
   */
  private async cleanupExpiredTokens(userId: string): Promise<void> {
    const now = new Date();

    await this.refreshTokenRepository
      .createQueryBuilder()
      .delete()
      .where('userId = :userId', { userId })
      .andWhere('expiresAt < :now', { now })
      .execute();

    const validTokens = await this.refreshTokenRepository.find({
      where: { userId, isRevoked: false },
      order: { createdAt: 'DESC' },
    });

    if (validTokens.length > 5) {
      const tokensToRevoke = validTokens.slice(5);
      await this.refreshTokenRepository.update(
        tokensToRevoke.map((t) => t.id),
        { isRevoked: true },
      );
    }
  }

  /**
   * Verify access token
   */
  async verifyAccessToken(token: string): Promise<JwtPayload> {
    try {
      return this.jwtService.verify(token);
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Get user from token
   */
  async getUserFromToken(token: string): Promise<User> {
    const payload = await this.verifyAccessToken(token);
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  /**
   * Get current session info
   */
  async getSessionInfo(userId: string): Promise<any> {
    return this.sessionService.getSession(userId);
  }

  /**
   * Cleanup cron - runs every hour
   */
  @Cron('0 * * * *')
  async cleanupExpiredBlacklistedTokens(): Promise<void> {
    this.logger.log('🧹 Starting blacklist cleanup...');

    const result: any = await this.tokenBlacklistRepository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: new Date() })
      .execute();

    if (result?.affected > 0) {
      this.logger.log(
        `✅ Cleaned up ${result.affected} expired blacklisted tokens`,
      );
    } else {
      this.logger.log('ℹ️ No expired tokens to clean up');
    }
  }
}