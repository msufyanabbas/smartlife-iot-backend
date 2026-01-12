import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Get,
  Req,
  Ip,
  Headers,
  Query,
  Res,
  Delete,
  Param,
  Inject,
  UnauthorizedException,
  Logger
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User, UserRole } from '../users/entities/user.entity';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { redisService } from '@/lib/redis/redis.service';
import {
  GoogleAuthGuard,
  GitHubAuthGuard,
  AppleAuthGuard,
} from '@guards/oauth/oauth.guards';
import { OAuthProviderEnum } from './entities/oauth-account.entity';
import { randomBytes } from 'crypto';
import { ExchangeCodeDto } from './dto/exchange-code.dto';
import { TwoFactorChallengeDto } from '../two-factor/dto/two-factor-challenge.dto';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards';
import { CreateInvitationDto } from './dto/invitation.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(
    private readonly authService: AuthService,
    @Inject('REDIS_SERVICE') private readonly redis: typeof redisService,
  ) {}

  /**
   * ✅ Register a new user
   */

  @SkipThrottle()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new user',
    description: `
    Register as:
    - **Tenant Admin**: Provide companyName to create a new organization
    - **Individual User**: Don't provide companyName (auto-creates personal workspace)
    - **Invited User**: Provide invitationToken to join existing tenant/customer
    `,
  })
  @ApiResponse({
    status: 201,
    description: 'User successfully registered. Verification email sent.',
    schema: {
      example: {
        message:
          'Registration successful. Please check your email to verify your account.',
        email: 'john.doe@smartlife.sa',
        userId: '123e4567-e89b-12d3-a456-426614174000',
      },
    },
  })
  @ApiResponse({
    status: 409,
    description: 'User already exists',
    schema: {
      example: {
        statusCode: 409,
        message: 'User with this email already exists',
        error: 'Conflict',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input or invitation token',
  })
  async register(
    @Body() registerDto: RegisterDto,
  ): Promise<{ message: string; email: string; userId?: string }> {
    return this.authService.register(registerDto);
  }

  /**
   * ✅ NEW: Create invitation
   */
  @Post('invitations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
  )
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send invitation to join tenant or customer',
    description: `
**Role-based Permissions:**
- **Tenant Admin**: Can invite tenant users, customer admins, customer users
- **Customer Admin**: Can only invite customer users to their customer
- **Super Admin**: Can invite anyone anywhere
    `,
  })
  @ApiResponse({
    status: 201,
    description: 'Invitation sent successfully',
    schema: {
      example: {
        message: 'Invitation sent successfully',
        token: 'a1b2c3d4e5f6g7h8...',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Insufficient permissions',
  })
  @ApiResponse({
    status: 409,
    description: 'User already exists or invitation already sent',
  })
  async createInvitation(
    @CurrentUser() user: User,
    @Body() createInvitationDto: CreateInvitationDto,
  ): Promise<{ message: string; token: string }> {
    return this.authService.createInvitation(user.id, createInvitationDto);
  }

  /**
   * ✅ NEW: Get invitation details (public endpoint)
   */
  @Get('invitations/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get invitation details',
    description: 'Retrieve information about an invitation using its token',
  })
  @ApiParam({
    name: 'token',
    description: 'Invitation token from email',
    example: 'a1b2c3d4e5f6g7h8...',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation details retrieved',
    schema: {
      example: {
        id: 'invitation-uuid',
        email: 'sara.ali@example.com',
        role: 'customer_user',
        tenantName: 'Smart Life Solutions',
        customerName: 'King Fahd Hospital',
        inviterName: 'Ahmed Al-Saud',
        expiresAt: '2025-12-28T10:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Invitation not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Invitation has expired or been revoked',
  })
  async getInvitation(@Param('token') token: string) {
    const invitation = await this.authService.getInvitation(token);

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      tenantName: invitation.tenant?.name,
      customerName: invitation.customer?.title,
      inviterName: invitation.inviter?.name,
      inviteeName: invitation.inviteeName,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * ✅ NEW: List invitations (admin only)
   */
  @Get('invitations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List all invitations',
    description: 'Get all invitations for your tenant/customer',
  })
  @ApiResponse({
    status: 200,
    description: 'List of invitations',
  })
  async listInvitations(@CurrentUser() user: User) {
    return this.authService.listInvitations(user.id);
  }

  /**
   * ✅ NEW: Revoke invitation
   */
  @Delete('invitations/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    UserRole.SUPER_ADMIN,
    UserRole.TENANT_ADMIN,
    UserRole.CUSTOMER_ADMIN,
  )
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a pending invitation',
  })
  @ApiParam({
    name: 'id',
    description: 'Invitation ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Invitation revoked successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Invitation not found',
  })
  async revokeInvitation(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    await this.authService.revokeInvitation(user.id, id);
    return { message: 'Invitation revoked successfully' };
  }


  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with token' })
  @ApiQuery({
    name: 'token',
    type: String,
    description: 'Email verification token',
  })
  @ApiResponse({
    status: 200,
    description: 'Email verified successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async verifyEmail(
    @Query('token') token: string,
  ): Promise<{ message: string }> {
    return this.authService.verifyEmail(token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend verification email' })
  @ApiResponse({
    status: 200,
    description: 'Verification email sent',
  })
  @ApiResponse({
    status: 400,
    description: 'Email already verified or user not found',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
      },
    },
  })
  async resendVerification(
    @Body('email') email: string,
  ): Promise<{ message: string }> {
    return this.authService.resendVerificationEmail(email);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } }) // Limit to 5 requests per minute for login
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login user' })
  @ApiResponse({
    status: 200,
    description: 'User successfully logged in',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials or email not verified',
  })
  @ApiBody({ type: LoginDto })
  async login(
    @Body() loginDto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponseDto | TwoFactorChallengeDto> {
    return this.authService.login(loginDto, ipAddress, userAgent);
  }

  // ============ OAuth Login Endpoints ============

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({ summary: 'Initiate Google OAuth login' })
  @ApiResponse({ status: 302, description: 'Redirects to Google OAuth' })
  async googleAuth() {
    // Guard redirects to Google
  }

  @Get('google/callback')
@UseGuards(GoogleAuthGuard)
@ApiOperation({ summary: 'Google OAuth callback' })
@ApiResponse({
  status: 302,
  description: 'Redirects to frontend with session code',
})
async googleAuthCallback(
  @Req() req: Request,
  @Ip() ipAddress: string,
  @Headers('user-agent') userAgent: string,
  @Res() res: Response,
) {
  try {
    const profile = req.user as any;
    const authResponse = await this.authService.googleLogin(
      profile,
      ipAddress,
      userAgent,
    );

    // ✅ Check if 2FA is required (this is NORMAL, not an error!)
    if ('requires2FA' in authResponse) {
      this.logger.log(
        `2FA required for Google OAuth user: ${authResponse.userId}`,
      );

      // ✅ Generate session code and store 2FA challenge info
      const sessionCode = randomBytes(32).toString('hex');

      const sessionData = {
        requires2FA: true,
        userId: authResponse.userId,
        method: authResponse.method,
        profile,
        expiresAt: Date.now() + 300000, // 5 minutes for 2FA
      };

      await this.redis.set(
        `oauth:session:${sessionCode}`,
        JSON.stringify(sessionData),
        300, // 5 minutes TTL
      );

      // ✅ Redirect to frontend with session code
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    }

    // ✅ No 2FA - proceed with normal token flow
    const sessionCode = randomBytes(32).toString('hex');

    const sessionData = {
      accessToken: authResponse.accessToken,
      refreshToken: authResponse.refreshToken,
      profile,
      userId: authResponse.user.id,
      expiresAt: Date.now() + 60000, // 1 minute
    };

    await this.redis.set(
      `oauth:session:${sessionCode}`,
      JSON.stringify(sessionData),
      60, // 60 seconds TTL
    );

    // Redirect to frontend with session code
    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
  } catch (error) {
    this.logger.error('Google auth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/login?error=auth_failed`);
  }
}

  @Get('github')
  @UseGuards(GitHubAuthGuard)
  @ApiOperation({ summary: 'Initiate GitHub OAuth login' })
  @ApiResponse({ status: 302, description: 'Redirects to GitHub OAuth' })
  async githubAuth() {
    // Guard redirects to GitHub
  }

  @Get('github/callback')
@UseGuards(GitHubAuthGuard)
@ApiOperation({ summary: 'GitHub OAuth callback' })
@ApiResponse({
  status: 302,
  description: 'Redirects to frontend with session code',
})
async githubAuthCallback(
  @Req() req: Request,
  @Ip() ipAddress: string,
  @Headers('user-agent') userAgent: string,
  @Res() res: Response,
) {
  try {
    const profile = req.user as any;
    const authResponse = await this.authService.githubLogin(
      profile,
      ipAddress,
      userAgent,
    );

    // ✅ Check if 2FA is required
    if ('requires2FA' in authResponse) {
      this.logger.log(
        `2FA required for GitHub OAuth user: ${authResponse.userId}`,
      );

      const sessionCode = randomBytes(32).toString('hex');

      const sessionData = {
        requires2FA: true,
        userId: authResponse.userId,
        method: authResponse.method,
        profile,
        expiresAt: Date.now() + 300000,
      };

      await this.redis.set(
        `oauth:session:${sessionCode}`,
        JSON.stringify(sessionData),
        300,
      );

      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    }

    // No 2FA - normal flow
    const sessionCode = randomBytes(32).toString('hex');

    const sessionData = {
      accessToken: authResponse.accessToken,
      refreshToken: authResponse.refreshToken,
      profile,
      userId: authResponse.user.id,
      expiresAt: Date.now() + 60000,
    };

    await this.redis.set(
      `oauth:session:${sessionCode}`,
      JSON.stringify(sessionData),
      60,
    );

    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
  } catch (error) {
    this.logger.error('GitHub auth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/login?error=auth_failed`);
  }
}

  @Get('apple')
  @UseGuards(AppleAuthGuard)
  @ApiOperation({ summary: 'Initiate Apple OAuth login' })
  @ApiResponse({ status: 302, description: 'Redirects to Apple OAuth' })
  async appleAuth() {
    // Guard redirects to Apple
  }

  @Post('apple/callback')
@UseGuards(AppleAuthGuard)
@ApiOperation({ summary: 'Apple OAuth callback' })
@ApiResponse({
  status: 302,
  description: 'Redirects to frontend with session code',
})
async appleAuthCallback(
  @Req() req: Request,
  @Ip() ipAddress: string,
  @Headers('user-agent') userAgent: string,
  @Res() res: Response,
) {
  try {
    const profile = req.user as any;
    const authResponse = await this.authService.appleLogin(
      profile,
      ipAddress,
      userAgent,
    );

    // ✅ Check if 2FA is required
    if ('requires2FA' in authResponse) {
      this.logger.log(
        `2FA required for Apple OAuth user: ${authResponse.userId}`,
      );

      const sessionCode = randomBytes(32).toString('hex');

      const sessionData = {
        requires2FA: true,
        userId: authResponse.userId,
        method: authResponse.method,
        profile,
        expiresAt: Date.now() + 300000,
      };

      await this.redis.set(
        `oauth:session:${sessionCode}`,
        JSON.stringify(sessionData),
        300,
      );

      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    }

    // No 2FA - normal flow
    const sessionCode = randomBytes(32).toString('hex');

    const sessionData = {
      accessToken: authResponse.accessToken,
      refreshToken: authResponse.refreshToken,
      profile,
      userId: authResponse.user.id,
      expiresAt: Date.now() + 60000,
    };

    await this.redis.set(
      `oauth:session:${sessionCode}`,
      JSON.stringify(sessionData),
      60,
    );

    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
  } catch (error) {
    this.logger.error('Apple auth callback error:', error);
    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/login?error=auth_failed`);
  }
}

@Post('exchange-code')
@ApiOperation({
  summary: 'Exchange session code for access tokens',
  description: 'Exchanges one-time session code. May return tokens OR 2FA challenge.'
})
@ApiResponse({
  status: 200,
  description: 'Returns tokens OR 2FA challenge',
})
@ApiResponse({ status: 401, description: 'Invalid or expired code' })
async exchangeCode(
  @Body() exchangeCodeDto: ExchangeCodeDto,
  @Ip() ipAddress: string,
  @Headers('user-agent') userAgent: string,
) {
  const { code } = exchangeCodeDto;

  if (!code) {
    throw new UnauthorizedException('Code is required');
  }

  const sessionKey = `oauth:session:${code}`;
  const data = await this.redis.get(sessionKey);

  if (!data) {
    throw new UnauthorizedException('Invalid or expired code');
  }

  const sessionData = JSON.parse(data);

  // Verify not expired
  if (Date.now() > sessionData.expiresAt) {
    await this.redis.del(sessionKey);
    throw new UnauthorizedException('Code has expired');
  }

  // Delete the code immediately (one-time use)
  await this.redis.del(sessionKey);

  // ✅ CHECK IF THIS IS A 2FA CHALLENGE
  if (sessionData.requires2FA) {
    this.logger.log(`2FA challenge for user ${sessionData.userId}`);
    
    return {
      requires2FA: true,
      userId: sessionData.userId,
      method: sessionData.method,
    };
  }

  // ✅ NO 2FA - RETURN TOKENS
  this.logger.log(
    `Token exchange for user ${sessionData.userId} from ${ipAddress}`,
  );

  return {
    accessToken: sessionData.accessToken,
    refreshToken: sessionData.refreshToken,
    userId: sessionData.userId,
    user: sessionData.profile,
  };
}

  /**
 * Verify 2FA code for OAuth login
 */
@Post('oauth/verify-2fa')
@HttpCode(HttpStatus.OK)
@ApiOperation({ 
  summary: 'Verify 2FA code for OAuth login',
  description: 'Complete OAuth login by verifying 2FA code'
})
@ApiResponse({
  status: 200,
  description: 'Returns access token, refresh token, and user information',
  type: AuthResponseDto,
})
@ApiResponse({ status: 401, description: 'Invalid 2FA code' })
@ApiBody({
  schema: {
    type: 'object',
    properties: {
      userId: { type: 'string', example: 'user-uuid' },
      code: { type: 'string', example: '123456' },
    },
    required: ['userId', 'code'],
  },
})
async verifyOAuth2FA(
  @Body('userId') userId: string,
  @Body('code') code: string,
  @Ip() ipAddress: string,
  @Headers('user-agent') userAgent: string,
): Promise<AuthResponseDto> {
  return this.authService.verifyOAuth2FA(userId, code, ipAddress, userAgent);
}

  // ============ OAuth Account Management ============

  @Get('oauth/accounts')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get linked OAuth accounts' })
  @ApiResponse({
    status: 200,
    description: 'List of linked OAuth accounts',
  })
  async getLinkedAccounts(@CurrentUser() user: User) {
    return this.authService.getLinkedOAuthAccounts(user.id);
  }

  @Delete('oauth/unlink/:provider')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink OAuth account' })
  @ApiParam({
    name: 'provider',
    enum: OAuthProviderEnum,
    description: 'OAuth provider to unlink',
  })
  @ApiResponse({
    status: 200,
    description: 'OAuth account unlinked successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Cannot unlink - set password first',
  })
  async unlinkOAuthAccount(
    @CurrentUser() user: User,
    @Param('provider') provider: OAuthProviderEnum,
  ): Promise<{ message: string }> {
    return this.authService.unlinkOAuthAccount(user.id, provider);
  }

  // ============ Original Endpoints ============

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiResponse({
    status: 200,
    description: 'Password reset email sent if user exists',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
      },
    },
  })
  async forgotPassword(
    @Body('email') email: string,
  ): Promise<{ message: string }> {
    return this.authService.requestPasswordReset(email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({
    status: 200,
    description: 'Password reset successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
  })
  async resetPassword(
    @Body('token') token: string,
    @Body('newPassword') newPassword: string,
  ): Promise<{ message: string }> {
    return this.authService.resetPassword(token, newPassword);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({
    status: 200,
    description: 'Tokens successfully refreshed',
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiBody({ type: RefreshTokenDto })
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<AuthResponseDto> {
    return this.authService.refreshTokens(
      refreshTokenDto.refreshToken,
      ipAddress,
      userAgent,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  // @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout user (revoke refresh token)' })
  @ApiResponse({ status: 200, description: 'Successfully logged out' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiBody({ type: RefreshTokenDto })
  async logout(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Headers('authorization') authorization: string,
  ): Promise<{ message: string }> {
    const accessToken = authorization?.replace('Bearer ', '');
    await this.authService.logout(refreshTokenDto.refreshToken, accessToken);
    return { message: 'Successfully logged out' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout from all devices' })
  @ApiResponse({
    status: 200,
    description: 'Successfully logged out from all devices',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logoutAll(
    @CurrentUser() user: User,
    @Headers('authorization') authorization: string,
  ): Promise<{ message: string }> {
    const accessToken = authorization?.replace('Bearer ', '');
    await this.authService.logoutAll(user.id, accessToken);
    return { message: 'Successfully logged out from all devices' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      status: user.status,
      avatar: user.avatar,
      emailVerified: user.emailVerified,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password successfully changed' })
  @ApiResponse({ status: 400, description: 'Invalid current password' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        oldPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
      required: ['oldPassword', 'newPassword'],
    },
  })
  async changePassword(
    @CurrentUser() user: User,
    @Body() body: { oldPassword: string; newPassword: string },
  ): Promise<{ message: string }> {
    await this.authService.changePassword(
      user.id,
      body.oldPassword,
      body.newPassword,
    );
    return { message: 'Password successfully changed. Please login again.' };
  }

  @Get('verify-token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify if access token is valid' })
  @ApiResponse({ status: 200, description: 'Token is valid' })
  @ApiResponse({ status: 401, description: 'Token is invalid or expired' })
  async verifyToken(@CurrentUser() user: User) {
    return {
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  /**
   * Get current session information
   */
  @Get('session/info')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current session information' })
  @ApiResponse({
    status: 200,
    description: 'Current session information',
    schema: {
      example: {
        sessionId: 'abc123...',
        userId: 'user-id',
        createdAt: '2024-01-01T00:00:00.000Z',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
        loginMethod: 'google',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getSessionInfo(@CurrentUser() user: User) {
    const session = await this.authService.getSessionInfo(user.id);
    
    if (!session) {
      throw new UnauthorizedException('No active session found');
    }

    return session;
  }
}