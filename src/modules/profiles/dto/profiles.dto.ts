import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  DeviceTransportType,
  DeviceProvisionType,
} from '../entities/device-profile.entity';

// Device Profile DTOs
export class CreateDeviceProfileDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ enum: DeviceTransportType, default: DeviceTransportType.MQTT })
  @IsEnum(DeviceTransportType)
  transportType: DeviceTransportType;

  @ApiProperty({
    enum: DeviceProvisionType,
    default: DeviceProvisionType.DISABLED,
  })
  @IsEnum(DeviceProvisionType)
  provisionType: DeviceProvisionType;

  @ApiPropertyOptional()
  @IsOptional()
  transportConfiguration?: any;

  @ApiPropertyOptional()
  @IsOptional()
  profileData?: any;

  @ApiPropertyOptional()
  @IsOptional()
  telemetryConfig?: any;

  @ApiPropertyOptional()
  @IsOptional()
  attributesConfig?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  alarmRules?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  provisionConfiguration?: any;

  @ApiPropertyOptional()
  @IsOptional()
  firmwareConfiguration?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultQueueName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  additionalInfo?: Record<string, any>;
}

export class UpdateDeviceProfileDto extends PartialType(
  CreateDeviceProfileDto,
) {}

// Asset Profile DTOs
export class CreateAssetProfileDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  attributesConfig?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultQueueName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  alarmRules?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  customFields?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  metadataSchema?: any;

  @ApiPropertyOptional()
  @IsOptional()
  additionalInfo?: Record<string, any>;
}

export class UpdateAssetProfileDto extends PartialType(CreateAssetProfileDto) {}

export class QueryProfilesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  default?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  limit?: number;
}
