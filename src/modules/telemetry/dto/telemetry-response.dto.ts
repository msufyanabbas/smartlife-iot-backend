import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ==================== TELEMETRY RESPONSE DTO ====================

export class TelemetryResponseDto {
  @ApiProperty({ example: 'telemetry-id-123' })
  id: string;

  @ApiProperty({ example: 'device-id-123' })
  deviceId: string;

  @ApiProperty({
    example: { temperature: 25.5, humidity: 60, co2: 400 },
  })
  data: Record<string, any>;

  @ApiProperty({ example: '2024-10-23T10:00:00Z' })
  timestamp: Date;

  @ApiPropertyOptional({ example: 25.5 })
  temperature?: number;

  @ApiPropertyOptional({ example: 60 })
  humidity?: number;

  @ApiPropertyOptional({ example: 1013.25 })
  pressure?: number;

  @ApiPropertyOptional({ example: 40.7128 })
  latitude?: number;

  @ApiPropertyOptional({ example: -74.006 })
  longitude?: number;

  @ApiPropertyOptional({ example: 85.5 })
  batteryLevel?: number;

  @ApiPropertyOptional({ example: -70 })
  signalStrength?: number;

  @ApiPropertyOptional({
    example: { source: 'sensor', quality: 'good' },
  })
  metadata?: Record<string, any>;
}

// ==================== TELEMETRY LIST RESPONSE DTO ====================

export class TelemetryListResponseDto {
  @ApiProperty({ type: [TelemetryResponseDto] })
  data: TelemetryResponseDto[];

  @ApiProperty({
    example: {
      total: 500,
      limit: 100,
      skip: 0,
    },
  })
  meta: {
    total: number;
    limit: number;
    skip: number;
  };
}

// ==================== TELEMETRY STATISTICS DTO ====================

export class TelemetryStatisticsDto {
  @ApiProperty({ example: 'device-id-123' })
  deviceId: string;

  @ApiProperty({ example: 5000 })
  totalRecords: number;

  @ApiProperty({ example: '2024-10-01T00:00:00Z' })
  firstRecord: Date;

  @ApiProperty({ example: '2024-10-23T23:59:59Z' })
  lastRecord: Date;

  @ApiProperty({
    example: {
      temperature: { min: 18.5, max: 32.1, avg: 24.3 },
      humidity: { min: 45, max: 78, avg: 61.5 },
    },
  })
  statistics: Record<string, {
    min: number;
    max: number;
    avg: number;
    count?: number;
  }>;

  @ApiProperty({
    example: ['temperature', 'humidity', 'co2', 'pressure'],
    type: [String],
  })
  availableKeys: string[];
}

// ==================== AGGREGATED DATA DTO ====================

export class AggregatedDataPointDto {
  @ApiProperty({ example: '2024-10-23T10:00:00Z' })
  timestamp: Date;

  @ApiProperty({
    example: {
      temperature: { min: 20, max: 30, avg: 25, count: 60 },
      humidity: { min: 50, max: 70, avg: 60, count: 60 },
    },
  })
  values: Record<string, {
    min: number;
    max: number;
    avg: number;
    count: number;
  }>;
}

export class AggregatedDataResponseDto {
  @ApiProperty({ example: 'device-id-123' })
  deviceId: string;

  @ApiProperty({ enum: ['hour', 'day', 'month'], example: 'hour' })
  interval: string;

  @ApiProperty({ type: [AggregatedDataPointDto] })
  data: AggregatedDataPointDto[];

  @ApiProperty({ example: '2024-10-01T00:00:00Z' })
  startDate: Date;

  @ApiProperty({ example: '2024-10-23T23:59:59Z' })
  endDate: Date;
}

// ==================== TIME SERIES DTO ====================

export class TimeSeriesDataPointDto {
  @ApiProperty({ example: '2024-10-23T10:00:00Z' })
  timestamp: Date;

  @ApiProperty({ example: 25.5 })
  value: number;
}

export class TimeSeriesResponseDto {
  @ApiProperty({ example: 'device-id-123' })
  deviceId: string;

  @ApiProperty({ example: 'temperature' })
  key: string;

  @ApiProperty({ type: [TimeSeriesDataPointDto] })
  data: TimeSeriesDataPointDto[];

  @ApiProperty({ example: 500 })
  count: number;
}

// ==================== COUNT RESPONSE DTO ====================

export class TelemetryCountResponseDto {
  @ApiProperty({ example: 'device-id-123' })
  deviceId: string;

  @ApiProperty({ example: 5000 })
  count: number;
}

// ==================== BATCH RESPONSE DTO ====================

export class BatchTelemetryResponseDto {
  @ApiProperty({ example: 'Batch telemetry created successfully' })
  message: string;

  @ApiProperty({ example: 10 })
  recordsCreated: number;

  @ApiPropertyOptional({ type: [String], example: [] })
  errors?: string[];
}

// ==================== MESSAGE RESPONSE DTO ====================

export class TelemetryMessageResponseDto {
  @ApiProperty({ example: 'Operation completed successfully' })
  message: string;

  @ApiPropertyOptional({ type: TelemetryResponseDto })
  data?: TelemetryResponseDto;
}