// src/modules/edge/dto/agent-register.dto.ts
import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentRegisterDto {
  @ApiProperty({ example: 'edge_ab12…' })
  @IsString()
  edgeKey: string;

  @ApiProperty({ description: 'Raw secret issued once at activation' })
  @IsString()
  edgeSecret: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: '192.168.1.100' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional()
  @IsString()
  agentVersion?: string;

  @ApiPropertyOptional({ example: 'Ubuntu 22.04' })
  @IsOptional()
  @IsString()
  osInfo?: string;
}
