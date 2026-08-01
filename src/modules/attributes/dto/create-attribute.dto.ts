import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsNotEmptyObject,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AttributeScope, DataType } from '@common/enums/index.enum';

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

  @ApiProperty({ type: String, enum: AttributeScope, enumName: 'AttributeScope', example: AttributeScope.SERVER })
  @IsEnum(AttributeScope)
  scope: AttributeScope;

  @ApiProperty({ type: String, enum: DataType, enumName: 'DataType', example: DataType.STRING })
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
  // @IsObject/@IsNotEmptyObject are required, not decorative: the global
  // ValidationPipe runs with whitelist + forbidNonWhitelisted, so a property
  // carrying no class-validator decorator is stripped and then rejected as
  // "property attributes should not exist". Without these, every request to
  // POST /attributes/:entityType/:entityId/:scope returned 400 and there was
  // no working REST path to write attributes in bulk.
  @ApiProperty({
    example: {
      firmwareVersion: '1.2.3',
      location: { lat: 40.7128, lon: -74.006 },
      temperature: 25.5,
    },
  })
  @IsObject()
  @IsNotEmptyObject()
  attributes: Record<string, any>;
}
