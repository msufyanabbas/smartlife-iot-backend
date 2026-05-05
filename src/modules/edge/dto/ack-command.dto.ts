// src/modules/edge/dto/ack-command.dto.ts
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AckCommandDto {
  @ApiProperty({ enum: ['executed', 'failed'], example: 'executed' })
  @IsIn(['executed', 'failed'])
  result: 'executed' | 'failed';

  @ApiProperty({ required: false, example: 'Reboot completed in 12s' })
  @IsOptional()
  @IsString()
  message?: string;
}