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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly authService: AuthService, @Inject('REDIS_SERVICE') private readonly redis: typeof redisService) {}

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
  ): Promise<AuthResponseDto> {
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
    status: 200,
    description: 'Successfully authenticated with Google',
    type: AuthResponseDto,
  })
  async googleAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    const profile = req.user as any;
    const authResponse = await this.authService.googleLogin(
      profile,
      ipAddress,
      userAgent,
    );

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

    // Redirect to frontend with tokens
    const frontendUrl = process.env.FRONTEND_URL;
    return res.redirect(`${frontendUrl}/auth/callback?code=${sessionCode}`);
  }

  @Post('exchange-code')
  async exchangeCode(
    @Body('code') code: string,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
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
      user: sessionData.userId,
      profile: sessionData.profile
    };
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
    status: 200,
    description: 'Successfully authenticated with GitHub',
    type: AuthResponseDto,
  })
  async githubAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    const profile = req.user as any;
    const authResponse = await this.authService.githubLogin(
      profile,
      ipAddress,
      userAgent,
    );

    // Redirect to frontend with tokens
    const frontendUrl = process.env.FRONTEND_URL;
    const redirectUrl = `${frontendUrl}/auth/callback?token=${authResponse.accessToken}&refreshToken=${authResponse.refreshToken}`;

    return res.redirect(redirectUrl);
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
    status: 200,
    description: 'Successfully authenticated with Apple',
    type: AuthResponseDto,
  })
  async appleAuthCallback(
    @Req() req: Request,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
    @Res() res: Response,
  ) {
    const profile = req.user as any;
    const authResponse = await this.authService.appleLogin(
      profile,
      ipAddress,
      userAgent,
    );

    // Redirect to frontend with tokens
    const frontendUrl = process.env.FRONTEND_URL;
    const redirectUrl = `${frontendUrl}/auth/callback?token=${authResponse.accessToken}&refreshToken=${authResponse.refreshToken}`;

    return res.redirect(redirectUrl);
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
}
