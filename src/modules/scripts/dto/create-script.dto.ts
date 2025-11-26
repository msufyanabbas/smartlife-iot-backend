import { IsString, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ScriptType } from '../entities/script.entity';

export class CreateScriptDto {
  @ApiProperty({ example: 'Temperature Converter' })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'Convert temperature from Celsius to Fahrenheit',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ScriptType, example: ScriptType.PROCESSING })
  @IsEnum(ScriptType)
  type: ScriptType;

  @ApiProperty({
    example: 'function convert(celsius) { return celsius * 9/5 + 32; }',
  })
  @IsString()
  code: string;

  @ApiProperty({ example: '1.0.0', required: false })
  @IsOptional()
  @IsString()
  version?: string;
}
