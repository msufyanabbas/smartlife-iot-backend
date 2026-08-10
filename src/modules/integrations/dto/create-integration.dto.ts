import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntegrationType } from '@common/enums/index.enum';

export class CreateIntegrationDto {
  @ApiProperty({ example: 'AWS IoT Core', description: 'Integration name' })
  @IsString()
  name: string;

  @ApiProperty({ type: String, enum: IntegrationType, enumName: 'IntegrationType', example: IntegrationType.CLOUD })
  @IsEnum(IntegrationType)
  type: IntegrationType;

  @ApiProperty({ example: 'MQTT', description: 'Protocol used' })
  @IsString()
  protocol: string;

  @ApiProperty({ example: 'AWS IoT integration', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: true, required: false, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Type-specific settings. Kept as a free-form object because each adapter
   * reads a different set:
   *
   *   webhook  { url, method?, headers?, secret?, timeout? }
   *   api      { url, method?, headers?, apiKey? | basicAuth{}, queryParams?, timeout? }
   *   mqtt     { brokerUrl | broker + port + useTls, username?, password?, topic?, qos?, clientId? }
   *   tuya     { clientId, clientSecret, region: eu|us|cn|in, webhookUrl? }
   *   aws_iot  { endpoint, accessKeyId, secretAccessKey, region?, topic?, qos? }
   *
   * `topic` and `payloadTemplate` support {{deviceId}}, {{deviceKey}},
   * {{tenantId}} and {{timestamp}} placeholders.
   */
  @ApiProperty({
    example: {
      url: 'https://webhook.site/your-unique-id',
      method: 'POST',
      headers: { 'X-Source': 'SmartLife IoT' },
      secret: 'your-webhook-secret',
      timeout: 10000,
    },
  })
  @IsObject()
  configuration: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'Which devices to forward. Fields are ANDed; omit or null to forward every device in the tenant.',
    example: { deviceType: 'sensor' },
  })
  @IsOptional()
  @IsObject()
  deviceFilter?: {
    deviceId?: string;
    deviceType?: string;
    assetId?: string;
  };

  @ApiPropertyOptional({
    description:
      'Restrict which telemetry keys leave the platform. Omit or null to forward the whole payload.',
    example: { keys: ['temperature', 'humidity'] },
  })
  @IsOptional()
  @IsObject()
  dataFilter?: {
    keys?: string[];
  };
}
