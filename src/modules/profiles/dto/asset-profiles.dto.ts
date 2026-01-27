import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsNotEmpty,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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