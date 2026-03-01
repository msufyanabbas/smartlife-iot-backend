// src/modules/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService, SubscriptionsService, MailService, TwoFactorAuthService } from '@modules/index.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Customer, Invitation, Tenant, User, InvitationStatus, RefreshToken, OAuthAccount, TokenBlacklist } from '@modules/index.entities';
import { TenantStatus, SubscriptionPlan, UserRole, OAuthProviderEnum } from '@common/enums/index.enum';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto, UserInfoDto } from './dto/auth-response.dto';
import { TwoFactorChallengeDto } from '../two-factor/dto/two-factor-challenge.dto';
import { JwtPayload } from './strategies/jwt.strategy';
import { GoogleProfile, AppleProfile, GitHubProfile} from './strategies/oauth/index.strategy';
import { Cron } from '@nestjs/schedule';
import { SessionService } from './session/session.service';
import { CreateInvitationDto } from './dto/invitation.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from './dto/password.dto';

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
    @InjectRepository(Invitation)
    private invitationRepository: Repository<Invitation>,
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(Customer)
    private customerRepository: Repository<Customer>,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
    private sessionService: SessionService,
    private twoFactorAuthService: TwoFactorAuthService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Registration
  // ═══════════════════════════════════════════════════════════════════════════
  async register(
    registerDto: RegisterDto,
  ): Promise<{ message: string; email: string }> {
    const { email, password, name, phone, companyName, invitationToken } = registerDto;

    if (companyName && invitationToken) {
      throw new BadRequestException(
        'Provide either companyName or invitationToken, not both',
      );
    }

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

    let tenantId: string | undefined;
    let customerId: string | undefined;
    let role: UserRole = UserRole.TENANT_ADMIN;
    let tenant: Tenant | undefined;
    let invitation: Invitation | undefined;

    // ========================================
    // SCENARIO 1: Invitation-based signup
    // ========================================
    if (invitationToken) {
      const invitation = await this.invitationRepository.findOne({
        where: { token: invitationToken },
        relations: ['tenant', 'customer'],
      });

      if (!invitation) {
        throw new BadRequestException('Invalid invitation token');
      }

      if (!invitation.canBeAcceptedBy(email)) {
        if (invitation.email.toLowerCase() !== email.toLowerCase()) {
          throw new BadRequestException(
            `This invitation was sent to ${invitation.email}`,
          );
        }
        throw new BadRequestException(
          'Invitation has expired or been revoked',
        );
      }

      tenantId = invitation.tenantId;
      customerId = invitation.customerId;
      role = invitation.role;
      tenant = invitation.tenant;

      // Mark invitation as accepted
      invitation.status = InvitationStatus.ACCEPTED;
      invitation.acceptedAt = new Date();
      await this.invitationRepository.save(invitation);

      this.logger.log(
        `User ${email} accepting invitation as ${role} for tenant ${tenant.name}`,
      );
    }
    // ========================================
    // SCENARIO 2: Company signup (B2B/B2G)
    // ========================================
    else if (companyName) {
      // Validate company name
      if (companyName.trim().length < 2) {
        throw new BadRequestException(
          'Company name must be at least 2 characters',
        );
      }

      // Check for duplicate tenant name
      const existingTenant = await this.tenantRepository.findOne({
        where: { name: companyName },
      });

      if (existingTenant) {
        throw new ConflictException(
          'A company with this name already exists. Please choose a different name.',
        );
      }

      // Create new tenant
      tenant = this.tenantRepository.create({
        name: companyName,
        email: email, // Use signup email as tenant email
        status: TenantStatus.ACTIVE,
      });

      const savedTenant = await this.tenantRepository.save(tenant);
      tenantId = savedTenant.id;
      role = UserRole.TENANT_ADMIN;

      this.logger.log(
        `New tenant created: ${companyName} (${tenantId}) by ${email}`,
      );
    }
    // ========================================
    // SCENARIO 3: Individual signup (B2C)
    // ========================================
    else {
      // Create personal workspace for individual users
      const workspaceName = `${name}'s Workspace`;

      tenant = this.tenantRepository.create({
        name: workspaceName,
        email: email,
        status: TenantStatus.ACTIVE,
      });

      const savedTenant = await this.tenantRepository.save(tenant);
      tenantId = savedTenant.id;
      role = UserRole.TENANT_ADMIN;

      this.logger.log(
        `Individual user signup: ${email} - created personal workspace ${tenantId}`,
      );
    }

    const verificationToken = this.generateVerificationToken();

    const user = this.userRepository.create({
      email,
      password,
      name,
      phone,
      tenantId,
      customerId,
      role,
      emailVerified: false,
      emailVerificationToken: verificationToken,
    });

    const savedUser = await this.userRepository.save(user);

     if (role === UserRole.TENANT_ADMIN && tenant) {
      await this.tenantRepository.save(tenant);
    }

    if(!invitationToken && tenantId) {
    try {
      await this.subscriptionsService.create(tenantId, {
        plan: SubscriptionPlan.FREE,
      });
      this.logger.log(`FREE subscription created for user: ${email}`);
    } catch (error) {
      this.logger.error(`Failed to create subscription for ${email}:`, error);
    }
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
   * ✅ NEW: Create invitation
   */
  async createInvitation(
    callerId: string, callerTenantId: string, callerRole: UserRole, callerCustomerId: string,
    invitedBy: string,
    createInvitationDto: CreateInvitationDto,
  ): Promise<{ message: string; token: string }> {
    const { email, role, customerId, inviteeName, message, roleIds, permissionIds } = createInvitationDto;

    // ── Permission checks ──────────────────────────────────────────────────
    if (callerRole !== UserRole.SUPER_ADMIN) {
      if(callerRole === UserRole.CUSTOMER_ADMIN) {
        if(role !== UserRole.CUSTOMER_USER) {
          throw new ForbiddenException(
            'Customer admins can only invite customer users',
          );
        }
        if (!customerId || customerId !== callerCustomerId) {
          throw new ForbiddenException('Customer admins can only invite to their own customer');
        }
      }
      if (callerRole === UserRole.TENANT_ADMIN && role === UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Cannot invite super admins');
      }
       if (callerRole === UserRole.CUSTOMER_USER) {
        throw new ForbiddenException('You do not have permission to invite users');
      }
      }

      // ── Customer-scoped role requires customerId ───────────────────────────
    if ((role === UserRole.CUSTOMER_ADMIN || role === UserRole.CUSTOMER_USER) && !customerId) {
      throw new BadRequestException(
        `customerId is required when inviting a ${role}`,
      );
    }

    // ── Validate customer belongs to tenant ────────────────────────────────
    if (customerId) {
      const customer = await this.customerRepository.findOne({ where: { id: customerId } });
      if (!customer) throw new NotFoundException('Customer not found');
      if (customer.tenantId !== callerTenantId) {
        throw new ForbiddenException('Customer does not belong to your tenant');
      }
    }

    // ── Duplicate checks ───────────────────────────────────────────────────
    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) throw new ConflictException('User with this email already exists');

    const existingInvitation = await this.invitationRepository.findOne({
      where: { email, tenantId: callerTenantId, status: InvitationStatus.PENDING },
    });
    if (existingInvitation && !existingInvitation.isExpired()) {
      throw new ConflictException('An invitation for this email already exists');
    }

    // ── Create invitation ──────────────────────────────────────────────────
    // expiresAt NOT set here — @BeforeInsert() on the entity handles it
    const token = this.generateSecureToken();

    const invitation = this.invitationRepository.create({
      token,
      email,
      role,
      tenantId: callerTenantId,
      customerId,
      invitedById: callerId,    
      inviteeName,
      status: InvitationStatus.PENDING,
      metadata: {               
        message,
        roleIds,
        permissionIds,
      },
    });

    await this.invitationRepository.save(invitation);

    const inviter = await this.userRepository.findOne({
      where: { id: callerId },
      select: { name: true, email: true },
    });

    try {
      await this.mailService.sendInvitationEmail(
        email,
        inviteeName || email,
        inviter?.name || 'Smart Life',
        token,
        role,
      );
    } catch (error) {
      this.logger.error(`Failed to send invitation email to ${email}:`, error);
    }

    return { message: 'Invitation sent successfully', token };
  }

  /**
   * ✅ NEW: Get invitation details
   */
  async getInvitation(token: string): Promise<Invitation> {
    const invitation = await this.invitationRepository.findOne({
      where: { token },
      relations: ['tenant', 'customer', 'inviter'],
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (!invitation.isValid()) {
      throw new BadRequestException('Invitation has expired or been revoked');
    }

    return invitation;
  }


  /**
   * ✅ NEW: List invitations (for admins)
   */
  // Takes tenantId + role directly — no redundant DB load
  async listInvitations(tenantId: string, callerRole: UserRole, callerCustomerId?: string) {
    const where: any = { tenantId };
    if (callerRole === UserRole.CUSTOMER_ADMIN) {
      where.customerId = callerCustomerId;
    }

    return this.invitationRepository.find({
      where,
      relations: ['tenant', 'customer', 'inviter'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * ✅ NEW: Revoke invitation
   */
  // Takes tenantId + role directly — no redundant DB load
  async revokeInvitation(
    callerId: string,
    callerTenantId: string,
    callerRole: UserRole,
    invitationId: string,
  ): Promise<void> {
    const invitation = await this.invitationRepository.findOne({ where: { id: invitationId } });
    if (!invitation) throw new NotFoundException('Invitation not found');

    if (callerRole !== UserRole.SUPER_ADMIN && invitation.tenantId !== callerTenantId) {
      throw new ForbiddenException('Cannot revoke this invitation');
    }
    if (invitation.status !== InvitationStatus.PENDING) {
      throw new BadRequestException('Only pending invitations can be revoked');
    }

    invitation.status = InvitationStatus.REVOKED;
    await this.invitationRepository.save(invitation);
    this.logger.log(`Invitation ${invitationId} revoked by user ${callerId}`);
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
    // Generic message regardless of outcome — prevents email enumeration
    const genericResponse = { message: 'If the email exists and is unverified, a new link has been sent.' };

    const user = await this.userRepository.findOne({ where: { email } });
    if (!user || user.emailVerified) return genericResponse;

    const verificationToken = this.generateSecureToken();
    user.emailVerificationToken = verificationToken;
    await this.userRepository.save(user);

    try {
      await this.mailService.sendVerificationEmail(email, user.name, verificationToken);
    } catch (error) {
      this.logger.error(`Failed to resend verification email to ${email}:`, error);
    }

    return genericResponse;
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
  // ═══════════════════════════════════════════════════════════════════════════
  // OAuth
  // ═══════════════════════════════════════════════════════════════════════════
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
        const workspaceName = `${name}'s Workspace`;
        const tenant = await this.tenantRepository.save({
          name: workspaceName,
          email,
          status: TenantStatus.ACTIVE,
        });
        user = this.userRepository.create({
          email,
          name,
          emailVerified,
          tenantId: tenant.id,
          role: UserRole.TENANT_ADMIN,
          password: this.generateRandomPassword(),
        });
        await this.userRepository.save(user);

        try {
          await this.subscriptionsService.create(tenant.id, {plan: SubscriptionPlan.FREE});
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
  // ═══════════════════════════════════════════════════════════════════════════
  // Token Management
  // ═══════════════════════════════════════════════════════════════════════════
   async refreshTokens(
    refreshTokenString: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthResponseDto> {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenString },
      relations: ['user'],
    });

    if (!refreshToken) throw new UnauthorizedException('Invalid refresh token');
    if (!refreshToken.isValid()) throw new UnauthorizedException('Refresh token expired or revoked');
    if (!refreshToken.user.isActive()) throw new UnauthorizedException('User account is not active');

    const existingSession = await this.sessionService.getSession(refreshToken.user.id);
    if (!existingSession) {
      refreshToken.revoke();
      await this.refreshTokenRepository.save(refreshToken);
      throw new UnauthorizedException('Session expired. Please log in again.');
    }

    const isValidForSession = await this.sessionService.isRefreshTokenValidForSession(
      refreshToken.user.id,
      refreshTokenString,
    );
    if (!isValidForSession) {
      refreshToken.revoke();
      await this.refreshTokenRepository.save(refreshToken);
      throw new UnauthorizedException(
        'This session is no longer valid. Please log in again.',
      );
    }

    refreshToken.revoke();
    await this.refreshTokenRepository.save(refreshToken);
    await this.sessionService.extendSession(refreshToken.user.id);

    return this.generateAuthResponseWithSessionId(
      refreshToken.user,
      existingSession.sessionId,
      ipAddress,
      userAgent,
    );
  }

  /**
   * Logout user
   * ✅ Deletes session
   */
   async logout(
    refreshTokenString: string,
    userId: string,  // from @CurrentUser() — guard ensures authenticity
    accessToken?: string,
  ): Promise<void> {
    const refreshToken = await this.refreshTokenRepository.findOne({
      where: { token: refreshTokenString, userId }, // ← userId ensures caller owns this token
    });

    if (refreshToken) {
      refreshToken.revoke();
      await this.refreshTokenRepository.save(refreshToken);

      if (accessToken) await this.blacklistToken(accessToken, userId);
      await this.sessionService.deleteSession(userId);
      this.logger.log(`User ${userId} logged out`);
    }
  }

  /**
   * Logout from all devices
   * ✅ Deletes session
   */
  async logoutAll(userId: string, accessToken?: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );

    if (accessToken) await this.blacklistToken(accessToken, userId);
    await this.sessionService.deleteSession(userId);
    this.logger.log(`User ${userId} logged out from all devices`);
  }

  /**
   * Blacklist an access token
   */
  async blacklistToken(token: string, userId: string): Promise<void> {
    if (!token) return; // guard against empty strings
    try {
      const decoded = this.jwtService.decode(token) as any;
      if (!decoded?.exp) return;
      const expiresAt = new Date(decoded.exp * 1000);
      await this.tokenBlacklistRepository.save(
        this.tokenBlacklistRepository.create({ token, userId, expiresAt, reason: 'logout' }),
      );
    } catch (error) {
      this.logger.error('Failed to blacklist token:', error);
    }
  }


  /**
   * Check if token is blacklisted
   */
  async isTokenBlacklisted(token: string): Promise<boolean> {
    const entry = await this.tokenBlacklistRepository.findOne({ where: { token } });
    return !!entry;
  }

  /**
   * Request password reset
   */

  // ═══════════════════════════════════════════════════════════════════════════
  // Password Management
  // ═══════════════════════════════════════════════════════════════════════════

  async requestPasswordReset(dto: ForgotPasswordDto): Promise<{ message: string }> {
    // Always return the same message — prevents email enumeration
    const genericResponse = { message: 'If the email exists, a password reset link has been sent.' };

    const user = await this.userRepository.findOne({ where: { email: dto.email } });
    if (!user || !user.emailVerified) return genericResponse;

    const resetToken = this.generateSecureToken();
    const resetExpiry = new Date();
    resetExpiry.setHours(resetExpiry.getHours() + 1); // 1 hour expiry

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = resetExpiry;
    await this.userRepository.save(user);

    try {
      await this.mailService.sendPasswordResetEmail(dto.email, user.name, resetToken);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${dto.email}:`, error);
    }

    return genericResponse;
  }

  /**
   * Reset password with token
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    // dto.newPassword already validated by DTO (@MinLength + @Matches)
    const user = await this.userRepository.findOne({
      where: { passwordResetToken: dto.token },
    });

    if (!user || !user.passwordResetExpires) {
      throw new BadRequestException('Invalid or expired reset token');
    }
    if (new Date() > user.passwordResetExpires) {
      throw new BadRequestException('Reset token has expired');
    }

    user.password = dto.newPassword; // @BeforeUpdate hook hashes it
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await this.userRepository.save(user);

    // Revoke all refresh tokens — forces re-login on all devices
    await this.refreshTokenRepository.update(
      { userId: user.id, isRevoked: false },
      { isRevoked: true },
    );
    await this.sessionService.deleteSession(user.id);

    return { message: 'Password reset successfully. You can now log in with your new password.' };
  }
  /**
   * Change password
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const isValid = await user.comparePassword(dto.currentPassword);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    user.password = dto.newPassword; // @BeforeUpdate hook hashes it
    await this.userRepository.save(user);

    // Revoke all refresh tokens without blacklisting the access token
    // (the caller is about to get a 200 response — let their current session expire naturally)
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true },
    );
    await this.sessionService.deleteSession(userId);

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
    await this.sessionService.createSession(user.id, sessionId, { ipAddress, userAgent, loginMethod });
    return this.generateAuthResponseWithSessionId(user, sessionId, ipAddress, userAgent);
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
    // ── Build JWT payload ──────────────────────────────────────────────────
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,     // guards read from JWT — no DB call needed
      customerId: user.customerId, // same
      sessionId,
    };

    const accessToken = this.jwtService.sign(payload);

    // ── Create refresh token ───────────────────────────────────────────────
    const refreshTokenString = this.generateRefreshToken();
    const refreshTokenExpiry = new Date();
    // Config should store as a plain number of days, e.g. JWT_REFRESH_DAYS=7
    const refreshDays = this.configService.get<number>('jwt.refreshExpiresIn');
    refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + refreshDays!);

    const refreshToken = this.refreshTokenRepository.create({
      token: refreshTokenString,
      userId: user.id,
      tenantId: user.tenantId,  // ← denormalized for tenant-level revocation
      expiresAt: refreshTokenExpiry,
      deviceInfo: {             // ← structured jsonb, not flat columns
        ipAddress,
        userAgent,
      },
    });
    await this.refreshTokenRepository.save(refreshToken);

    await this.sessionService.addRefreshTokenToSession(user.id, sessionId, refreshTokenString);
    await this.cleanupExpiredTokens(user.id);

    // ── Resolve subscription plan for UserInfoDto ──────────────────────────
    let plan: string | undefined;
    if (user.tenantId) {
      try {
        const subscription = await this.subscriptionsService.findByTenantId(user.tenantId);
        plan = subscription?.plan;
      } catch {
        // Non-fatal — plan will be undefined in response, frontend handles gracefully
      }
    }

    // ── Build UserInfoDto with all required fields ─────────────────────────
    const userInfo: UserInfoDto = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      emailVerified: user.emailVerified, // ← was missing in original
      tenantId: user.tenantId,
      customerId: user.customerId,
      plan,                              // ← was missing in original
    };

    return {
      accessToken,
      refreshToken: refreshTokenString,
      expiresIn: 900, // 15 minutes in seconds
      tokenType: 'Bearer',
      user: userInfo,
    };
  }

  /**
   * Generate random refresh token
   */
 private generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }
  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
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
    await this.refreshTokenRepository
      .createQueryBuilder()
      .delete()
      .where('"userId" = :userId', { userId })
      .andWhere('"expiresAt" < :now', { now: new Date() })
      .execute();

    const validTokens = await this.refreshTokenRepository.find({
      where: { userId, isRevoked: false },
      order: { createdAt: 'DESC' },
    });

    if (validTokens.length > 5) {
      await this.refreshTokenRepository.update(
        validTokens.slice(5).map((t) => t.id),
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
    } catch {
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
   async getSessionInfo(userId: string) {
    return this.sessionService.getSession(userId);
  }
  /**
   * Cleanup cron - runs every hour
   */
@Cron('0 * * * *') // every hour
  async cleanupExpiredBlacklistedTokens(): Promise<void> {
    const result: any = await this.tokenBlacklistRepository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: new Date() })
      .execute();

    if (result?.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired blacklisted tokens`);
    }
  }

  /**
 * Update user profile (name, phone)
 */

  // ═══════════════════════════════════════════════════════════════════════════
  // Profile
  // ═══════════════════════════════════════════════════════════════════════════

async updateProfile(
  userId: string,
  updateProfileDto: UpdateProfileDto,
): Promise<{ message: string; user: Partial<User> }> {
  const { name, phone, preferences } = updateProfileDto;

  // Validate that at least one field is provided
  if (!name && !phone && !preferences) {
    throw new BadRequestException('At least one field (name, phone, or preferences) must be provided');
  }

  const user = await this.userRepository.findOne({
    where: { id: userId },
  });

  if (!user) {
    throw new NotFoundException('User not found');
  }

  // Check if phone is being updated and if it's already taken by another user
  if (phone && phone !== user.phone) {
    const conflict = await this.userRepository.findOne({
      where: { phone },
    });
    if(conflict && conflict.id !== userId){
      throw new ConflictException('This phone number is already registered to another user');
    }
    if (name) user.name = name.trim();
    if (phone) user.phone = phone;

    // Merge preferences — do not replace existing keys that weren't sent
    if (preferences) {
      user.preferences = { ...(user.preferences ?? {}), ...preferences };
    }

     await this.userRepository.save(user);
    this.logger.log(`Profile updated for user: ${user.email}`);
  }

  return {
    message: 'Profile updated successfully',
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
    },
  };
}
}