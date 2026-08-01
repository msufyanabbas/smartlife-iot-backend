import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeviceType } from '@common/enums/index.enum';
import { CredentialsType } from '../entities/device-credentials.entity';

/**
 * Body a device posts to POST /devices/provision to self-register against a
 * DeviceProfile whose provisionType is not DISABLED.
 *
 * This endpoint is @Public() — the provision key/secret pair IS the
 * authentication. It carries no tenantId: the tenant is derived from the
 * profile that owns the provision key, so a caller cannot provision into a
 * tenant they do not hold a key for.
 */
export class ProvisionDeviceDto {
  @ApiProperty({
    example: 'PROV-KEY-WS202-001',
    description: 'Matches DeviceProfile.provisionDeviceKey.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  provisionDeviceKey: string;

  @ApiProperty({
    example: 's3cr3t-provisioning-value',
    description: 'Matches DeviceProfile.provisionDeviceSecret.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  provisionDeviceSecret: string;

  @ApiProperty({
    example: 'Warehouse Sensor 42',
    description:
      'Device name. Under CHECK_PRE_PROVISIONED_DEVICES this must match an ' +
      'existing device on the profile. Under ALLOW_CREATE_NEW_DEVICES a ' +
      'device with this name is created, or its existing credentials are ' +
      'returned if it was already provisioned (idempotent re-provision).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  deviceName: string;

  @ApiPropertyOptional({
    type: String,
    enum: DeviceType,
    enumName: 'DeviceType',
    example: DeviceType.SENSOR,
    description: 'Defaults to sensor when omitted.',
  })
  @IsEnum(DeviceType)
  @IsOptional()
  deviceType?: DeviceType;
}

/**
 * ThingsBoard-compatible provisioning response. Always HTTP 200 — a failure is
 * reported in the `status` field rather than as an HTTP error, so a constrained
 * device firmware only has to parse one response shape.
 */
export class ProvisionDeviceResponseDto {
  @ApiProperty({ enum: ['SUCCESS', 'FAILURE'], example: 'SUCCESS' })
  status: 'SUCCESS' | 'FAILURE';

  @ApiPropertyOptional({ example: 'Invalid provision credentials' })
  errorMsg?: string;

  @ApiPropertyOptional({
    type: String,
    enum: CredentialsType,
    enumName: 'CredentialsType',
  })
  credentialsType?: CredentialsType;

  @ApiPropertyOptional({
    description: 'The secret the device must use to connect. Shown once here.',
  })
  credentialsValue?: string;

  @ApiPropertyOptional({ description: 'Assigned device key (MQTT client id).' })
  deviceKey?: string;

  @ApiPropertyOptional()
  deviceId?: string;
}
