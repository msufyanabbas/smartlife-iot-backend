import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { TwoFactorAuthService } from './two-factor-auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Two-Factor Authentication')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('2fa')
export class TwoFactorAuthController {
  constructor(private readonly twoFactorAuthService: TwoFactorAuthService) {}

  // ==================== GET SETTINGS ====================

  @Get('settings')
  @ApiOperation({ summary: 'Get 2FA settings' })
  @ApiResponse({
    status: 200,
    description: '2FA settings retrieved',
    schema: {
      example: {
        isEnabled: true,
        method: 'authenticator',
        phoneNumber: '****1234',
        phoneVerified: true,
        hasBackupCodes: true,
      },
    },
  })
  async getSettings(@CurrentUser() user: User) {
    return this.twoFactorAuthService.getSettings(user.id);
  }

  // ==================== AUTHENTICATOR SETUP ====================

  @Post('authenticator/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generate authenticator secret and QR code' })
  @ApiResponse({
    status: 200,
    description: 'QR code and secret generated',
    schema: {
      example: {
        secret: 'JBSWY3DPEHPK3PXP',
        qrCode: 'data:image/png;base64,...',
        manualEntryKey: 'JBSWY3DPEHPK3PXP',
      },
    },
  })
  async generateAuthenticatorSecret(@CurrentUser() user: User) {
    return this.twoFactorAuthService.generateAuthenticatorSecret(user.id);
  }

  @Post('authenticator/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable authenticator 2FA' })
  @ApiResponse({
    status: 200,
    description: 'Authenticator 2FA enabled',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid verification code',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
      },
      required: ['code'],
    },
  })
  async enableAuthenticator(
    @CurrentUser() user: User,
    @Body('code') code: string,
  ) {
    return this.twoFactorAuthService.enableAuthenticator(user.id, code);
  }

  // ==================== SMS SETUP ====================

  @Post('sms/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Setup SMS 2FA with phone number' })
  @ApiResponse({
    status: 200,
    description: 'Verification code sent',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid phone number',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        phoneNumber: { type: 'string', example: '+966501234567' },
      },
      required: ['phoneNumber'],
    },
  })
  async setupSMS(
    @CurrentUser() user: User,
    @Body('phoneNumber') phoneNumber: string,
  ) {
    return this.twoFactorAuthService.setupSMS(user.id, phoneNumber);
  }

  @Post('sms/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend SMS verification code' })
  @ApiResponse({
    status: 200,
    description: 'Code sent',
  })
  async resendSMSCode(@CurrentUser() user: User) {
    await this.twoFactorAuthService.sendSMSCode(user.id);
    return { message: 'Verification code sent' };
  }

  @Post('sms/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable SMS 2FA' })
  @ApiResponse({
    status: 200,
    description: 'SMS 2FA enabled',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid verification code',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
      },
      required: ['code'],
    },
  })
  async enableSMS(@CurrentUser() user: User, @Body('code') code: string) {
    return this.twoFactorAuthService.enableSMS(user.id, code);
  }

  // ==================== EMAIL SETUP ====================

  @Post('email/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send email verification code' })
  @ApiResponse({
    status: 200,
    description: 'Code sent',
  })
  async sendEmailCode(@CurrentUser() user: User) {
    await this.twoFactorAuthService.sendEmailCode(user.id);
    return { message: 'Verification code sent to your email' };
  }

  @Post('email/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable email 2FA' })
  @ApiResponse({
    status: 200,
    description: 'Email 2FA enabled',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid verification code',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
      },
      required: ['code'],
    },
  })
  async enableEmail(@CurrentUser() user: User, @Body('code') code: string) {
    return this.twoFactorAuthService.enableEmail(user.id, code);
  }

  // ==================== DISABLE 2FA ====================

  @Post('disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA' })
  @ApiResponse({
    status: 200,
    description: '2FA disabled',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid verification code',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
      },
      required: ['code'],
    },
  })
  async disable(@CurrentUser() user: User, @Body('code') code: string) {
    return this.twoFactorAuthService.disable(user.id, code);
  }

  // ==================== BACKUP CODES ====================

  @Post('backup-codes/regenerate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate backup codes' })
  @ApiResponse({
    status: 200,
    description: 'Backup codes regenerated',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid verification code',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', example: '123456' },
      },
      required: ['code'],
    },
  })
  async regenerateBackupCodes(
    @CurrentUser() user: User,
    @Body('code') code: string,
  ) {
    return this.twoFactorAuthService.regenerateBackupCodes(user.id, code);
  }
}