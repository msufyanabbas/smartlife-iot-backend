// src/modules/auth/dto/update-profile.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({
    description: 'User full name',
    example: 'Ahmed Al-Saud',
    minLength: 2,
    maxLength: 100,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  @MaxLength(100, { message: 'Name must not exceed 100 characters' })
  name?: string;

  @ApiProperty({
    description: 'User phone number (Saudi format)',
    example: '+966501234567',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Phone number must be a valid international format',
  })
  phone?: string;
}