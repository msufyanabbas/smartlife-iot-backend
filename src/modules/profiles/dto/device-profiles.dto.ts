import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsObject,
  IsNumber,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  DeviceTransportType,
  DeviceProvisionType,
} from '../enums/device-profile.enum';
import { AlarmSeverity, ProcessingStrategy, QueueName, SubmitStrategy } from '../enums/asset-profile.enum';

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

export class HierarchyConfigDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  allowChildren: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedChildTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireParent?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedParentTypes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxDepth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inheritAttributesFromParent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inheritDevicesFromParent?: boolean;
}

export class LocationConfigDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireAddress?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requireCoordinates?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowManualEntry?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsNumber()
  defaultZoom?: number;
}

export class MapConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iconColor?: string;

  @ApiPropertyOptional({ enum: ['pin', 'circle', 'square', 'custom'] })
  @IsOptional()
  @IsString()
  markerType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showLabel?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  labelField?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  clusterThreshold?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  popupTemplate?: string;
}

export class DeviceConfigDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  allowDevices: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  maxDevices?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  allowedDeviceProfileIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireDevices?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  minDevices?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  inheritDevicesToChildren?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoAssignByLocation?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  locationProximityMeters?: number;
}

export class AttributeSchemaFieldDto {
  @ApiProperty()
  @IsString()
  key: string;

  @ApiProperty()
  @IsString()
  label: string;

  @ApiProperty({ enum: ['string', 'number', 'boolean', 'date', 'json', 'select'] })
  @IsEnum(['string', 'number', 'boolean', 'date', 'json', 'select'])
  type: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  validation?: any;

  @ApiPropertyOptional()
  @IsOptional()
  options?: Array<{ label: string; value: any }>;

  @ApiPropertyOptional()
  @IsOptional()
  defaultValue?: any;
}

export class AttributesSchemaDto {
  @ApiProperty({ type: [AttributeSchemaFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeSchemaFieldDto)
  required: AttributeSchemaFieldDto[];

  @ApiProperty({ type: [AttributeSchemaFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeSchemaFieldDto)
  optional: AttributeSchemaFieldDto[];
}

export class CalculatedFieldDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ enum: ['number', 'string', 'boolean'] })
  @IsEnum(['number', 'string', 'boolean'])
  type: string;

  @ApiProperty()
  @IsString()
  expression: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  decimalPlaces?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  updateInterval?: number;
}

export class QueueConfigDto {
  @ApiProperty({ enum: SubmitStrategy })
  @IsEnum(SubmitStrategy)
  submitStrategy: SubmitStrategy;

  @ApiProperty({ enum: ProcessingStrategy })
  @IsEnum(ProcessingStrategy)
  processingStrategy: ProcessingStrategy;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  packProcessingTimeout?: number;
}

export class AlarmRuleDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  alarmType: string;

  @ApiProperty({ enum: AlarmSeverity })
  @IsEnum(AlarmSeverity)
  severity: AlarmSeverity;

  @ApiProperty()
  @IsObject()
  createCondition: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  clearCondition?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  propagateToParent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  propagateToChildren?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  schedule?: any;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  alarmDetails?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dashboardId?: string;
}


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
