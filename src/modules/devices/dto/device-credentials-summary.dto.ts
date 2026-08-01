import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CredentialsType } from '../entities/device-credentials.entity';

/**
 * Non-secret view of a device's credentials.
 *
 * GET /devices/:id/credentials returns this. The full secret is only ever
 * returned twice in a credential's lifetime: when the device is created
 * (POST /devices) and when it is rotated
 * (POST /devices/:id/credentials/regenerate).
 */
export class DeviceCredentialsSummaryDto {
  @ApiProperty({ example: 'f5c8f60f-f5ba-4506-9aed-5af59ab6cc2a' })
  deviceId: string;

  @ApiProperty({ example: 'dev_a1b2c3d4e5f60718' })
  deviceKey: string;

  @ApiProperty({
    type: String,
    enum: CredentialsType,
    enumName: 'CredentialsType',
    example: CredentialsType.ACCESS_TOKEN,
  })
  credentialsType: CredentialsType;

  @ApiProperty({
    example: 'dev_a1b2****',
    description:
      'For ACCESS_TOKEN this is masked, because the credentialsId IS the ' +
      'secret. For MQTT_BASIC it is the username and for X509 the certificate ' +
      'CN — both are non-secret and returned in full.',
  })
  credentialsId: string;

  @ApiProperty({
    example: 'dev_a1b2****',
    description: 'First 8 characters of the secret followed by ****.',
  })
  maskedToken: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  lastUsedAt?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  expiresAt?: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
