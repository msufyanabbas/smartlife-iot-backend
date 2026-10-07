import {
  IsString,
  IsOptional,
  IsBoolean,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Metadata-only update.
 *
 * Deliberately NOT a PartialType(CreateFirmwareDto): `version` is excluded.
 * Devices resolve their pending update by matching `device.pendingFirmwareVersion`
 * against `firmware.version` (FirmwareService.resolvePendingFirmware), so
 * renaming a version after assignment would orphan every device already waiting
 * on the old string — they would poll, find no match, and sit at IDLE forever
 * with no error anywhere. Re-upload as a new version instead.
 *
 * The binary and checksum are immutable for the same reason: a device that has
 * already downloaded and verified against the old checksum must not find a
 * different payload under the same version.
 */
export class UpdateFirmwareDto {
  @ApiPropertyOptional({ example: 'WS202 sensor firmware' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiPropertyOptional({ example: 'Fixes battery reporting drift' })
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Target device profile. Send `null` to clear it (back to "any device").
   *
   * `@ValidateIf` is what makes clearing possible. With a bare `@IsOptional()`
   * + `@IsUUID()`, `null` fails the UUID check — so the only way to "clear" it
   * was to omit the key, which `JSON.stringify` does for `undefined`… and
   * omitting the key means "leave unchanged". There was no representable way to
   * remove a target profile: the form appeared to accept it and the value
   * silently came back on the next refetch.
   *
   * `@IsOptional()` is deliberately NOT used here — it skips every validator when
   * the value is null OR undefined, which would also let `null` through on
   * fields where null is meaningless.
   */
  @ApiPropertyOptional({
    nullable: true,
    description: 'Target device profile. null clears it; omit to leave unchanged.',
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsUUID()
  deviceProfileId?: string | null;

  @ApiPropertyOptional({
    description:
      'Inactive packages are hidden from assignment but keep serving devices already mid-update',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
