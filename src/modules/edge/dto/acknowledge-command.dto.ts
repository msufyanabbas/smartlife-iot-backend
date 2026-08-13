// src/modules/edge/dto/acknowledge-command.dto.ts
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AcknowledgeCommandDto {
  @ApiProperty({ example: 'edge_ab12…' })
  @IsString()
  edgeKey: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  success: boolean;

  @ApiPropertyOptional({ example: 'Agent restarted in 4s' })
  @IsOptional()
  @IsString()
  error?: string;
}
