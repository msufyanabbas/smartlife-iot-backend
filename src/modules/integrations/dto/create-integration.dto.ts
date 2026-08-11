import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntegrationType, IntegrationStatus } from '@common/enums/index.enum';

/**
 * `integrations.type` and `integrations.status` are Postgres ENUM columns whose
 * labels are lowercase ('webhook', 'aws_iot', 'active', …). Clients send the
 * TypeScript enum KEY instead ('WEBHOOK', 'AWS_IOT', 'ACTIVE'), so the value is
 * folded to lowercase BEFORE @IsEnum runs. Normalising upwards would pass
 * validation and then fail at the DB with
 * `invalid input value for enum integrations_type_enum: "WEBHOOK"` — a 500
 * instead of a 400.
 */
const toEnumValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Names that are not enum labels but have an unambiguous home.
 * 'http' → API, which is what HttpAdapter is registered under in
 * IntegrationDispatchService.
 */
const TYPE_ALIASES: Record<string, IntegrationType> = {
  http: IntegrationType.API,
  https: IntegrationType.API,
  rest: IntegrationType.API,
};

const toIntegrationType = ({ value }: { value: unknown }): unknown => {
  const normalised = toEnumValue({ value });
  if (typeof normalised !== 'string') return normalised;
  return TYPE_ALIASES[normalised] ?? normalised;
};

export class CreateIntegrationDto {
  @ApiProperty({ example: 'AWS IoT Core', description: 'Integration name' })
  @IsString()
  name: string;

  @ApiProperty({
    type: String,
    enum: IntegrationType,
    enumName: 'IntegrationType',
    example: IntegrationType.CLOUD,
    description:
      'Case-insensitive: "WEBHOOK" and "webhook" are both accepted. "http"/"https"/"rest" are aliases for "api".',
  })
  @Transform(toIntegrationType)
  @IsEnum(IntegrationType)
  type: IntegrationType;

  /**
   * Optional: the column is NOT NULL, so IntegrationsService.create() fills in a
   * transport default derived from `type` when the client omits it.
   */
  @ApiPropertyOptional({
    example: 'MQTT',
    description:
      'Transport protocol. Defaults to the usual transport for the chosen type when omitted.',
  })
  @IsOptional()
  @IsString()
  protocol?: string;

  @ApiProperty({ example: 'AWS IoT integration', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    type: String,
    enum: IntegrationStatus,
    enumName: 'IntegrationStatus',
    example: IntegrationStatus.ACTIVE,
    description:
      'Case-insensitive. Defaults to "inactive" (the column default) when omitted.',
  })
  @IsOptional()
  @Transform(toEnumValue)
  @IsEnum(IntegrationStatus)
  status?: IntegrationStatus;

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
  } | null;

  @ApiPropertyOptional({
    description:
      'Restrict which telemetry keys leave the platform. Omit or null to forward the whole payload.',
    example: { keys: ['temperature', 'humidity'] },
  })
  @IsOptional()
  @IsObject()
  dataFilter?: {
    keys?: string[];
  } | null;
}
