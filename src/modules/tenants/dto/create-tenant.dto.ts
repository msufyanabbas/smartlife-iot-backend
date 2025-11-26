import {
  IsString,
  IsEmail,
  IsOptional,
  IsObject,
  IsEnum,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TenantStatus } from '../entities/tenant.entity';

export class CreateTenantDto {
  @ApiProperty({ example: 'acme-corp' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Acme Corporation', required: false })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ example: 'Leading IoT solutions provider', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'admin@acmecorp.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '+1-555-0123', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 'United States', required: false })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ example: 'California', required: false })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ example: 'San Francisco', required: false })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ example: '123 Main St', required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ example: 'Suite 100', required: false })
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiProperty({ example: '94102', required: false })
  @IsOptional()
  @IsString()
  zip?: string;

  @ApiProperty({
    example: {
      logo: 'https://acmecorp.com/logo.png',
      website: 'https://acmecorp.com',
      industry: 'Manufacturing',
    },
    required: false,
  })
  @IsOptional()
  @IsObject()
  additionalInfo?: {
    logo?: string;
    website?: string;
    industry?: string;
    employeeCount?: number;
  };

  @ApiProperty({
    example: {
      maxDevices: 1000,
      maxUsers: 50,
      maxDashboards: 20,
      dataRetentionDays: 365,
    },
    required: false,
  })
  @IsOptional()
  @IsObject()
  configuration?: {
    maxDevices?: number;
    maxUsers?: number;
    maxAssets?: number;
    maxDashboards?: number;
    maxRuleChains?: number;
    dataRetentionDays?: number;
    features?: string[];
  };

  @ApiProperty({ enum: TenantStatus, required: false })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;
}
