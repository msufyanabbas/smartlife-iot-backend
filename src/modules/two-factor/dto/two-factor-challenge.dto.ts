import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsPhoneNumber, IsString } from 'class-validator';
export class VerifyCodeDto {
  @ApiProperty({ 
    example: '123456',
    description: '6-digit verification code'
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}

// ==================== PHONE NUMBER DTO ====================

export class SetupSMSDto {
  @ApiProperty({ 
    example: '+966501234567',
    description: 'Phone number in E.164 format'
  })
  @IsPhoneNumber()
  @IsNotEmpty()
  phoneNumber: string;
}

// ==================== RESPONSE DTOs ====================

export class TwoFactorSettingsResponseDto {
  @ApiProperty({ example: true })
  isEnabled: boolean;

  @ApiPropertyOptional({ example: 'authenticator', enum: ['authenticator', 'sms', 'email'] })
  method?: string;

  @ApiPropertyOptional({ example: '****1234' })
  phoneNumber?: string;

  @ApiPropertyOptional({ example: true })
  phoneVerified?: boolean;

  @ApiProperty({ example: true })
  hasBackupCodes: boolean;
}

export class AuthenticatorSecretResponseDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP' })
  secret: string;

  @ApiProperty({ example: 'data:image/png;base64,...' })
  qrCode: string;

  @ApiProperty({ example: 'JBSWY3DPEHPK3PXP' })
  manualEntryKey: string;
}

export class BackupCodesResponseDto {
  @ApiProperty({ 
    example: ['ABCD-1234', 'EFGH-5678', 'IJKL-9012'],
    type: [String]
  })
  backupCodes: string[];

  @ApiProperty({ example: 'Store these codes in a safe place' })
  message: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Operation completed successfully' })
  message: string;
}

export class TwoFactorChallengeDto {
  @ApiProperty({ example: true })
  requires2FA: boolean;

  @ApiProperty({ example: 'user-id-123' })
  userId: string;

  @ApiProperty({ example: 'authenticator' })
  method: string;
}