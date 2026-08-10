// src/modules/integrations/dto/tuya-command.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsDefined,
  IsNotEmpty,
  IsString,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One Tuya datapoint write. `value` is deliberately untyped — Tuya datapoints
 * are boolean, numeric, string or enum depending on the device's function
 * schema, so validating it here would reject valid commands.
 */
export class TuyaCommandItemDto {
  @ApiProperty({ example: 'switch_1', description: 'Tuya function code' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({
    example: true,
    description: 'Datapoint value — type depends on the function code',
  })
  @IsDefined()
  value: any;
}

export class TuyaCommandDto {
  @ApiProperty({
    example: 'bfa1b2c3d4e5f6a7b8c9d0',
    description: 'Tuya device id (as returned by GET /integrations/:id/tuya/devices)',
  })
  @IsString()
  @IsNotEmpty()
  tuyaDeviceId: string;

  @ApiProperty({ type: [TuyaCommandItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TuyaCommandItemDto)
  commands: TuyaCommandItemDto[];
}
