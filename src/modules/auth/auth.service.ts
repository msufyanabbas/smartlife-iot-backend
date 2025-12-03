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
import { v4 as uuidv4 } from 'uuid'; // 🆕 Import for generating session IDs
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  OAuthAccount,
  OAuthProviderEnum,
} from './entities/oauth-account.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { MailService } from '../mail/mail.service';
import { GoogleProfile } from './strategies/oauth/google.strategy';
import { GitHubProfile } from './strategies/oauth/github.strategy';
import { AppleProfile } from './strategies/oauth/apple.strategy';
import { TokenBlacklist } from './entities/token-blacklist.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionPlan } from '../subscriptions/entities/subscription.entity';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SessionService } from './session/session.service'; // 🆕 Import session service

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
    private sessionService: SessionService, // 🆕 Inject session service
  ) {}

  /**
   * Register a new user
   */
  async register(
    registerDto: RegisterDto,
  ): Promise<{ message: string; email: string }> {
    const { email, password, name, phone } = registerDto;

    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Check if phone number already exists (if provided)
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

    // Generate email verification token
    const verificationToken = this.generateVerificationToken();

    // Create new user
    const user = this.userRepository.create({
      email,
      password, // Will be hashed by @BeforeInsert hook
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
      this.logger.error(
        `Failed to create subscription for ${email}:`,
        error,
      );
    }

    this.logger.log(`New user registered: ${email}`);

    // Send verification email
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
      // Don't fail registration if email fails
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

    // Update user
    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    await this.userRepository.save(user);

    this.logger.log(`Email verified for user: ${user.email}`);

    // Send welcome email
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

    // Generate new token
    const verificationToken = this.generateVerificationToken();
    user.emailVerificationToken = verificationToken;
    await this.userRepository.save(user);

    // Send verification email
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
   * 🆕 Now includes session management
   */
  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const { email, password } = loginDto;

    // Validate user credentials
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if email is verified
    if (!user.emailVerified) {
      throw new UnauthorizedException(
        'Please verify your email before logging in. Check your inbox for the verification link.',
      );
    }

    // Update last login
    user.updateLastLogin();
    await this.userRepository.save(user);

    this.logger.log(`User logged in: ${email}`);

    // 🆕 Generate tokens with session management
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
   * 🆕 Now includes session management
   */
  async googleLogin(
    profile: GoogleProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
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
   * 🆕 Now includes session management
   */
  async githubLogin(
    profile: GitHubProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    return this.handleOAuthLogin(
      OAuthProviderEnum.GITHUB,
      profile.id,
      profile.email,
      profile.name,
      true, // GitHub emails are verified
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
   * 🆕 Now includes session management
   */
  async appleLogin(
    profile: AppleProfile,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
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
   * 🆕 Updated to pass login method for session tracking
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
  ): Promise<AuthResponseDto> {
    // Check if OAuth account exists
    let oauthAccount = await this.oauthAccountRepository.findOne({
      where: { provider, providerId },
      relations: ['user'],
    });

    let user: User | null = null;

    if (oauthAccount) {
      // Existing OAuth account - use linked user
      user = oauthAccount.user;

      // Update OAuth account profile
      oauthAccount.providerEmail = email;
      oauthAccount.profile = profile;
      oauthAccount.accessToken = accessToken;
      oauthAccount.refreshToken = refreshToken;
      oauthAccount.tokenExpiresAt = accessToken
        ? new Date(Date.now() + 3600 * 1000)
        : undefined; // Example expiry
      await this.oauthAccountRepository.save(oauthAccount);
    } else {
      // Check if user exists with this email
      user = await this.userRepository.findOne({
        where: { email },
      });

      if (user) {
        // Link OAuth account to existing user
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
            : undefined, // Example expiry
        });
        await this.oauthAccountRepository.save(oauthAccount);

        this.logger.log(
          `OAuth account linked to existing user: ${email} (${provider})`,
        );
      } else {
        // Create new user
        user = this.userRepository.create({
          email,
          name,
          emailVerified,
          avatar,
          password: this.generateRandomPassword(), // Generate random password for OAuth users
        });
        await this.userRepository.save(user);

        // 🆕 CREATE FREE SUBSCRIPTION FOR NEW OAUTH USER
        try {
          await this.subscriptionsService.create(user.id, {
            plan: SubscriptionPlan.FREE,
          });
          this.logger.log(`FREE subscription created for OAuth user: ${email}`);
        } catch (error) {
          this.logger.error(
            `Failed to create subscription for OAuth user ${email}:`,
            error,
          );
        }

        // Create OAuth account
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
            : undefined, // Example expiry
        });
        await this.oauthAccountRepository.save(oauthAccount);

        this.logger.log(`New user created via OAuth: ${email} (${provider})`);

        // Send welcome email
        try {
          await this.mailService.sendWelcomeEmail(email, name);
        } catch (error) {
          this.logger.error(`Failed to send welcome email to ${email}:`, error);
        }
      }
    }

    // Check if user is active
    if (!user.isActive()) {
      throw new UnauthorizedException('User account is not active');
    }

    // Update last login
    user.updateLastLogin();
    await this.userRepository.save(user);

    this.logger.log(`User logged in via OAuth: ${email} (${provider})`);

    // 🆕 Generate tokens with session management
    return this.generateAuthResponse(user, ipAddress, userAgent, provider.toLowerCase() as any);
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
    // Check if OAuth account already linked to another user
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

    // Create OAuth link
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

    // Check if user has a password set (to prevent lockout)
    const user: any = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user.password || user.password.startsWith('oauth_')) {
      // Check if user has other OAuth accounts
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
   * 🆕 Now validates session BEFORE allowing refresh
   */
  async refreshTokens(
    refreshTokenString: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    // Find refresh token
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

    // 🆕 CRITICAL: Get existing session FIRST
    const existingSession = await this.sessionService.getSession(user.id);

    // 🆕 CRITICAL: If no session exists, user logged in from another device
    // Do NOT create a new session, reject the refresh
    if (!existingSession) {
      // Revoke this refresh token since session is gone
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      this.logger.warn(
        `Refresh token rejected for user ${user.email}: No active session (logged in from another device)`,
      );

      throw new UnauthorizedException(
        'Session has expired or was terminated. Please log in again.',
      );
    }

    // 🆕 CRITICAL: Validate that this refresh token belongs to current session
    const isTokenValidForSession = await this.sessionService.isRefreshTokenValidForSession(
      user.id,
      refreshTokenString,
    );

    if (!isTokenValidForSession) {
      // Revoke this refresh token since it's from an old session
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      this.logger.warn(
        `Refresh token rejected for user ${user.email}: Token from old session (user logged in from another device)`,
      );

      throw new UnauthorizedException(
        'This session is no longer valid. You may have logged in from another device. Please log in again.',
      );
    }

    // Revoke old refresh token
    refreshToken.isRevoked = true;
    await this.refreshTokenRepository.save(refreshToken);

    // Extend existing session
    await this.sessionService.extendSession(user.id);

    this.logger.log(`Tokens refreshed for user: ${user.email}`);

    // Use existing session ID to maintain continuity
    const sessionId = existingSession.sessionId;

    // Generate new tokens with SAME session ID
    return this.generateAuthResponseWithSessionId(user, sessionId, ipAddress, userAgent);
  }

  /**
   * Logout user (revoke refresh token)
   * 🆕 Now also deletes session
   */
  async logout(refreshTokenString: string, accessToken: string): Promise<void> {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenString },
    });

    if (refreshToken) {
      refreshToken.isRevoked = true;
      await this.refreshTokenRepository.save(refreshToken);

      // Blacklist access token
      if (accessToken) {
        await this.blacklistToken(accessToken, refreshToken.userId);
      }

      // 🆕 Delete session from Redis
      await this.sessionService.deleteSession(refreshToken.userId);

      this.logger.log(`User logged out, token revoked, session deleted`);
    }
  }

  /**
   * Logout from all devices (revoke all refresh tokens)
   * 🆕 Now also deletes session
   */
  async logoutAll(userId: string, accessToken: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    // Blacklist current access token
    if (accessToken) {
      await this.blacklistToken(accessToken, userId);
    }

    // 🆕 Delete session from Redis
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
      // Don't reveal if user exists
      return {
        message: 'If the email exists, a password reset link has been sent.',
      };
    }

    // Check if email is verified
    if (!user.emailVerified) {
      throw new BadRequestException(
        'Please verify your email first. Check your inbox for the verification link.',
      );
    }

    // Generate reset token
    const resetToken = this.generateVerificationToken();
    const resetExpiry = new Date();
    resetExpiry.setHours(resetExpiry.getHours() + 1); // 1 hour expiry

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = resetExpiry;
    await this.userRepository.save(user);

    // Send reset email
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

    // Check if token expired
    if (new Date() > user.passwordResetExpires) {
      throw new BadRequestException('Reset token has expired');
    }

    // Update password
    user.password = newPassword; // Will be hashed by @BeforeUpdate hook
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await this.userRepository.save(user);

    // Revoke all refresh tokens and delete session
    await this.logoutAll(user.id, token);

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

    user.password = newPassword; // Will be hashed by @BeforeUpdate hook
    await this.userRepository.save(user);

    // Revoke all refresh tokens to force re-login and delete session
    await this.logoutAll(userId, '');

    this.logger.log(`Password changed for user: ${user.email}`);
  }

  /**
   * 🆕 Generate authentication response with NEW session
   */
  private async generateAuthResponse(
    user: User,
    ipAddress?: string,
    userAgent?: string,
    loginMethod?: 'local' | 'google' | 'github' | 'apple',
  ): Promise<AuthResponseDto> {
    // Generate NEW session ID
    const sessionId = uuidv4();

    // Create session in Redis (this will overwrite any existing session)
    await this.sessionService.createSession(user.id, sessionId, {
      ipAddress,
      userAgent,
      loginMethod,
    });

    return this.generateAuthResponseWithSessionId(user, sessionId, ipAddress, userAgent);
  }

  /**
   * 🆕 Generate authentication response with SPECIFIC session ID
   * (Used for refresh token flow to maintain session)
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
      sessionId, // 🆕 Include session ID in JWT
    };

    // Generate access token
    const accessToken = this.jwtService.sign(payload);

    // Generate refresh token
    const refreshTokenString = this.generateRefreshToken();
    const refreshTokenExpiry = new Date();
    refreshTokenExpiry.setDate(
      refreshTokenExpiry.getDate() +
        parseInt(
          this.configService.get<string>('JWT_REFRESH_EXPIRATION', '7'),
          10,
        ),
    );

    // 🆕 Save refresh token with sessionId metadata
    const refreshToken = this.refreshTokenRepository.create({
      token: refreshTokenString,
      userId: user.id,
      expiresAt: refreshTokenExpiry,
      ipAddress,
      userAgent,
      // 🆕 Store sessionId in a metadata field (you may need to add this column)
      // For now, we'll use userAgent field to append sessionId temporarily
      // Or add a proper sessionId column to RefreshToken entity
    });

    await this.refreshTokenRepository.save(refreshToken);

    // 🆕 CRITICAL: Store refresh token associated with session
    await this.sessionService.addRefreshTokenToSession(user.id, sessionId, refreshTokenString);

    // Clean up expired tokens
    await this.cleanupExpiredTokens(user.id);

    return {
      accessToken,
      refreshToken: refreshTokenString,
      expiresIn: 900, // 15 minutes in seconds
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

    // Delete expired tokens
    await this.refreshTokenRepository
      .createQueryBuilder()
      .delete()
      .where('userId = :userId', { userId })
      .andWhere('expiresAt < :now', { now })
      .execute();

    // Keep only last 5 valid tokens per user
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
   * 🆕 Get current session info
   */
  async getSessionInfo(userId: string): Promise<any> {
    return this.sessionService.getSession(userId);
  }

  // Cleanup cron - runs every hour
  @Cron('0 * * * *') // Runs at the top of every hour (e.g., 1:00, 2:00, 3:00)
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