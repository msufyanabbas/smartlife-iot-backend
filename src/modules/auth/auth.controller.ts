// src/modules/auth/auth.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus, Get, Req, Ip, Headers, Query, Res, Delete, Param, Inject, UnauthorizedException, Logger, Patch, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiBody, ApiQuery, ApiParam } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService, TenantsService } from '@modules/index.service';
import { LoginDto, RegisterDto, RefreshTokenDto, AuthResponseDto, UpdateProfileDto, CreateInvitationDto, ExchangeCodeDto, ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto, ResendVerificationDto, VerifyOAuth2FADto, InvitationPublicDto } from '@modules/auth/dto/index.dto';
import { CurrentUser } from '@common/decorators/current-user.decorator';
import { Public, Roles } from '@common/decorators/index.decorator';
import { User } from '@modules/index.entities';
import { UserRole, OAuthProviderEnum } from '@common/enums/index.enum'
import { Throttle } from '@nestjs/throttler';
import { RedisService } from '@lib/redis/redis.service';
import { GoogleAuthGuard, GitHubAuthGuard, AppleAuthGuard
} from '@guards/index.guards';
import { randomBytes } from 'crypto';
import { TwoFactorChallengeDto } from '../two-factor/dto/two-factor-challenge.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(
    private readonly authService: AuthService,
    private readonly tenantService: TenantsService,
    @Inject('REDIS_SERVICE') private readonly redis: RedisService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Registration & Verification
  // ═══════════════════════════════════════════════════════════════════════════

  // @Public() + @Throttle() — public but rate-limited (no @SkipThrottle)
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user or accept an invitation' })
  @ApiResponse({ status: 201, description: 'Registration successful. Verification email sent.' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @ApiResponse({ status: 400, description: 'Invalid input, invitation token, or missing required fields' })
  async register(@Body() dto: RegisterDto): Promise<{ message: string; email: string }> {
    return this.authService.register(dto);
  }

  /**
   * ✅ NEW: Create invitation
   */
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @Post('invitations')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send an invitation to join tenant or customer' })
  @ApiResponse({ status: 201, description: 'Invitation sent successfully' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 409, description: 'User or active invitation already exists' })
  async createInvitation(
    @CurrentUser() user: User,
    @Body() dto: CreateInvitationDto,
  ): Promise<{ message: string; token: string }> {
    // Pass caller context from @CurrentUser() — service no longer loads user from DB
    return this.authService.createInvitation(
      user.id,
      user.tenantId,
      user.role,
      user.customerId!,
      user.id,
      dto,
    );
  }

  /**
   * ✅ NEW: Get invitation details (public endpoint)
   */
  @Public()  // anyone with the token link can view the invitation details
  @Get('invitations/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get invitation details by token (public)' })
  @ApiParam({ name: 'token', description: 'Invitation token from email link' })
  @ApiResponse({ status: 200, type: InvitationPublicDto })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  @ApiResponse({ status: 400, description: 'Invitation expired or revoked' })
  async getInvitation(@Param('token') token: string): Promise<InvitationPublicDto> {
    const invitation = await this.authService.getInvitation(token);

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      tenantName: invitation.tenant?.name,
      customerName: invitation.customer?.name,
      inviterName: invitation.inviter?.name,
      inviteeName: invitation.inviteeName,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * ✅ NEW: List invitations (admin only)
   */
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @Get('invitations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all invitations for your tenant or customer' })
  async listInvitations(@CurrentUser() user: User) {
    // Pass context from JWT — no DB load inside service
    return this.authService.listInvitations(user.tenantId, user.role, user.customerId!);
  }

  /**
   * ✅ NEW: Revoke invitation
   */
  @Roles(UserRole.SUPER_ADMIN, UserRole.TENANT_ADMIN, UserRole.CUSTOMER)
  @Delete('invitations/:id')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  @ApiParam({ name: 'id', description: 'Invitation ID' })
  @ApiResponse({ status: 200, description: 'Invitation revoked' })
  @ApiResponse({ status: 404, description: 'Invitation not found' })
  async revokeInvitation(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    await this.authService.revokeInvitation(user.id, user.tenantId, user.role, id);
    return { message: 'Invitation revoked successfully' };
  }

  @Public()
  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address with token from email link' })
  @ApiQuery({ name: 'token', type: String })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async verifyEmail(@Query('token') token: string): Promise<{ message: string }> {
    return this.authService.verifyEmail(token);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification link' })
  @ApiResponse({ status: 200, description: 'Link sent if email exists and is unverified' })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    // dto validates email format — no more raw @Body('email') string
    return this.authService.resendVerificationEmail(dto.email);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Login
  // ═══════════════════════════════════════════════════════════════════════════
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // Limit to 5 requests per minute for login
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful or 2FA required', type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials or unverified email' })
  async login(
    @Body() dto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    return this.authService.login(dto, ipAddress, userAgent);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OAuth — Social Login
  // ═══════════════════════════════════════════════════════════════════════════
  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)  // OAuth guards MUST use @UseGuards — not global
  @ApiOperation({ summary: 'Initiate Google OAuth login' })
  @ApiResponse({ status: 302, description: 'Redirects to Google OAuth' })
  async googleAuth() {}

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    return this.handleOAuthCallback(
      req, res, ipAddress, userAgent,
      () => this.authService.googleLogin(req.user as any, ipAddress, userAgent),
      'Google',
    );
  }

  @Public()
  @Get('github')
  @UseGuards(GitHubAuthGuard)
  @ApiOperation({ summary: 'Initiate GitHub OAuth login' })
  async githubAuth() {}

  @Public()
  @Get('github/callback')
  @UseGuards(GitHubAuthGuard)
  @ApiOperation({ summary: 'GitHub OAuth callback' })
  async githubAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    return this.handleOAuthCallback(
      req, res, ipAddress, userAgent,
      () => this.authService.githubLogin(req.user as any, ipAddress, userAgent),
      'GitHub',
    );
  }

  @Public()
  @Get('apple')
  @UseGuards(AppleAuthGuard)
  @ApiOperation({ summary: 'Initiate Apple OAuth login' })
  async appleAuth() {}

  @Public()
  @Post('apple/callback')  // Apple sends POST
  @UseGuards(AppleAuthGuard)
  @ApiOperation({ summary: 'Apple OAuth callback' })
  async appleAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    return this.handleOAuthCallback(
      req, res, ipAddress, userAgent,
      () => this.authService.appleLogin(req.user as any, ipAddress, userAgent),
      'Apple',
    );
  }

