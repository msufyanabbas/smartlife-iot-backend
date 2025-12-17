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
import { User } from '../users/entities/user.entity';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import type { redisService } from '@/lib/redis/redis.service';
import { Logger } from '@nestjs/common';
import {
  GoogleAuthGuard,
  GitHubAuthGuard,
  AppleAuthGuard,
} from '@guards/oauth/oauth.guards';
import { OAuthProviderEnum } from './entities/oauth-account.entity';
import { randomBytes } from 'crypto';
import { ExchangeCodeDto } from './dto/exchange-code.dto';
import { TwoFactorChallengeDto } from '../two-factor/dto/two-factor-challenge.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(
    private readonly authService: AuthService,
    @Inject('REDIS_SERVICE') private readonly redis: typeof redisService,
  ) {}

  @SkipThrottle()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({
    status: 201,
    description: 'User successfully registered. Verification email sent.',
  })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async register(
    @Body() registerDto: RegisterDto,
  ): Promise<{ message: string; email: string }> {
    return this.authService.register(registerDto);
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

      // Type guard: Check if 2FA is required (shouldn't happen in OAuth flow)
      if ('requires2FA' in authResponse) {
        this.logger.log(`2FA required for OAuth user: ${authResponse.userId}`);
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

      // Redirect to frontend with session code
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
      }

      // Generate a secure one-time session code
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

      // Type guard: Check if 2FA is required (shouldn't happen in OAuth flow)
      if ('requires2FA' in authResponse) {
      this.logger.log(`2FA required for OAuth user: ${authResponse.userId}`);
      
      // Generate a secure one-time session code WITH 2FA info
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

      // Redirect to frontend with session code
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    }

      // Generate a secure one-time session code
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
        60, // 60 seconds TTL
      );

      // Redirect to frontend with session code
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

      // Type guard: Check if 2FA is required (shouldn't happen in OAuth flow)
      if ('requires2FA' in authResponse) {
      this.logger.log(`2FA required for OAuth user: ${authResponse.userId}`);
      
      // Generate a secure one-time session code WITH 2FA info
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

      // Redirect to frontend with session code
      const frontendUrl = process.env.FRONTEND_URL;
      return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
    }

      // Generate a secure one-time session code
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
        60, // 60 seconds TTL
      );

      // Redirect to frontend with session code
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
    description:
      'Exchanges a one-time session code received from OAuth callback for access and refresh tokens',
  })
  @ApiBody({ type: ExchangeCodeDto })
  @ApiResponse({
    status: 200,
    description: 'Returns access token, refresh token, and user information',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        userId: 'user-id-here',
        user: {
          id: 'user-id',
          email: 'user@example.com',
          name: 'John Doe',
        },
      },
    },
  })

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

    // Get tokens from Redis
    const sessionKey = `oauth:session:${code}`;
    const data = await this.redis.get(sessionKey);

    if (!data) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const sessionData = JSON.parse(data);

    // Verify not expired (extra safety check)
    if (Date.now() > sessionData.expiresAt) {
      await this.redis.del(sessionKey);
      throw new UnauthorizedException('Code has expired');
    }

    // Delete the code immediately (one-time use)
    await this.redis.del(sessionKey);

    // Log the token exchange for security audit
    this.logger.log(
      `Token exchange for user ${sessionData.userId} from ${ipAddress}`,
    );

    // Return tokens to client
    return {
      accessToken: sessionData.accessToken,
      refreshToken: sessionData.refreshToken,
      userId: sessionData.userId,
      user: sessionData.profile,
    };
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