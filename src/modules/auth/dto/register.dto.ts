import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  Matches,
  IsOptional,
} from 'class-validator';
import { IsValidPhone } from '@decorators/phone-validator.decorator';
import { transformPhoneNumber } from '@transformers/phone.transformer';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({
    example: 'John Doe',
    description: 'Full name of the user',
    minLength: 2,
  })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  name: string;

  @ApiProperty({
    example: 'user@example.com',
    description: 'User email address',
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @ApiProperty({
    example: 'Password123!',
    description:
      'User password (min 8 chars, must contain uppercase, lowercase, number)',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'Password must contain uppercase, lowercase, and number/special character',
  })
  password: string;

  @ApiProperty({
    example: '+1234567890',
    description: 'User phone number',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsValidPhone()
  @Transform(({ value }) => transformPhoneNumber(value))
  phone?: string;

   @ApiPropertyOptional({
    example: 'Smart Life Solutions',
    description:
      'Company/Organization name - creates a new tenant (leave empty to join existing tenant via invitation)',
    minLength: 2,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Company name must be at least 2 characters' })
  companyName?: string;

  @ApiPropertyOptional({
    example: 'INVITE-TOKEN-12345',
    description:
      'Invitation token to join an existing tenant or customer (optional)',
  })
  @IsOptional()
  @IsString()
  invitationToken?: string;
}
