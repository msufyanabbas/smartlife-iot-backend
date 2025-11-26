import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IntegrationType } from '../entities/integration.entity';

export class CreateIntegrationDto {
  @ApiProperty({ example: 'AWS IoT Core', description: 'Integration name' })
  @IsString()
  name: string;

  @ApiProperty({ enum: IntegrationType, example: IntegrationType.CLOUD })
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

  @ApiProperty({
    example: {
      url: 'mqtt://aws-iot.com',
      port: 8883,
      apiKey: 'xxx',
    },
  })
  @IsObject()
  configuration: {
    url?: string;
    port?: number;
    username?: string;
    password?: string;
    apiKey?: string;
    topic?: string;
    headers?: Record<string, string>;
    method?: string;
  };
}
