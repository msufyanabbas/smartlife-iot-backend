import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { EmailTemplateType } from '../entities/email-template.entity';

export class CreateEmailTemplateDto {
  @ApiProperty({
    description: 'Type of email template',
    enum: EmailTemplateType,
    example: EmailTemplateType.VERIFICATION,
  })
  @IsEnum(EmailTemplateType)
  @IsNotEmpty()
  type: EmailTemplateType;

  @ApiProperty({
    description: 'Template name',
    example: 'Email Verification Template',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Email subject line (can use variables like {{name}})',
    example: 'Verify Your Email - {{appName}}',
  })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({
    description: 'HTML template with placeholders (use {{variableName}})',
    example: '<h1>Hi {{name}},</h1><p>Please verify your email...</p>',
  })
  @IsString()
  @IsNotEmpty()
  htmlTemplate: string;

  @ApiProperty({
    description: 'Plain text template with placeholders',
    example: 'Hi {{name}}, Please verify your email...',
  })
  @IsString()
  @IsNotEmpty()
  textTemplate: string;

  @ApiProperty({
    description: 'Available variables for this template',
    example: { name: 'User name', email: 'User email', verificationUrl: 'URL' },
    required: false,
  })
  @IsObject()
  @IsOptional()
  variables?: Record<string, any>;

  @ApiProperty({
    description: 'Template description',
    example: 'Template sent to users for email verification',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Is template active',
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
