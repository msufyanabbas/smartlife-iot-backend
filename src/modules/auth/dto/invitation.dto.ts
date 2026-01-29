// src/modules/auth/dto/invitation.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsEnum } from 'class-validator';
import { UserRole } from '@common/enums/index.enum';

export class CreateInvitationDto {
  @ApiProperty({
    example: 'sara.ali@example.com',
    description: 'Email address to send invitation to',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: UserRole.CUSTOMER_USER,
    description: 'Role to assign to the invited user',
    enum: UserRole,
  })
  @IsEnum(UserRole)
  @IsNotEmpty()
  role: UserRole;

  @ApiPropertyOptional({
    example: 'customer-uuid',
    description: 'Customer ID (required for CUSTOMER_ADMIN and CUSTOMER_USER roles)',
  })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({
    example: 'Sara Ali',
    description: 'Name of the person being invited (optional)',
  })
  @IsOptional()
  @IsString()
  inviteeName?: string;
}

export class AcceptInvitationDto {
  @ApiProperty({
    example: 'INVITE-TOKEN-12345',
    description: 'Invitation token received via email',
  })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({
    example: 'Sara Ali',
    description: 'Full name',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'SecurePass123!',
    description: 'Password',
    minLength: 8,
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}