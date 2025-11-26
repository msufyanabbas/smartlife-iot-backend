import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsDateString,
  IsObject,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  ResourceType,
  ShareType,
  AccessLevel,
} from '../entities/sharing.entity';

export class CreateShareDto {
  @ApiProperty({ enum: ResourceType, example: ResourceType.DASHBOARD })
  @IsEnum(ResourceType)
  resourceType: ResourceType;

  @ApiProperty({ example: 'dashboard-uuid-123' })
  @IsString()
  resourceId: string;

  @ApiProperty({ enum: ShareType, example: ShareType.EMAIL })
  @IsEnum(ShareType)
  shareType: ShareType;

  @ApiProperty({ example: 'user@example.com', required: false })
  @IsOptional()
  @IsString()
  sharedWith?: string;

  @ApiProperty({ enum: AccessLevel, example: AccessLevel.VIEW })
  @IsEnum(AccessLevel)
  accessLevel: AccessLevel;

  @ApiProperty({ example: '2025-12-31T23:59:59Z', required: false })
  @IsOptional()
  @IsDateString()
  expiresAt?: Date;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({
    example: {
      resourceName: 'My Dashboard',
      message: 'Check out this dashboard',
    },
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: {
    resourceName?: string;
    message?: string;
    permissions?: string[];
  };
}
