// src/modules/auth/dto/invitation.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsEnum, IsArray, IsUUID, MinLength, MaxLength, Matches } from 'class-validator';
import { UserRole } from '@common/enums/index.enum';
import { Transform } from 'class-transformer';
import { IsValidPhone } from '@/common/decorators/index.decorator';
import { transformPhoneNumber } from '@/common/transformers/index.transformer';

const PASSWORD_REGEX = /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/;

export class CreateInvitationDto {
  @ApiProperty({ example: 'sara.ali@example.com' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER_USER })
  @IsEnum(UserRole)
  @IsNotEmpty()
  role: UserRole;

  // Required when role is CUSTOMER_ADMIN or CUSTOMER_USER.
  // Service validates: if customer-scoped role && !customerId → BadRequestException
  @ApiPropertyOptional({
    example: 'customer-uuid',
    description: 'Required for CUSTOMER_ADMIN and CUSTOMER_USER roles',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ example: 'Sara Ali' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  inviteeName?: string;

  @ApiPropertyOptional({ example: 'Looking forward to working with you!' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Message must not exceed 500 characters' })
  message?: string;

  // Pre-configure which custom roles the invited user gets on acceptance
  @ApiPropertyOptional({ example: ['role-uuid-1'] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  roleIds?: string[];

  // Pre-configure direct permission grants on acceptance
  @ApiPropertyOptional({ example: ['permission-uuid-1'] })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  permissionIds?: string[];
}

export class AcceptInvitationDto {
  @ApiProperty({ example: 'INVITE-TOKEN-12345' })
  @IsString()
  @IsNotEmpty({ message: 'Invitation token is required' })
  token: string;

  @ApiProperty({ example: 'Sara Ali' })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  name: string;

  // Same strength validation as RegisterDto — invited users are not exempt
  @ApiProperty({ example: 'SecurePass123!', minLength: 8 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @Matches(PASSWORD_REGEX, {
    message: 'Password must contain uppercase, lowercase, and number/special character',
  })
  password: string;

  @ApiPropertyOptional({ example: '+966501234567' })
  @IsOptional()
  @IsValidPhone()
  @Transform(({ value }) => transformPhoneNumber(value))
  phone?: string;
}

// Safe public response — strips internal tenant details
export class InvitationPublicDto {
  @ApiProperty({ example: 'invitation-uuid' })
  id: string;

  @ApiProperty({ example: 'sara.ali@example.com' })
  email: string;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiPropertyOptional({ example: 'Smart Life Solutions' })
  tenantName?: string;

  @ApiPropertyOptional({ example: 'King Fahd Hospital' })
  customerName?: string;

  @ApiPropertyOptional({ example: 'Ahmed Al-Saud' })
  inviterName?: string;

  @ApiPropertyOptional({ example: 'Sara Ali' })
  inviteeName?: string;

  @ApiProperty({ example: '2025-12-28T10:00:00.000Z' })
  expiresAt: Date;
}