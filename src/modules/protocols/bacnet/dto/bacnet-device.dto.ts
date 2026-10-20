// src/modules/protocols/bacnet/dto/bacnet-device.dto.ts
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { BacnetObjectTypeName } from '../entities/bacnet-device.entity';

export const BACNET_OBJECT_TYPES: BacnetObjectTypeName[] = [
  'analogInput',
  'analogOutput',
  'analogValue',
  'binaryInput',
  'binaryOutput',
  'binaryValue',
  'multiStateInput',
  'multiStateValue',
];

export const BACNET_PROPERTIES = [
  'presentValue',
  'statusFlags',
  'reliability',
  'outOfService',
] as const;

/** Device instance numbers are 22-bit; 4194303 is the "unknown" wildcard. */
const MAX_DEVICE_INSTANCE = 4_194_302;
/** Object instance numbers are 22-bit too. */
const MAX_OBJECT_INSTANCE = 4_194_303;

export class BacnetObjectMappingDto {
  @ApiProperty({ enum: BACNET_OBJECT_TYPES, example: 'analogInput' })
  @IsIn(BACNET_OBJECT_TYPES)
  objectType: BacnetObjectTypeName;

  @ApiProperty({ example: 1, minimum: 0, maximum: MAX_OBJECT_INSTANCE })
  @IsInt()
  @Min(0)
  @Max(MAX_OBJECT_INSTANCE)
  objectInstance: number;

  @ApiPropertyOptional({
    enum: BACNET_PROPERTIES,
    default: 'presentValue',
    description:
      'presentValue for a reading. statusFlags / reliability chart a point’s ' +
      'HEALTH rather than its value, which is how you spot a failed sensor ' +
      'that is still reporting a plausible number.',
  })
  @IsOptional()
  @IsIn(BACNET_PROPERTIES)
  property?: (typeof BACNET_PROPERTIES)[number];

  @ApiProperty({ example: 'supplyAirTemperature' })
  @IsString()
  @MaxLength(120)
  telemetryKey: string;

  @ApiPropertyOptional({ enum: ['string', 'number', 'boolean'] })
  @IsOptional()
  @IsIn(['string', 'number', 'boolean'])
  dataType?: 'string' | 'number' | 'boolean';

  @ApiPropertyOptional({
    description: 'Multiplier applied before storing, for raw scaled integers.',
  })
  @IsOptional()
  @IsNumber()
  scale?: number;

  @ApiPropertyOptional({ example: '°C' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;
}

export class CreateBacnetDeviceDto {
  @ApiProperty({ example: 'AHU-3 controller' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    example: '192.168.20.41',
    description:
      'UNICAST address of the controller. Not a broadcast address — a poll ' +
      'sent to 255.255.255.255 is answered by every controller on the subnet.',
  })
  @IsString()
  @MaxLength(200)
  address: string;

  @ApiPropertyOptional({ default: 47808, minimum: 1, maximum: 65535 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiProperty({
    example: 2001,
    minimum: 0,
    maximum: MAX_DEVICE_INSTANCE,
    description:
      'The device-instance number from the controller’s I-Am. Run the ' +
      'discovery route rather than guessing — it is not on the nameplate.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_DEVICE_INSTANCE)
  deviceInstance: number;

  @ApiPropertyOptional({
    description: 'Platform device the readings land on.',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Vendor id from the I-Am.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  vendorId?: number;

  @ApiPropertyOptional({ description: 'Max APDU the controller accepts.' })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(65535)
  maxApdu?: number;

  @ApiPropertyOptional({ type: [BacnetObjectMappingDto] })
  @IsOptional()
  @IsArray()
  // Capped: every object is a property in one ReadPropertyMultiple request,
  // and a BACnet APDU is commonly 1476 bytes. Past a few hundred the request
  // has to segment, which many field controllers do not support.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BacnetObjectMappingDto)
  objects?: BacnetObjectMappingDto[];

  @ApiPropertyOptional({
    default: 30000,
    minimum: 5000,
    maximum: 86400000,
    description:
      '5 s minimum. BACnet/IP is UDP on what is often a shared 10 Mbit ' +
      'field network, and a tight poll loop is how you take a BMS down.',
  })
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Max(86_400_000)
  pollIntervalMs?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'One ReadPropertyMultiple instead of N ReadProperty requests. The ' +
      'adapter falls back automatically and remembers, so this flag is only ' +
      'needed to force single reads from the start.',
  })
  @IsOptional()
  @IsBoolean()
  useReadPropertyMultiple?: boolean;

  @ApiPropertyOptional({ default: 6000, minimum: 1000, maximum: 60000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60_000)
  apduTimeoutMs?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateBacnetDeviceDto extends PartialType(CreateBacnetDeviceDto) {}

export class BacnetDiscoverDto {
  @ApiPropertyOptional({
    default: 5000,
    minimum: 1000,
    maximum: 30000,
    description:
      'How long I-Am answers are collected. Who-Is is an unconfirmed ' +
      'broadcast, so there is no "all devices have answered" signal — you ' +
      'listen, and whatever arrived is what is there.',
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(30_000)
  windowMs?: number;

  @ApiPropertyOptional({
    description:
      'Narrow the broadcast to a range of instance numbers. On a large site ' +
      'an unrestricted Who-Is can bring back hundreds of devices at once.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DEVICE_INSTANCE)
  lowLimit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DEVICE_INSTANCE)
  highLimit?: number;

  @ApiPropertyOptional({
    description:
      'Unicast target, for a controller behind a BBMD that does not forward ' +
      'broadcasts to this host.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Read each answering device’s objectName / modelName / vendorName so ' +
      'the list is readable. "Instance 2001" is not something an operator can ' +
      'match to a chiller.',
  })
  @IsOptional()
  @IsBoolean()
  describe?: boolean;
}
