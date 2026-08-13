import { Allow, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Input envelope for a script run — the ThingsBoard triple.
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted: true`, so every
 * accepted property must be declared here. `msg`/`metadata` are free-form
 * objects (their contents are the tenant's telemetry, not our schema), which is
 * why they only carry @IsObject() and not a nested type.
 */
export class ExecuteScriptDto {
  @ApiProperty({
    type: Object,
    description: 'Message body exposed to the script as `msg`',
    example: { temperature: 35, humidity: 60 },
  })
  @IsObject()
  msg: Record<string, any>;

  @ApiPropertyOptional({
    type: Object,
    description: 'Exposed to the script as `metadata`. Defaults to {}.',
    example: { deviceName: 'Sensor 1' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    type: String,
    description: 'Exposed as `msgType`. Defaults to POST_TELEMETRY_REQUEST.',
    example: 'POST_TELEMETRY_REQUEST',
  })
  @IsOptional()
  @IsString()
  msgType?: string;
}

export class TestScriptDto extends ExecuteScriptDto {
  /**
   * Compared against the script result with a JSON deep-equal. Any JSON value
   * is valid here — including `null` and `false` — so it is whitelisted with
   * @Allow() rather than validated. (@IsOptional() alone would not survive
   * `whitelist: true`, which strips properties carrying no validation metadata.)
   */
  @ApiPropertyOptional({
    description:
      'Optional expected result. When present the response includes `passed`.',
    example: true,
  })
  @Allow()
  expectedResult?: any;
}
