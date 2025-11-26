import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsBoolean,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AttributeScope, DataType } from '../entities/attribute.entity';

export class CreateAttributeDto {
  @ApiProperty({ example: 'device' })
  @IsString()
  entityType: string;

  @ApiProperty({ example: 'device-uuid-123' })
  @IsString()
  entityId: string;

  @ApiProperty({ example: 'firmwareVersion' })
  @IsString()
  attributeKey: string;

  @ApiProperty({ enum: AttributeScope, example: AttributeScope.SERVER })
  @IsEnum(AttributeScope)
  scope: AttributeScope;

  @ApiProperty({ enum: DataType, example: DataType.STRING })
  @IsEnum(DataType)
  dataType: DataType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  stringValue?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  numberValue?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  booleanValue?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  jsonValue?: any;
}

export class SaveAttributesDto {
  @ApiProperty({
    example: {
      firmwareVersion: '1.2.3',
      location: { lat: 40.7128, lon: -74.006 },
      temperature: 25.5,
    },
  })
  attributes: Record<string, any>;
}
