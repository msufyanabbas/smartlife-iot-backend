import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsEnum,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetProfileType, ProfileFieldType } from '@common/enums/index.enum';

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE SCHEMA (type + fields)
// ─────────────────────────────────────────────────────────────────────────────

export class ProfileFieldOptionDto {
  @ApiProperty({ example: 'commercial', description: 'Stored value' })
  @IsString()
  @IsNotEmpty()
  value: string;

  @ApiProperty({ example: 'Commercial' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({ example: 'تجاري' })
  @IsString()
  @IsNotEmpty()
  labelAr: string;
}

export class ProfileFieldDto {
  @ApiProperty({ example: 'totalFloors', description: 'Key under Asset.configuration' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ example: 'Total Floors', description: 'English label' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({ example: 'إجمالي الطوابق', description: 'Arabic label' })
  @IsString()
  @IsNotEmpty()
  labelAr: string;

  @ApiProperty({
    type: String,
    enum: ProfileFieldType,
    enumName: 'ProfileFieldType',
    example: ProfileFieldType.NUMBER,
  })
  @IsEnum(ProfileFieldType)
  type: ProfileFieldType;

  @ApiProperty({ example: true })
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional({ example: 'Building Info', description: 'UI grouping' })
  @IsOptional()
  @IsString()
  group?: string;

  @ApiPropertyOptional({ example: 1, description: 'Display order within the form' })
  @IsOptional()
  @IsNumber()
  order?: number;

  @ApiPropertyOptional({
    type: [ProfileFieldOptionDto],
    description: "Allowed values — only for type 'select' / 'multiselect'",
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileFieldOptionDto)
  options?: ProfileFieldOptionDto[];

  @ApiPropertyOptional({ example: 1, description: "Minimum — only for type 'number'" })
  @IsOptional()
  @IsNumber()
  min?: number;

  @ApiPropertyOptional({ example: 200, description: "Maximum — only for type 'number'" })
  @IsOptional()
  @IsNumber()
  max?: number;

  @ApiPropertyOptional({ description: 'Value pre-filled on new assets' })
  @IsOptional()
  defaultValue?: any;

  @ApiPropertyOptional({ example: 'm²' })
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional({ example: 'e.g. Wheat, Tomatoes' })
  @IsOptional()
  @IsString()
  placeholder?: string;

  @ApiPropertyOptional({ example: 'مثل: قمح، طماطم' })
  @IsOptional()
  @IsString()
  placeholderAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  helpText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  helpTextAr?: string;
}

export class ProfileDeviceLinkingConfigDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  allowMultipleDevices: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Restrict to these DeviceType values',
    example: ['tracker', 'sensor'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deviceTypeFilter?: string[];

  @ApiPropertyOptional({ example: 1000 })
  @IsOptional()
  @IsNumber()
  maxDevices?: number;
}

export class ProfileSchemaDto {
  @ApiProperty({ type: [ProfileFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProfileFieldDto)
  fields: ProfileFieldDto[];

  @ApiPropertyOptional({ type: ProfileDeviceLinkingConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileDeviceLinkingConfigDto)
  deviceLinkingConfig?: ProfileDeviceLinkingConfigDto;
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

  @ApiPropertyOptional({
    type: String,
    enum: AssetProfileType,
    enumName: 'AssetProfileType',
    example: AssetProfileType.BUILDING,
    description: 'What kind of thing this profile describes',
  })
  @IsOptional()
  @IsEnum(AssetProfileType)
  type?: AssetProfileType;

  @ApiPropertyOptional({
    type: ProfileSchemaDto,
    description:
      'Fields assets of this profile carry. Values are stored in Asset.configuration.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileSchemaDto)
  schema?: ProfileSchemaDto;

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

  @ApiPropertyOptional({
    type: String,
    enum: AssetProfileType,
    enumName: 'AssetProfileType',
  })
  @IsOptional()
  @IsEnum(AssetProfileType)
  type?: AssetProfileType;

  @ApiPropertyOptional({ type: ProfileSchemaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProfileSchemaDto)
  schema?: ProfileSchemaDto;

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