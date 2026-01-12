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
} from '../entities/device-profile.entity';
import { AlarmSeverity, ProcessingStrategy, QueueName, SubmitStrategy } from '../entities/asset-profile.entity';

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

// Asset Profile DTOs
export class CreateAssetProfileDto {
  @ApiProperty({ example: 'Smart Building Profile' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Profile for commercial buildings' })
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

  @ApiPropertyOptional({ example: 'https://example.com/building-icon.png' })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  hierarchyConfig?: {
    allowChildren: boolean;
    allowedChildTypes?: string[];
    requireParent?: boolean;
    allowedParentTypes?: string[];
    maxDepth?: number;
    inheritAttributesFromParent?: boolean;
    inheritDevicesFromParent?: boolean;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  locationConfig?: {
    required: boolean;
    requireAddress?: boolean;
    requireCoordinates?: boolean;
    allowManualEntry?: boolean;
    defaultZoom?: number;
    restrictToRegion?: {
      northEast?: { lat: number; lng: number };
      southWest?: { lat: number; lng: number };
    };
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  mapConfig?: {
    icon?: string;
    iconColor?: string;
    markerType?: 'pin' | 'circle' | 'square' | 'custom';
    showLabel?: boolean;
    labelField?: string;
    clusterThreshold?: number;
    popupTemplate?: string;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  deviceConfig?: {
    allowDevices: boolean;
    maxDevices?: number;
    allowedDeviceProfileIds?: string[];
    requireDevices?: boolean;
    minDevices?: number;
    inheritDevicesToChildren?: boolean;
    autoAssignByLocation?: boolean;
    locationProximityMeters?: number;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributesSchema?: {
  required: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
    description?: string;
    validation?: Record<string, any>; // Change this line
    options?: Array<{ label: string; value: any }>;
    defaultValue?: any;
  }>;
  optional: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
    description?: string;
    defaultValue?: any;
    options?: Array<{ label: string; value: any }>;
    validation?: Record<string, any>; // Change this line
  }>;
};

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  serverAttributeKeys?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  sharedAttributeKeys?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  calculatedFields?: Array<{
    id: string;
    name: string;
    type: 'number' | 'string' | 'boolean';
    expression: string;
    description?: string;
    unit?: string;
    decimalPlaces?: number;
    updateInterval?: number;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultEdgeRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultQueueName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  queueConfig?: {
    submitStrategy: string;
    processingStrategy: string;
    packProcessingTimeout?: number;
    submitStrategyCustom?: any;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mobileDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: {
      condition: any;
      spec?: any;
    };
    clearCondition?: {
      condition: any;
      spec?: any;
    };
    propagateToParent?: boolean;
    propagateToChildren?: boolean;
    schedule?: any;
    alarmDetails?: string;
    dashboardId?: string;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  versionControl?: {
    enabled: boolean;
    repositoryUrl?: string;
    branch?: string;
    readOnly?: boolean;
    showMergeCommits?: boolean;
    authMethod?: 'password' | 'ssh' | 'token';
    username?: string;
  };
}

export class UpdateAssetProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  hierarchyConfig?: {
    allowChildren: boolean;
    allowedChildTypes?: string[];
    requireParent?: boolean;
    allowedParentTypes?: string[];
    maxDepth?: number;
    inheritAttributesFromParent?: boolean;
    inheritDevicesFromParent?: boolean;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  locationConfig?: {
    required: boolean;
    requireAddress?: boolean;
    requireCoordinates?: boolean;
    allowManualEntry?: boolean;
    defaultZoom?: number;
    restrictToRegion?: {
      northEast?: { lat: number; lng: number };
      southWest?: { lat: number; lng: number };
    };
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  mapConfig?: {
    icon?: string;
    iconColor?: string;
    markerType?: 'pin' | 'circle' | 'square' | 'custom';
    showLabel?: boolean;
    labelField?: string;
    clusterThreshold?: number;
    popupTemplate?: string;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  deviceConfig?: {
    allowDevices: boolean;
    maxDevices?: number;
    allowedDeviceProfileIds?: string[];
    requireDevices?: boolean;
    minDevices?: number;
    inheritDevicesToChildren?: boolean;
    autoAssignByLocation?: boolean;
    locationProximityMeters?: number;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributesSchema?: {
  required: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
    description?: string;
    validation?: Record<string, any>; // Change this line
    options?: Array<{ label: string; value: any }>;
    defaultValue?: any;
  }>;
  optional: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
    description?: string;
    defaultValue?: any;
    options?: Array<{ label: string; value: any }>;
    validation?: Record<string, any>; // Change this line
  }>;
};

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  serverAttributeKeys?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  sharedAttributeKeys?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  calculatedFields?: Array<{
    id: string;
    name: string;
    type: 'number' | 'string' | 'boolean';
    expression: string;
    description?: string;
    unit?: string;
    decimalPlaces?: number;
    updateInterval?: number;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultEdgeRuleChainId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultQueueName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  queueConfig?: {
    submitStrategy: string;
    processingStrategy: string;
    packProcessingTimeout?: number;
    submitStrategyCustom?: any;
  };

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mobileDashboardId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: any;
    clearCondition?: any;
    propagateToParent?: boolean;
    propagateToChildren?: boolean;
    schedule?: any;
    alarmDetails?: string;
    dashboardId?: string;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  additionalInfo?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  versionControl?: any;
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
