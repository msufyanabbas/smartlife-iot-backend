import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Terminal outcome of a command, reported back after the device has actually
 * executed it.
 *
 * DELIVERED already means "published to the broker"; this closes the loop with
 * COMPLETED or FAILED.
 *
 * The payload is stored without adding columns: `response` goes to
 * DeviceCommand.metadata.response and `error` to DeviceCommand.statusMessage,
 * both of which already exist. That keeps this change migration-free.
 */
export class AcknowledgeCommandDto {
  @ApiPropertyOptional({
    description:
      'Result payload from the device. Stored under metadata.response.',
    example: { switch_1: 'on', executedAt: '2026-08-01T10:15:00Z' },
  })
  @IsObject()
  @IsOptional()
  response?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'Failure reason. When present the command is marked FAILED instead of ' +
      'COMPLETED, and this text is stored in statusMessage.',
    example: 'relay 1 did not respond',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  error?: string;
}
