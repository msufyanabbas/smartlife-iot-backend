import { IsString, IsOptional, IsBoolean, IsArray, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({ example: 'Device Manager' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Manages all IoT devices in the system' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: '123e4567-e89b-12d3-a456-426614174000' })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({ example: false })
  @IsBoolean()
  @IsOptional()
  isSystem?: boolean;

  @ApiPropertyOptional({ 
    example: ['123e4567-e89b-12d3-a456-426614174001', '123e4567-e89b-12d3-a456-426614174002'],
    description: 'Array of permission IDs to assign to this role'
  })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  permissionIds?: string[];
}