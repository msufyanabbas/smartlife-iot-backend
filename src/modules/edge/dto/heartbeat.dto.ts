// src/modules/edge/dto/heartbeat.dto.ts
import {
  IsNumber,
  IsString,
  IsOptional,
  ValidateNested,
  IsObject,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class HeartbeatMetricsDto {
  @ApiProperty({ example: 45.2, description: 'CPU usage 0-100' })
  @IsNumber()
  @Min(0)
  @Max(100)
  cpu: number;

  @ApiProperty({ example: 62.8, description: 'Memory usage 0-100' })
  @IsNumber()
  @Min(0)
  @Max(100)
  memory: number;

  @ApiProperty({ example: 38.5, description: 'Storage usage 0-100' })
  @IsNumber()
  @Min(0)
  @Max(100)
  storage: number;

  @ApiProperty({ example: 864000, description: 'Uptime in seconds' })
  @IsNumber()
  @Min(0)
  uptime: number;

  @ApiProperty({ example: 42, required: false })
  @IsOptional()
  @IsNumber()
  temperature?: number;

  @ApiProperty({ example: 1024000, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  networkIn?: number;

  @ApiProperty({ example: 512000, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  networkOut?: number;
}

export class HeartbeatDto {
  @ApiProperty()
  @IsString()
  edgeToken: string;

  @ApiProperty({ type: HeartbeatMetricsDto })
  @ValidateNested()
  @Type(() => HeartbeatMetricsDto)
  metrics: HeartbeatMetricsDto;

  @ApiProperty({ example: 42, description: 'Pending messages awaiting sync' })
  @IsNumber()
  @Min(0)
  pendingSync: number;
}