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
  IsIn,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  DeviceTransportType,
  DeviceProvisionType,
} from '@common/enums/index.enum';
import { AlarmSeverity, ProcessingStrategy, QueueName, SubmitStrategy } from '@common/enums/index.enum';

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

  @ApiPropertyOptional({
    type: String,
    enum: DeviceTransportType,
    enumName: 'DeviceTransportType',
    default: DeviceTransportType.DEFAULT,
    description:
      'When omitted the profile defaults to DEFAULT. Supplying MQTT / HTTP / COAP ' +
      'auto-populates transportConfiguration unless one is given explicitly.',
  })
  @IsOptional()
  @IsIn(Object.values(DeviceTransportType))
  transportType?: DeviceTransportType;

  @ApiPropertyOptional({
    type: String,
    enum: DeviceProvisionType,
    enumName: 'DeviceProvisionType',
    default: DeviceProvisionType.DISABLED,
  })
  @IsOptional()
  @IsIn(Object.values(DeviceProvisionType))
  provisionType?: DeviceProvisionType;

  @ApiPropertyOptional({
    description: 'Protocol-specific settings, keyed by protocol (mqtt/http/coap/lwm2m).',
    example: {
      mqtt: {
        deviceTelemetryTopic: 'v1/devices/me/telemetry',
        devicePayloadType: 'JSON',
      },
    },
  })
  @IsOptional()
  @IsObject()
  transportConfiguration?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Shared provisioning key for this profile' })
  @IsOptional()
  @IsString()
  provisionDeviceKey?: string;

  @ApiPropertyOptional({ description: 'Shared provisioning secret for this profile' })
  @IsOptional()
  @IsString()
  provisionDeviceSecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  profileData?: any;

  @ApiPropertyOptional()
  @IsOptional()
  telemetryConfig?: any;

  @ApiPropertyOptional()
  @IsOptional()
  attributesConfig?: any;

  @ApiPropertyOptional({
    type: [Object],
    description:
      'Alarm rule templates. Evaluated on every telemetry message for devices ' +
      'using this profile — see DeviceProfileAlarmRule.',
  })
  @IsOptional()
  @IsArray()
  alarmRules?: any[];

  @ApiPropertyOptional({ deprecated: true, description: 'Legacy — use provisionDeviceKey/Secret' })
  @IsOptional()
  provisionConfiguration?: any;

  @ApiPropertyOptional({ description: 'Firmware/OTA package for this profile' })
  @IsOptional()
  @IsObject()
  firmwareConfig?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultRuleChainId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  defaultDashboardId?: string;

  @ApiPropertyOptional({ description: 'Kafka queue for this profile telemetry' })
  @IsOptional()
  @IsString()
  queueName?: string;

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
) { }

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
  @ApiProperty({ type: String, enum: SubmitStrategy, enumName: 'SubmitStrategy' })
  @IsEnum(SubmitStrategy)
  submitStrategy: SubmitStrategy;

  @ApiProperty({ type: String, enum: ProcessingStrategy, enumName: 'ProcessingStrategy' })
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

  @ApiProperty({ type: String, enum: AlarmSeverity, enumName: 'AlarmSeverity' })
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
