import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsLatitude,
  IsLongitude,
} from 'class-validator';

export class CreateTelemetryDto {
  @ApiProperty({
    example: { temperature: 25.5, humidity: 60, co2: 400 },
    description: 'Telemetry data',
  })
  @IsObject()
  @IsNotEmpty()
  data: Record<string, any>;

  @ApiPropertyOptional({
    example: '2024-10-23T10:00:00Z',
    description: 'Timestamp (defaults to current time)',
  })
  @IsDateString()
  @IsOptional()
  timestamp?: string;

  @ApiPropertyOptional({ example: 25.5, description: 'Temperature in Celsius' })
  @IsNumber()
  @IsOptional()
  temperature?: number;

  @ApiPropertyOptional({ example: 60, description: 'Humidity percentage' })
  @IsNumber()
  @IsOptional()
  humidity?: number;

  @ApiPropertyOptional({ example: 1013.25, description: 'Pressure in hPa' })
  @IsNumber()
  @IsOptional()
  pressure?: number;

  @ApiPropertyOptional({ example: 40.7128, description: 'Latitude' })
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiPropertyOptional({ example: -74.006, description: 'Longitude' })
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiPropertyOptional({
    example: 85.5,
    description: 'Battery level percentage',
  })
  @IsNumber()
  @IsOptional()
  batteryLevel?: number;

  @ApiPropertyOptional({ example: -70, description: 'Signal strength in dBm' })
  @IsNumber()
  @IsOptional()
  signalStrength?: number;

  @ApiPropertyOptional({
    example: { source: 'sensor', quality: 'good' },
    description: 'Additional metadata',
  })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
