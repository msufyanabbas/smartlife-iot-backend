// src/modules/auth/dto/exchange-code.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ExchangeCodeDto {
  @ApiProperty({
    description: 'One-time session code from OAuth callback URL',
    example: 'a1b2c3d4e5f6...', // randomBytes(32).toString('hex') = 64 chars
  })
  @IsString()
  @IsNotEmpty({ message: 'Code is required' })
  // randomBytes(32).toString('hex') always produces exactly 64 hex characters
  @Length(64, 64, { message: 'Invalid code format' })
  code: string;
}