import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerStatus } from '../entities/customers.entity';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Acme Corporation' })
  @IsString()
  title: string;

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
  title?: string;

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