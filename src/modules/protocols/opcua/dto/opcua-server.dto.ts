// src/modules/protocols/opcua/dto/opcua-server.dto.ts
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  OpcuaSecurityMode,
  OpcuaSecurityPolicy,
} from '../entities/opcua-server.entity';

export const OPCUA_SECURITY_MODES: OpcuaSecurityMode[] = [
  'None',
  'Sign',
  'SignAndEncrypt',
];

export const OPCUA_SECURITY_POLICIES: OpcuaSecurityPolicy[] = [
  'None',
  'Basic128Rsa15',
  'Basic256',
  'Basic256Sha256',
  'Aes128_Sha256_RsaOaep',
  'Aes256_Sha256_RsaPss',
];

export class OpcuaNodeMappingDto {
  @ApiProperty({ example: 'ns=2;s=Boiler1.Temperature' })
  @IsString()
  @MaxLength(400)
  nodeId: string;

  @ApiProperty({ example: 'boilerTemperature' })
  @IsString()
  @MaxLength(120)
  key: string;

  @ApiPropertyOptional({ enum: ['string', 'number', 'boolean'] })
  @IsOptional()
  @IsIn(['string', 'number', 'boolean'])
  dataType?: 'string' | 'number' | 'boolean';

  @ApiPropertyOptional({
    description:
      'Multiplier applied before storing. Use it for raw integers that mean ' +
      'tenths — 0.1 turns 213 into 21.3 °C.',
  })
  @IsOptional()
  @IsNumber()
  scale?: number;

  @ApiPropertyOptional({ example: '°C' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;
}

export class CreateOpcuaServerDto {
  @ApiProperty({ example: 'Chiller plant PLC' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 'opc.tcp://192.168.10.20:4840' })
  @IsString()
  @MaxLength(500)
  // Scheme-checked here rather than left to the client: `node-opcua` rejects a
  // non-opc.tcp URL with a low-level parse error that reads like a network
  // fault, and an operator who pasted an http:// address would spend a while
  // looking at firewalls.
  @Matches(/^opc\.tcp:\/\/.+/i, {
    message: 'endpointUrl must start with opc.tcp://',
  })
  endpointUrl: string;

  @ApiPropertyOptional({
    description: 'Device the readings land on. Required before it can ingest.',
  })
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiPropertyOptional({ enum: OPCUA_SECURITY_MODES, default: 'None' })
  @IsOptional()
  @IsIn(OPCUA_SECURITY_MODES)
  securityMode?: OpcuaSecurityMode;

  @ApiPropertyOptional({ enum: OPCUA_SECURITY_POLICIES, default: 'None' })
  @IsOptional()
  @IsIn(OPCUA_SECURITY_POLICIES)
  securityPolicy?: OpcuaSecurityPolicy;

  @ApiPropertyOptional({
    description: 'Leave empty for anonymous access.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  username?: string;

  @ApiPropertyOptional({
    description:
      'Write-only. Stored AES-256-GCM encrypted and never returned. Omit on ' +
      'update to leave the stored password untouched.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  password?: string;

  @ApiPropertyOptional({ type: [OpcuaNodeMappingDto] })
  @IsOptional()
  @IsArray()
  // Capped because every mapping becomes a monitored item, and a server's
  // MaxMonitoredItemsPerSubscription is frequently 1000–5000.
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OpcuaNodeMappingDto)
  nodes?: OpcuaNodeMappingDto[];

  @ApiPropertyOptional({
    default: true,
    description:
      'True uses a real OPC-UA subscription with monitored items. False polls ' +
      'with session.read() on pollIntervalMs — only for servers whose ' +
      'subscription support is broken or whose session budget forbids one.',
  })
  @IsOptional()
  @IsBoolean()
  useSubscription?: boolean;

  @ApiPropertyOptional({ default: 1000, minimum: 100, maximum: 3600000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(3_600_000)
  publishingIntervalMs?: number;

  @ApiPropertyOptional({ default: 1000, minimum: 0, maximum: 3600000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3_600_000)
  samplingIntervalMs?: number;

  @ApiPropertyOptional({ default: 10000, minimum: 1000, maximum: 86400000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(86_400_000)
  pollIntervalMs?: number;

  @ApiPropertyOptional({
    default: 1000,
    minimum: 100,
    maximum: 60000,
    description:
      'How long changed values are coalesced into one reading. 100 ms minimum ' +
      'because 0 would make every single node change its own telemetry row.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(60_000)
  flushWindowMs?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateOpcuaServerDto extends PartialType(CreateOpcuaServerDto) {}

export class OpcuaBrowseDto {
  @ApiPropertyOptional({
    description:
      'Node to browse. Defaults to the Objects folder (ns=0;i=85), which is ' +
      'where everything an integrator cares about hangs.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  nodeId?: string;
}
