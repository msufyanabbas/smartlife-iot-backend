// src/modules/edge/dto/agent-heartbeat.dto.ts
import { IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Posted by the edge agent. `edgeKey` authenticates the call — there is no JWT
 * on this route, so every accepted field must be declared here: the global
 * ValidationPipe runs with forbidNonWhitelisted.
 */
export class AgentHeartbeatDto {
  @ApiProperty({ example: 'edge_ab12…' })
  @IsString()
  edgeKey: string;

  @ApiPropertyOptional({ example: '192.168.1.100' })
  @IsOptional()
  @IsString()
  ipAddress?: string;

  @ApiPropertyOptional({ example: '2.1.0' })
  @IsOptional()
  @IsString()
  firmwareVersion?: string;

  @ApiPropertyOptional({ example: '1.0.0' })
  @IsOptional()
  @IsString()
  agentVersion?: string;

  @ApiPropertyOptional({ example: 'Ubuntu 22.04' })
  @IsOptional()
  @IsString()
  osInfo?: string;

  @ApiPropertyOptional({
    type: Object,
    example: { cpuUsage: 12.5, memoryUsage: 45.2, diskUsage: 30 },
  })
  @IsOptional()
  @IsObject()
  systemMetrics?: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
    networkIn?: number;
    networkOut?: number;
    temperature?: number;
  };

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  connectedDevices?: number;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  messagesPerMinute?: number;

  @ApiPropertyOptional({ example: 40213 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  totalMessagesProcessed?: number;

  @ApiPropertyOptional({ example: 864000, description: 'Agent uptime, seconds' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  uptimeSeconds?: number;
}
