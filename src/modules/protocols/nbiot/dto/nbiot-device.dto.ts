// src/modules/protocols/nbiot/dto/nbiot-device.dto.ts
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';
import type { NbIotAppProtocol } from '../entities/nbiot-device.entity';

export const NBIOT_APP_PROTOCOLS: NbIotAppProtocol[] = [
  'coap',
  'mqtt',
  'mqtt_sn',
  'http',
];

export class CreateNbIotDeviceDto {
  @ApiProperty({ description: 'Platform device this SIM belongs to.' })
  @IsUUID()
  deviceId: string;

  @ApiPropertyOptional({
    example: '420011234567890',
    description: 'International Mobile Subscriber Identity — identifies the subscription.',
  })
  @IsOptional()
  @IsString()
  // Digits only. An IMSI pasted with spaces or a trailing newline is the kind
  // of value that matches nothing on the uplink path and looks like a device
  // that never reported.
  @Matches(/^\d{6,20}$/, { message: 'imsi must be 6–20 digits' })
  imsi?: string;

  @ApiPropertyOptional({
    example: '860123456789012',
    description: 'International Mobile Equipment Identity — identifies the module.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{14,17}$/, { message: 'imei must be 14–17 digits' })
  imei?: string;

  @ApiPropertyOptional({
    example: '8996001234567890123',
    description: 'Integrated Circuit Card ID — identifies the physical SIM.',
  })
  @IsOptional()
  @IsString()
  // ICCIDs are 19–20 digits and may carry a trailing check character.
  @Matches(/^\d{18,20}[0-9Ff]?$/, {
    message: 'iccid must be 18–20 digits, optionally with a check character',
  })
  iccid?: string;

  @ApiPropertyOptional({ example: '+966500000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  msisdn?: string;

  @ApiPropertyOptional({ example: 'Zain KSA' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  carrier?: string;

  @ApiPropertyOptional({ example: 'nbiot.zain.sa' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apn?: string;

  @ApiPropertyOptional({
    example: '42004',
    description: 'PLMN (MCC+MNC) — narrows which network a roaming SIM is on.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{5,6}$/, { message: 'plmn must be 5 or 6 digits (MCC+MNC)' })
  plmn?: string;

  @ApiPropertyOptional({ example: 8, description: '3GPP band, e.g. 8, 20, 28.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(255)
  band?: number;

  @ApiPropertyOptional({ enum: NBIOT_APP_PROTOCOLS, default: 'coap' })
  @IsOptional()
  @IsIn(NBIOT_APP_PROTOCOLS)
  appProtocol?: NbIotAppProtocol;

  @ApiPropertyOptional({
    description:
      'Seconds this device may legitimately stay silent. A PSM device that ' +
      'reports once a day is not offline at minute six, which is what the ' +
      'generic five-minute window says about it.',
    minimum: 30,
    maximum: 2_592_000,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(2_592_000)
  expectedReportIntervalSeconds?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNbIotDeviceDto extends PartialType(CreateNbIotDeviceDto) {}

// NOTE: there is deliberately NO DTO for the uplink body.
//
// Every carrier IoT platform has its own envelope, and the resolver digs the
// device identifier and the radio metrics out of whatever shape arrives
// (`NbIotService.normaliseSignalMetrics`). A declared DTO would mean the global
// `forbidNonWhitelisted: true` rejected every real carrier body with
// "property should not exist" — a 400 to a sender that retries and eventually
// disables the destination. `POST /integrations/http/:id` takes `any` for the
// same reason.
