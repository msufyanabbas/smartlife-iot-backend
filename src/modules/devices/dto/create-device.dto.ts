import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsLatitude,
  IsLongitude,
  IsObject,
  MaxLength,
  IsArray,
} from 'class-validator';
import { DeviceType, DeviceConnectionType } from '@common/enums/index.enum';
import { DeviceProtocol } from '../entities/device.entity';

export class CreateDeviceDto {
  @ApiProperty({ example: 'Smart Sensor 001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: 'Temperature and humidity sensor' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: DeviceType, example: DeviceType.SENSOR })
  @IsEnum(DeviceType)
  type: DeviceType;

  @ApiProperty({ enum: DeviceConnectionType, example: DeviceConnectionType.WIFI })
  @IsEnum(DeviceConnectionType)
  connectionType: DeviceConnectionType;

  // ── Protocol — determines topic structure & codec behaviour ───────────────
  // GENERIC_MQTT       → devices/{deviceKey}/telemetry topics, JSON payloads
  // LORAWAN_MILESIGHT  → application/1/device/{devEUI}/rx topics, hex payloads
  // LORAWAN_CHIRPSTACK → application/{appId}/device/{devEUI}/event/up, JSON
  // HTTP / COAP        → handled by separate adapters (future)

  @ApiProperty({
    enum: DeviceProtocol,
    example: DeviceProtocol.LORAWAN_MILESIGHT,
    description:
      'Protocol used by the device. Drives topic structure and codec selection.',
  })
  @IsEnum(DeviceProtocol)
  protocol: DeviceProtocol;

  @ApiPropertyOptional({ example: 'v1.2.3' })
  @IsString()
  @IsOptional()
  firmwareVersion?: string;

  @ApiPropertyOptional({ example: 'v2.0' })
  @IsString()
  @IsOptional()
  hardwareVersion?: string;

  @ApiPropertyOptional({ example: 24.7136 })
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional({ example: 46.6753 })
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({ example: 'Building A, Floor 3' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({
    description: 'Device metadata — codec and gateway info',
    example: {
      manufacturer: 'Milesight',
      model: 'WS558',
      // codecId links to a registered codec in CodecRegistryService.
      // If omitted, auto-detection runs at ingestion time.
      codecId: 'milesight-ws558',
      // devEUI required for all LoRaWAN protocols.
      devEUI: '24e124538d063257',
      serialNumber: 'SN-20240115-001',
      installationDate: '2024-01-15',
    },
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

    @ApiPropertyOptional({
    example: 'Milesight',
    description: 'Device manufacturer — must match a registered codec manufacturer name',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  manufacturer?: string;
 
  @ApiPropertyOptional({
    example: 'WS558',
    description: 'Device model — must match a model supported by the manufacturer codec',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    example: { reportingInterval: 60, temperatureOffset: -0.5 },
  })
  @IsObject()
  @IsOptional()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({ example: ['sensor', 'indoor', 'critical'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}