import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsOptional } from 'class-validator';

export enum OAuthProvider {
  GOOGLE = 'google',
  GITHUB = 'github',
  APPLE = 'apple',
}

export class OAuthCallbackDto {
  @ApiProperty({
    example: 'google',
    description: 'OAuth provider',
    enum: OAuthProvider,
  })
  @IsEnum(OAuthProvider)
  @IsNotEmpty()
  provider: OAuthProvider;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'OAuth access token from provider',
  })
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'OAuth refresh token from provider (optional)',
    required: false,
  })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}
