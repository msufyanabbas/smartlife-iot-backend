// src/modules/edge/dto/dispatch-command.dto.ts
import { IsIn, IsOptional, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { EdgeCommandType } from '../entities/edge-command.entity';

export class DispatchCommandDto {
  @ApiProperty({
    enum: ['restart', 'sync', 'update_config', 'reboot'],
    example: 'restart',
  })
  @IsIn(['restart', 'sync', 'update_config', 'reboot'])
  command: EdgeCommandType;

  @ApiProperty({ required: false, example: { configKey: 'value' } })
  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;
}