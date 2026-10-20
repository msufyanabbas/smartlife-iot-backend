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

  /**
   * Readings the agent has persisted locally but not yet delivered.
   *
   * Declared here because the pipe runs with `forbidNonWhitelisted` — an agent
   * that reported this as an extra field would get a 400, not an ignored key —
   * and because it is the single most useful number for telling "this edge is
   * fine" from "this edge has been offline for six hours and is filling its
   * disk". `handleHeartbeat` folds it into `systemMetrics`, which already has a
   * jsonb column and a history table behind it.
   */
  @ApiPropertyOptional({ example: 1420, description: 'Undelivered readings held in the local buffer' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bufferedMessages?: number;
}
