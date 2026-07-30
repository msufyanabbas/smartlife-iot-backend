import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsUrl,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SolutionTemplateCategory as TemplateCategory } from '@common/enums/index.enum';
import type { TemplateConfiguration } from '../interfaces/template-configuration.interface';

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
    type: String, enum: TemplateCategory, enumName: 'TemplateCategory',
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

  @ApiProperty({
    required: false,
    description:
      'Declarative provisioning spec (devices / dashboards / ruleChains / alarms) executed by POST /:id/install',
  })
  @IsOptional()
  @IsObject()
  configuration?: TemplateConfiguration;

  @ApiProperty({ required: false, deprecated: true, description: 'Superseded by imageUrl' })
  @IsOptional()
  @IsString()
  previewImage?: string;

  @ApiPropertyOptional({
    description:
      'Image URL for the template. Must be an absolute URL — to attach a local ' +
      'file use POST /solution-templates/:id/image instead.',
    example: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400',
  })
  @IsOptional()
  @IsString()
  @IsUrl()
  imageUrl?: string;

  @ApiPropertyOptional({
    description: 'Image alt text',
    example: 'Modern smart home automation',
  })
  @IsOptional()
  @IsString()
  imageAlt?: string;
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
