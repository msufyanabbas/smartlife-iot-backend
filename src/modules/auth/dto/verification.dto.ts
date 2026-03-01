// src/modules/auth/dto/verification.dto.ts
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { Transform as Tr } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ example: 'VERIFY-TOKEN-12345', description: 'Token from verification email' })
  @IsString()
  @IsNotEmpty({ message: 'Verification token is required' })
  token: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Tr(({ value }) => value?.toLowerCase().trim())
  email: string;
}