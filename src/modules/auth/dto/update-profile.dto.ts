// src/modules/auth/dto/profile.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsValidPhone } from '@common/decorators/index.decorator';
import { transformPhoneNumber } from '@transformers/index.transformer';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ahmed Al-Saud', minLength: 2, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  @MaxLength(100, { message: 'Name must not exceed 100 characters' })
  name?: string;

  // Uses the shared IsValidPhone validator — consistent with RegisterDto
  @ApiPropertyOptional({ example: '+966501234567' })
  @IsOptional()
  @IsValidPhone()
  @Transform(({ value }) => transformPhoneNumber(value))
  phone?: string;

  // Merged with existing user.preferences in service — not replaced wholesale
  @ApiPropertyOptional({
    example: { theme: 'dark', language: 'ar', notificationsEnabled: true },
    description: 'UI preferences — merged with existing values',
  })
  @IsOptional()
  preferences?: Record<string, any>;
}