import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsBoolean,
  IsNotEmpty,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerStatus } from '@common/enums/index.enum';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Acme Corporation' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Saudi Arabia' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'King Fahd Road' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'Building 123' })
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiPropertyOptional({ example: '+966123456789' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'contact@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty()
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ example: 'Main customer for IoT solutions' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: { industry: 'Manufacturing' } })
  @IsOptional()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({ example: false, default: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'Acme Corporation Updated' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Saudi Arabia' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'King Fahd Road' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'Building 123' })
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiPropertyOptional({ example: '+966123456789' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'contact@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: { industry: 'Retail' } })
  @IsOptional()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class BulkUpdateCustomerStatusDto {
  @ApiProperty({ example: ['customer-id-1', 'customer-id-2'] })
  @IsString({ each: true })
  customerIds: string[];

  @ApiProperty({ enum: CustomerStatus })
  @IsEnum(CustomerStatus)
  status: CustomerStatus;
}

export class AssignUserToCustomerDto {
  @ApiProperty({ example: 'user-id-here' })
  @IsString()
  userId: string;
}

// ─── inline DTO (or move to customers.dto.ts) ─────────────────────────────────
export class SetCustomerPasswordDto {
  @ApiProperty({ description: 'Token from the invitation email' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'SecurePass123!', minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message: 'Password must contain uppercase, lowercase, and number/special char',
  })
  password: string;
}