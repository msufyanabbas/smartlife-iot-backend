// src/modules/device-commands/dto/create-command.dto.ts

import {
  IsString,
  IsObject,
  IsEnum,
  IsOptional,
  IsNumber,
  IsDateString,
} from 'class-validator';

export class CreateCommandDto {
  @IsString()
  deviceId: string;

  @IsString()
  commandType: string; // 'turnOn', 'turnOff', 'setBrightness', etc.

  @IsObject()
  @IsOptional()
  params?: Record<string, any>;

  @IsEnum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  @IsOptional()
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @IsNumber()
  @IsOptional()
  timeout?: number;

  @IsDateString()
  @IsOptional()
  scheduledFor?: string; // ISO date string
}
