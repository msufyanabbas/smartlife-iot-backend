// src/modules/auth/dto/oauth.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, IsOptional } from 'class-validator';
import { OAuthProviderEnum } from '@common/enums/index.enum';

export class OAuthCallbackDto {
  // Uses central enum — NOT redefined locally
  @ApiProperty({ enum: OAuthProviderEnum, example: OAuthProviderEnum.GOOGLE })
  @IsEnum(OAuthProviderEnum)
  @IsNotEmpty()
  provider: OAuthProviderEnum;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiPropertyOptional({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

export class VerifyOAuth2FADto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty({ message: '2FA code is required' })
  code: string;
}