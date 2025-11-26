import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsArray,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FloorPlanStatus } from '../entities/floor-plan.entity';

export class CreateFloorPlanDto {
  @ApiProperty({ example: 'Factory Floor - Production Area' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Manufacturing Plant A' })
  @IsString()
  building: string;

  @ApiProperty({ example: 'Ground Floor' })
  @IsString()
  floor: string;

  @ApiProperty({ example: 'Industrial' })
  @IsString()
  category: string;

  @ApiProperty({ example: { width: 100, height: 80 } })
  @IsObject()
  dimensions: {
    width: number;
    height: number;
  };

  @ApiProperty({ example: '1:100', required: false })
  @IsOptional()
  @IsString()
  scale?: string;

  @ApiProperty({ enum: FloorPlanStatus, required: false })
  @IsOptional()
  @IsEnum(FloorPlanStatus)
  status?: FloorPlanStatus;
}

export class AddDeviceToFloorPlanDto {
  @ApiProperty()
  @IsString()
  deviceId: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty({ example: { x: 50, y: 50 } })
  @IsObject()
  position: { x: number; y: number };
}

export class AddZoneDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  color: string;

  @ApiProperty()
  @IsArray()
  boundaries: Array<{ x: number; y: number }>;
}
