// src/modules/devices/dto/bulk-device.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { BulkIdsDto } from '@common/dto/bulk-operation.dto';
import { DeviceStatus } from '@common/enums/index.enum';

export class BulkDeleteDevicesDto extends BulkIdsDto {}

/**
 * The allowed bulk device patch — deliberately three fields.
 *
 * A bulk endpoint that accepts an arbitrary `UpdateDeviceDto` is a hole: it
 * would let one request rewrite `deviceKey` (the MQTT topic identity and the
 * unique lookup key for every uplink), `protocol` / `manufacturer` / `model`
 * (which decide the codec and so how every future payload is decoded) or
 * `metadata.codecId` across a whole fleet, with no per-device review.
 *
 * What is allowed, and why it is safe in bulk:
 *   - `status`     — fleet-wide maintenance / decommission marking. Already a
 *                    single-device route (`POST /devices/:id/activate`).
 *   - `customerId` — assign or (with `null`) unassign a batch to a customer
 *                    org. The id is checked against the caller's tenant.
 *   - `assetId`    — link or (with `null`) unlink a batch to a physical asset.
 *                    Also tenant-checked; a foreign asset id would otherwise
 *                    put the device in another tenant's floor-plan pickers.
 *
 * Deliberately NOT allowed: `deviceKey`, `tenantId`, `userId`, `name`,
 * `protocol`, `manufacturer`, `model`, `metadata`, `configuration`,
 * `deviceProfileId`. The profile is excluded specifically because changing it
 * is supposed to materialise the new profile's alarm rules
 * (`ProfileAlarmService`), and doing that for 100 devices behind one PATCH
 * hides a large side effect.
 *
 * `null` means "clear this field". `undefined` (field absent) means "leave it
 * alone" — the service tests `!== undefined`, so omitting a field never nulls
 * it.
 */
export class BulkUpdateDevicesDto extends BulkIdsDto {
  @ApiPropertyOptional({
    type: String,
    enum: DeviceStatus,
    enumName: 'DeviceStatus',
    description: 'New lifecycle status for every listed device.',
  })
  @IsOptional()
  @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Customer to assign these devices to, or null to unassign. Must belong to the caller’s tenant.',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Asset to link these devices to, or null to unlink. Must belong to the caller’s tenant.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string | null;
}
