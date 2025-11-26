import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TemplateCategory } from '../entities/solution-template.entity';

export class CreateSolutionTemplateDto {
  @ApiProperty({ example: 'Smart Factory Solution' })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'Complete IoT solution for manufacturing facilities',
  })
  @IsString()
  description: string;

  @ApiProperty({
    enum: TemplateCategory,
    example: TemplateCategory.SMART_FACTORY,
  })
  @IsEnum(TemplateCategory)
  category: TemplateCategory;

  @ApiProperty({ example: 'factory-icon' })
  @IsString()
  icon: string;

  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  author: string;

  @ApiProperty({
    example: [
      'Real-time monitoring',
      'Predictive maintenance',
      'Energy optimization',
    ],
  })
  @IsArray()
  features: string[];

  @ApiProperty({ example: 10, required: false })
  @IsOptional()
  @IsNumber()
  devices?: number;

  @ApiProperty({ example: 3, required: false })
  @IsOptional()
  @IsNumber()
  dashboards?: number;

  @ApiProperty({ example: 5, required: false })
  @IsOptional()
  @IsNumber()
  rules?: number;

  @ApiProperty({
    example: ['manufacturing', 'industry-4.0', 'automation'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isPremium?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  configuration?: {
    devices?: any[];
    dashboards?: any[];
    rules?: any[];
    widgets?: any[];
  };

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  previewImage?: string;
}

export class InstallTemplateDto {
  @ApiProperty({ example: 'My Factory Installation', required: false })
  @IsOptional()
  @IsString()
  installationName?: string;

  @ApiProperty({ example: { location: 'Building A' }, required: false })
  @IsOptional()
  @IsObject()
  customization?: any;
}
