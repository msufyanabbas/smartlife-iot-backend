import { IsObject, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of POST /automations/:id/execute.
 *
 * Conditions ARE evaluated against this payload, so a manual run behaves like
 * the live path. Supply the telemetry keys the automation tests, otherwise the
 * conditions fail and the call answers 400 with the per-condition breakdown.
 */
export class ExecuteAutomationDto {
  @ApiPropertyOptional({
    example: { temperature: 45 },
    description: 'Telemetry frame the conditions are evaluated against',
  })
  @IsOptional()
  @IsObject()
  telemetry?: Record<string, any>;

  @ApiPropertyOptional({
    example: { doorOpen: true },
    description: 'Attribute bag the conditions are evaluated against',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, any>;

  @ApiPropertyOptional({ description: 'Device the actions target' })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Alarm payload for an ALARM-trigger automation' })
  @IsOptional()
  @IsObject()
  alarm?: Record<string, any>;
}
