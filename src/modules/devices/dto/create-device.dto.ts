// src/modules/devices/dto/create-device.dto.ts
// UPDATED WITH CODEC SUPPORT

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
  MinLength,
} from 'class-validator';
import { DeviceType, DeviceConnectionType } from '../entities/device.entity';

export class CreateDeviceDto {
  @ApiProperty({ example: 'Smart Sensor 001', description: 'Device name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 'Temperature and humidity sensor',
    description: 'Device description',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    enum: DeviceType,
    example: DeviceType.SENSOR,
    description: 'Type of device',
  })
  @IsEnum(DeviceType)
  type: DeviceType;

  @ApiProperty({
    enum: DeviceConnectionType,
    example: DeviceConnectionType.WIFI,
    description: 'Connection type',
  })
  @IsEnum(DeviceConnectionType)
  connectionType: DeviceConnectionType;

  @ApiPropertyOptional({ example: 'v1.2.3', description: 'Firmware version' })
  @IsString()
  @IsOptional()
  firmwareVersion?: string;

  @ApiPropertyOptional({ example: 'v2.0', description: 'Hardware version' })
  @IsString()
  @IsOptional()
  hardwareVersion?: string;

  @ApiPropertyOptional({ example: 40.7128, description: 'Latitude' })
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional({ example: -74.006, description: 'Longitude' })
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({
    example: 'Building A, Floor 3',
    description: 'Location',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({
    example: { 
      manufacturer: 'Milesight', 
      model: 'WS558',
      codecId: 'milesight-ws558', // 🆕 CODEC ID
      deviceType: 'lorawan-milesight',
      gatewayType: 'milesight',
      devEUI: '24e124538d063257' // For LoRaWAN devices
    },
    description: 'Additional metadata (including codec configuration)',
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    example: { sampleRate: 60, threshold: 25 },
    description: 'Device configuration',
  })
  @IsObject()
  @IsOptional()
  configuration?: Record<string, any>;

  @ApiPropertyOptional({
    example: ['sensor', 'indoor', 'critical'],
    description: 'Device tags',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: 'tenant-uuid', description: 'Tenant ID' })
  @IsString()
  @IsOptional()
  tenantId?: string;
}