import { IsOptional, IsEnum, IsIn, IsUUID, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '@common/dto/pagination.dto';
import { FirmwareUpdateStatus } from '@common/enums/index.enum';

export const OTA_SORT_FIELDS = [
  'name',
  'firmwareUpdateStatus',
  'firmwareUpdateProgress',
  'currentFirmwareVersion',
  'pendingFirmwareVersion',
  'firmwareUpdateStartedAt',
  'firmwareUpdateCompletedAt',
  'lastSeenAt',
] as const;

export type OtaSortField = (typeof OTA_SORT_FIELDS)[number];

/**
 * Where a device sits in the rollout, as the OTA page groups them.
 *
 * Derived rather than stored, because no single column answers it: a device with
 * `pendingFirmwareVersion` set and status IDLE has been targeted but has not yet
 * polled, which is operationally very different from one that is DOWNLOADING,
 * and neither is a column value.
 */
export enum OtaRolloutState {
  /** No pending version — running whatever it last reported. */
  UP_TO_DATE = 'UP_TO_DATE',
  /** Assigned a version but has not polled yet. */
  PENDING = 'PENDING',
  /** Actively downloading / verifying / applying. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** Reported SUCCESS on its last attempt. */
  UPDATED = 'UPDATED',
  /** Reported FAILED — needs a retry or a different package. */
  FAILED = 'FAILED',
}

export class QueryOtaRolloutDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: OTA_SORT_FIELDS,
    default: 'firmwareUpdateStartedAt',
  })
  @IsOptional()
  @IsIn(OTA_SORT_FIELDS, {
    message: `sortBy must be one of: ${OTA_SORT_FIELDS.join(', ')}`,
  })
  declare sortBy?: OtaSortField;

  @ApiPropertyOptional({
    enum: OtaRolloutState,
    description: 'Group devices by where they sit in the rollout',
  })
  @IsOptional()
  @IsEnum(OtaRolloutState)
  state?: OtaRolloutState;

  @ApiPropertyOptional({
    enum: FirmwareUpdateStatus,
    description: 'Exact last-reported status (narrower than `state`)',
  })
  @IsOptional()
  @IsEnum(FirmwareUpdateStatus)
  status?: FirmwareUpdateStatus;

  @ApiPropertyOptional({ description: 'Only devices of this profile' })
  @IsOptional()
  @IsUUID()
  deviceProfileId?: string;

  @ApiPropertyOptional({ description: 'Only devices targeted with this version' })
  @IsOptional()
  @IsString()
  version?: string;
}
