import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsInt,
  IsArray,
  MinLength,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CustomerStatus } from '@common/enums/index.enum';

// ─── Nested ──────────────────────────────────────────────────────────────────

export class AllocatedLimitsDto {
  @ApiPropertyOptional({ example: 50, description: 'Max devices for this customer (null = no cap)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  devices?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  dashboards?: number;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  assets?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  floorPlans?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  automations?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  users?: number;
}

// ─── Create ───────────────────────────────────────────────────────────────────

export class CreateCustomerDto {
  @ApiProperty({ example: 'Acme Corporation' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'contact@acme.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: '+966123456789' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'Main customer for IoT solutions' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'Saudi Arabia' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Riyadh Region' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'King Fahd Road, Building 123' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiPropertyOptional({ type: AllocatedLimitsDto, description: 'Resource quotas for this customer. Omit a field to apply no customer-level cap.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AllocatedLimitsDto)
  allocatedLimits?: AllocatedLimitsDto;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'Acme Corporation Updated' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'contact@acme.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+966123456789' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'Saudi Arabia' })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: 'Riyadh Region' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: 'Riyadh' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'King Fahd Road, Building 123' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '12345' })
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiPropertyOptional({ enum: CustomerStatus })
  @IsOptional()
  @IsEnum(CustomerStatus)
  status?: CustomerStatus;

  @ApiPropertyOptional({ type: AllocatedLimitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AllocatedLimitsDto)
  allocatedLimits?: AllocatedLimitsDto;
}

// ─── Bulk status update ───────────────────────────────────────────────────────

export class BulkUpdateCustomerStatusDto {
  @ApiProperty({ example: ['customer-id-1', 'customer-id-2'] })
  @IsArray()
  @IsString({ each: true })
  customerIds: string[];

  @ApiProperty({ enum: CustomerStatus })
  @IsEnum(CustomerStatus)
  status: CustomerStatus;
}

// ─── Permission grants ────────────────────────────────────────────────────────

export class GrantCustomerPermissionsDto {
  @ApiProperty({
    example: ['permission-id-1', 'permission-id-2'],
    description: 'Full set of permission IDs to grant to this customer. Replaces any existing grants.',
  })
  @IsArray()
  @IsString({ each: true })
  permissionIds: string[];
}

// ─── User assignment ──────────────────────────────────────────────────────────

export class AssignUserToCustomerDto {
  @ApiProperty({ example: 'user-id-here' })
  @IsString()
  userId: string;
}

// ─── Invitation / password setup ─────────────────────────────────────────────

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