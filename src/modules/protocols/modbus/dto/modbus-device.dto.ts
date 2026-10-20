import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  MODBUS_CONNECTION_TYPES,
  MODBUS_DATA_TYPES,
  MODBUS_REGISTER_TYPES,
  type ModbusConnectionType,
  type ModbusDataType,
  type ModbusRegisterType,
} from '../entities/modbus-device.entity';

/**
 * One register in the map.
 *
 * `class-validator` checks the shape; `ModbusDevicesService.validateRegisters`
 * then checks the things a decorator cannot — duplicate names, a float
 * declared with length 1, a name that is not a usable telemetry key.
 */
export class ModbusRegisterDto {
  @ApiProperty({ example: 'temperature' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @ApiProperty({ example: 0, minimum: 0, maximum: 65535 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  address: number;

  // `enumName` is only required on @Query/@Param enums (§4h); these are body
  // properties, and the list is a const array rather than a TS enum anyway.
  @ApiProperty({ enum: MODBUS_REGISTER_TYPES })
  @IsIn(MODBUS_REGISTER_TYPES)
  type: ModbusRegisterType;

  @ApiPropertyOptional({
    enum: MODBUS_DATA_TYPES,
    description:
      "Ignored for 'coil' and 'discrete', which are boolean by definition.",
  })
  @IsOptional()
  @IsIn(MODBUS_DATA_TYPES)
  dataType?: ModbusDataType;

  @ApiPropertyOptional({
    description:
      'Registers to read. Defaults to 2 for int32/uint32/float, 1 otherwise.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(125)
  length?: number;

  @ApiPropertyOptional({ example: 0.1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  scale?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  offset?: number;

  @ApiPropertyOptional({ example: '°C' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string;
}

export class CreateModbusDeviceDto {
  @ApiProperty({ description: 'The platform device this endpoint feeds' })
  @IsUUID()
  deviceId: string;

  @ApiProperty({ example: 'Factory PLC' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: MODBUS_CONNECTION_TYPES, default: 'TCP' })
  @IsOptional()
  @IsIn(MODBUS_CONNECTION_TYPES)
  connectionType?: ModbusConnectionType;

  @ApiPropertyOptional({ example: '192.168.1.100' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ default: 502 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({ example: '/dev/ttyUSB0' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  serialPort?: string;

  @ApiPropertyOptional({ default: 9600 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  baudRate?: number;

  @ApiPropertyOptional({ enum: ['none', 'even', 'odd'] })
  @IsOptional()
  @IsIn(['none', 'even', 'odd'])
  parity?: 'none' | 'even' | 'odd';

  @ApiPropertyOptional({ default: 8 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(8)
  dataBits?: number;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  stopBits?: number;

  @ApiPropertyOptional({ default: 1, description: 'Modbus unit / slave id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(247)
  unitId?: number;

  @ApiPropertyOptional({ default: 5000, minimum: 250 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(250)
  @Max(86400000)
  pollIntervalMs?: number;

  @ApiPropertyOptional({ default: 5000, minimum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(600000)
  timeoutMs?: number;

  @ApiPropertyOptional({ type: [ModbusRegisterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModbusRegisterDto)
  registers?: ModbusRegisterDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * Update.
 *
 * Deliberately NOT `PartialType(CreateModbusDeviceDto)`: the global
 * ValidationPipe runs with `forbidNonWhitelisted`, and a hand-written DTO keeps
 * the Swagger document free of the mapped-type indirection that §4h warns
 * about.
 */
export class UpdateModbusDeviceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: MODBUS_CONNECTION_TYPES })
  @IsOptional()
  @IsIn(MODBUS_CONNECTION_TYPES)
  connectionType?: ModbusConnectionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  serialPort?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  baudRate?: number;

  @ApiPropertyOptional({ enum: ['none', 'even', 'odd'] })
  @IsOptional()
  @IsIn(['none', 'even', 'odd'])
  parity?: 'none' | 'even' | 'odd';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(8)
  dataBits?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  stopBits?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(247)
  unitId?: number;

  @ApiPropertyOptional({ minimum: 250 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(250)
  @Max(86400000)
  pollIntervalMs?: number;

  @ApiPropertyOptional({ minimum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(600000)
  timeoutMs?: number;

  @ApiPropertyOptional({ type: [ModbusRegisterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModbusRegisterDto)
  registers?: ModbusRegisterDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ModbusDeviceQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  // Query strings carry 'true'/'false', which @IsBoolean rejects, so the
  // coercion is explicit rather than relying on the pipe's implicit transform.
  @Type(() => String)
  @IsIn(['true', 'false'])
  enabled?: string;
}

export class SetModbusEnabledDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}
