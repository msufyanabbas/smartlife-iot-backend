// src/modules/edge/dto/create-edge-instance.dto.ts
import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEdgeInstanceDto {
  @ApiProperty({ example: 'Edge Gateway 1' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Building A - Floor 3', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'Building A - Floor 3' })
  @IsString()
  location: string;

  @ApiProperty({ example: '1.2.5' })
  @IsString()
  version: string;

  @ApiProperty({ example: '192.168.1.100' })
  @IsString()
  ipAddress: string;

  @ApiProperty({ example: '00:1B:44:11:3A:B7', required: false })
  @IsOptional()
  @IsString()
  macAddress?: string;

  @ApiProperty({ example: 'edge-gateway-001', required: false })
  @IsOptional()
  @IsString()
  hostname?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  config?: {
    enabled?: boolean;
    autoSync?: boolean;
    maxDevices?: number;
    protocols?: string[];
    storageLimit?: number;
    retentionDays?: number;
  };

  @ApiProperty({ example: ['production', 'critical'], required: false })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  customerId?: string;
}