import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class CreatePermissionDto {
  @ApiProperty({
    description: 'Resource that the permission applies to',
    example: 'devices',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  resource: string;

  @ApiProperty({
    description: 'Action that can be performed on the resource',
    example: 'create',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  action: string;

  @ApiProperty({
    description: 'Detailed description of what this permission allows',
    example: 'Allows creation of new devices in the system',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Whether this is a system-level permission that cannot be deleted',
    example: true,
    default: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isSystem?: boolean;
}