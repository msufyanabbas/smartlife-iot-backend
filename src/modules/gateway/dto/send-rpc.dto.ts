// src/modules/gateway/dto/send-rpc.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body of `POST /gateway/devices/:deviceKey/rpc`.
 *
 * The global ValidationPipe runs with `{ whitelist, forbidNonWhitelisted }`,
 * so every property the frontend sends has to be declared here or the request
 * is a 400. The route previously took an inline interface, which has no
 * runtime metatype and so was not validated at all — a request with no
 * `method` reached the broker as `{"method": undefined}`.
 */
export class SendRpcDto {
  @ApiProperty({
    description: 'RPC method name the device firmware dispatches on.',
    example: 'getTelemetry',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  method: string;

  @ApiPropertyOptional({
    description: 'Method arguments, passed through to the device verbatim.',
    example: { channel: 1 },
  })
  @IsObject()
  @IsOptional()
  params?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'How long to wait for the device to answer, in milliseconds. ' +
      'Clamped to 1000–300000. Default 30000.',
    example: 10000,
    minimum: 1000,
    maximum: 300000,
  })
  @IsInt()
  @IsOptional()
  @Min(1000)
  @Max(300000)
  timeoutMs?: number;

  @ApiPropertyOptional({
    description:
      'true (default) — the HTTP request blocks until the device answers or ' +
      'the timeout expires, and the device payload is returned. ' +
      'false — publish and return immediately; poll ' +
      'GET /device-commands/{commandId} for the outcome instead.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  waitForResponse?: boolean;
}