@Public()
  @Post('exchange-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange one-time OAuth session code for tokens' })
  @ApiResponse({ status: 200, description: 'Returns tokens or 2FA challenge' })
  @ApiResponse({ status: 401, description: 'Invalid or expired code' })
  async exchangeCode(
    @Body() dto: ExchangeCodeDto,
  ) {
    const sessionKey = `oauth:session:${dto.code}`;
    const data = await this.redis.get(sessionKey);

    if (!data) throw new UnauthorizedException('Invalid or expired code');

    const sessionData = JSON.parse(data);

    if (Date.now() > sessionData.expiresAt) {
      await this.redis.del(sessionKey);
      throw new UnauthorizedException('Code has expired');
    }

    await this.redis.del(sessionKey); // one-time use

    if (sessionData.requires2FA) {
      return { requires2FA: true, userId: sessionData.userId, method: sessionData.method };
    }

    return {
      accessToken: sessionData.accessToken,
      refreshToken: sessionData.refreshToken,
      userId: sessionData.userId,
    };
  }

  /**
 * Verify 2FA code for OAuth login
 */
 @Public()
  @Post('oauth/verify-2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify 2FA code after OAuth login' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid 2FA code' })
  async verifyOAuth2FA(
    @Body() dto: VerifyOAuth2FADto,  // typed DTO — no more raw @Body('userId'), @Body('code')
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @CurrentUser() user: User,
  ): Promise<AuthResponseDto> {
    return this.authService.verifyOAuth2FA(user, dto.code, ipAddress, userAgent);
  }

  // ============ OAuth Account Management ============

  // ═══════════════════════════════════════════════════════════════════════════
  // OAuth Account Management
  // ═══════════════════════════════════════════════════════════════════════════


  @Get('oauth/accounts')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List linked OAuth accounts for current user' })
  async getLinkedAccounts(@CurrentUser() user: User) {
    return this.authService.getLinkedOAuthAccounts(user.id);
  }

  @Delete('oauth/unlink/:provider')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink an OAuth provider account' })
  @ApiParam({ name: 'provider', enum: OAuthProviderEnum })
  @ApiResponse({ status: 200, description: 'OAuth account unlinked' })
  @ApiResponse({ status: 400, description: 'Cannot unlink — set password first' })
  async unlinkOAuthAccount(
    @CurrentUser() user: User,
    @Param('provider') provider: OAuthProviderEnum,
  ): Promise<{ message: string }> {
    return this.authService.unlinkOAuthAccount(user.id, provider);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Password Management
  // ═══════════════════════════════════════════════════════════════════════════

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60000 } }) // Limit to 3 requests per minute for password reset
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset email' })
  @ApiResponse({ status: 200, description: 'Reset email sent if account exists' })
 async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    // Typed DTO — email validated, normalized to lowercase before hitting service
    return this.authService.requestPasswordReset(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token from email' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    // dto.newPassword validated with @MinLength(8) + @Matches(regex) — no raw strings
    return this.authService.resetPassword(dto);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Token Management
  // ═══════════════════════════════════════════════════════════════════════════

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(dto.refreshToken, ipAddress, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current session' })
  @ApiResponse({ status: 200, description: 'Successfully logged out' })
  async logout(
    @CurrentUser() user: User,  // JwtAuthGuard is global — user is always present here
    @Body() dto: RefreshTokenDto,
    @Headers('authorization') authorization: string,
  ): Promise<{ message: string }> {
    const accessToken = authorization?.replace('Bearer ', '');
    // Pass userId so service verifies the caller owns the refresh token
    await this.authService.logout(dto.refreshToken, user.id, accessToken);
    return { message: 'Successfully logged out' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiResponse({ status: 200, description: 'Logged out from all devices' })
  async logoutAll(
    @CurrentUser() user: User,
    @Headers('authorization') authorization: string,
  ): Promise<{ message: string }> {
    const accessToken = authorization?.replace('Bearer ', '');
    await this.authService.logoutAll(user.id, accessToken);
    return { message: 'Successfully logged out from all devices' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Profile
  // ═══════════════════════════════════════════════════════════════════════════

 @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  async getProfile(@CurrentUser() user: User) {
    const tenant = await this.tenantService.findOne(user.tenantId);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      companyName: tenant.name,
      phone: user.phone,
      role: user.role,
      status: user.status,
      emailVerified: user.emailVerified,
      tenantId: user.tenantId,
      customerId: user.customerId,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password (authenticated user)' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password incorrect' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    // dto.currentPassword + dto.newPassword — typed, validated
    await this.authService.changePassword(user.id, dto);
    return { message: 'Password changed successfully. Please log in again.' };
  }

  @Get('verify-token')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if current access token is valid' })
  @ApiResponse({ status: 200, description: 'Token valid' })
  @ApiResponse({ status: 401, description: 'Token invalid or expired' })
  async verifyToken(@CurrentUser() user: User) {
    return { valid: true, user: { id: user.id, email: user.email, role: user.role } };
  }

  /**
   * Get current session information
   */
  @Get('session/info')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current session information' })
  async getSessionInfo(@CurrentUser() user: User) {
    const session = await this.authService.getSessionInfo(user.id);
    if (!session) throw new UnauthorizedException('No active session found');
    return session;
  }

  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user profile (name, phone, preferences)' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 400, description: 'No fields provided or invalid input' })
  @ApiResponse({ status: 409, description: 'Phone number already in use' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<{ message: string; user: Partial<User> }> {
    return this.authService.updateProfile(user.id, dto);
  }

    private async handleOAuthCallback(
    req: Request,
    res: Response,
    ipAddress: string,
    userAgent: string,
    loginFn: () => Promise<AuthResponseDto | TwoFactorChallengeDto>,
    providerName: string,
  ) {
    const frontendUrl = process.env.FRONTEND_URL;
    try {
      const authResponse = await loginFn();
      const sessionCode = randomBytes(32).toString('hex');

      if ('requires2FA' in authResponse) {
        await this.redis.set(
          `oauth:session:${sessionCode}`,
          JSON.stringify({
            requires2FA: true,
            userId: authResponse.userId,
            method: authResponse.method,
            expiresAt: Date.now() + 300_000, // 5 minutes for 2FA
          }),
          300,
        );
      } else {
        await this.redis.set(
          `oauth:session:${sessionCode}`,
          JSON.stringify({
            accessToken: authResponse.accessToken,
            refreshToken: authResponse.refreshToken,
            userId: authResponse.user.id,
            expiresAt: Date.now() + 60_000, // 1 minute
          }),
          60,
        );
      }

      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    } catch (error) {
      this.logger.error(`${providerName} auth callback error:`, error);
      return res.redirect(`${frontendUrl}/login?error=auth_failed`);
    }
  }
}