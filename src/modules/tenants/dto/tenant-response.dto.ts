import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantStatus } from '../entities/tenant.entity';

// ==================== TENANT RESPONSE DTO ====================

export class TenantResponseDto {
  @ApiProperty({ example: 'tenant-id-123' })
  id: string;

  @ApiProperty({ example: 'acme-corp' })
  name: string;

  @ApiPropertyOptional({ example: 'Acme Corporation' })
  title?: string;

  @ApiPropertyOptional({ example: 'Leading IoT solutions provider' })
  description?: string;

  @ApiProperty({ example: 'admin@acmecorp.com' })
  email: string;

  @ApiPropertyOptional({ example: '+1-555-0123' })
  phone?: string;

  @ApiPropertyOptional({ example: 'United States' })
  country?: string;

  @ApiPropertyOptional({ example: 'California' })
  state?: string;

  @ApiPropertyOptional({ example: 'San Francisco' })
  city?: string;

  @ApiPropertyOptional({ example: '123 Main St' })
  address?: string;

  @ApiPropertyOptional({ example: 'Suite 100' })
  address2?: string;

  @ApiPropertyOptional({ example: '94102' })
  zip?: string;

  @ApiProperty({ enum: TenantStatus, example: TenantStatus.ACTIVE })
  status: TenantStatus;

  @ApiPropertyOptional({
    example: {
      logo: 'https://acmecorp.com/logo.png',
      website: 'https://acmecorp.com',
      industry: 'Manufacturing',
    },
  })
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional({
    example: {
      maxDevices: 1000,
      maxUsers: 50,
      maxDashboards: 20,
      dataRetentionDays: 365,
    },
  })
  configuration?: Record<string, any>;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

// ==================== TENANT LIST RESPONSE DTO ====================

export class TenantListResponseDto {
  @ApiProperty({ type: [TenantResponseDto] })
  data: TenantResponseDto[];

  @ApiProperty({
    example: {
      total: 100,
      page: 1,
      limit: 10,
      totalPages: 10,
    },
  })
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

// ==================== TENANT STATISTICS DTO ====================

export class TenantStatisticsDto {
  @ApiProperty({ example: 50 })
  totalTenants: number;

  @ApiProperty({ example: 45 })
  activeTenants: number;

  @ApiProperty({ example: 3 })
  suspendedTenants: number;

  @ApiProperty({ example: 2 })
  inactiveTenants: number;

  @ApiProperty({
    example: {
      'Manufacturing': 20,
      'Healthcare': 15,
      'Retail': 10,
      'Other': 5,
    },
  })
  byIndustry?: Record<string, number>;

  @ApiProperty({
    example: {
      'United States': 30,
      'United Kingdom': 10,
      'Germany': 5,
      'Others': 5,
    },
  })
  byCountry?: Record<string, number>;
}

// ==================== TENANT USAGE DTO ====================

export class TenantUsageDto {
  @ApiProperty({ example: 'tenant-id-123' })
  tenantId: string;

  @ApiProperty({
    example: {
      current: 750,
      limit: 1000,
      percentage: 75,
    },
  })
  devices: {
    current: number;
    limit: number;
    percentage: number;
  };

  @ApiProperty({
    example: {
      current: 35,
      limit: 50,
      percentage: 70,
    },
  })
  users: {
    current: number;
    limit: number;
    percentage: number;
  };

  @ApiProperty({
    example: {
      current: 15,
      limit: 20,
      percentage: 75,
    },
  })
  dashboards: {
    current: number;
    limit: number;
    percentage: number;
  };

  @ApiPropertyOptional({
    example: {
      current: 100,
      limit: 500,
      percentage: 20,
    },
  })
  assets?: {
    current: number;
    limit: number;
    percentage: number;
  };

  @ApiPropertyOptional({
    example: {
      current: 25,
      limit: 50,
      percentage: 50,
    },
  })
  ruleChains?: {
    current: number;
    limit: number;
    percentage: number;
  };

  @ApiProperty({ example: 5242880 }) // 5MB in bytes
  storageUsed: number;

  @ApiProperty()
  lastUpdated: Date;
}

// ==================== SIMPLE MESSAGE RESPONSE DTO ====================

export class TenantMessageResponseDto {
  @ApiProperty({ example: 'Operation completed successfully' })
  message: string;

  @ApiPropertyOptional({ type: TenantResponseDto })
  data?: TenantResponseDto;
}