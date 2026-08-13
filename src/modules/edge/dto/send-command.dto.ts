// src/modules/edge/dto/send-command.dto.ts
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { EdgeCommandType } from '../entities/edge-command.entity';

export const EDGE_COMMAND_TYPES = [
  'SYNC_CONFIG',
  'REBOOT',
  'UPDATE_FIRMWARE',
  'CLEAR_BUFFER',
  'RESTART_AGENT',
  'CUSTOM',
] as const;

export class SendCommandDto {
  @ApiProperty({ type: String, enum: EDGE_COMMAND_TYPES, enumName: 'EdgeCommandType' })
  @IsIn(EDGE_COMMAND_TYPES as unknown as string[])
  type: EdgeCommandType;

  @ApiPropertyOptional({ type: Object, example: { firmwareUrl: 'https://…' } })
  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;
}
