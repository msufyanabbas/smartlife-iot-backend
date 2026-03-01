// src/modules/auth/dto/register.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength, Matches, IsOptional } from 'class-validator';
import { IsValidPhone } from '@decorators/index.decorator';
import { transformPhoneNumber } from '@transformers/index.transformer';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({ example: 'John Doe', minLength: 2 })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  name: string;

  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @ApiProperty({ example: 'Password123!', minLength: 8 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must contain uppercase, lowercase, and number/special character',
  })
  password: string;

  @ApiPropertyOptional({ example: '+966501234567' })
  @IsOptional()
  @IsValidPhone()
  @Transform(({ value }) => transformPhoneNumber(value))
  phone?: string;

  // Providing companyName → creates new tenant, user becomes TENANT_ADMIN.
  // companyName and invitationToken are mutually exclusive.
  // Service throws BadRequestException if neither or both are provided.
  @ApiPropertyOptional({
    example: 'Smart Life Solutions',
    description: 'Creates a new tenant. Mutually exclusive with invitationToken.',
    minLength: 2,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Company name must be at least 2 characters' })
  companyName?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4...',
    description: 'Joins an existing tenant. Mutually exclusive with companyName.',
  })
  @IsOptional()
  @IsString()
  invitationToken?: string;
}
