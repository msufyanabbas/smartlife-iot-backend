import { IsString, IsOptional, IsUUID, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFirmwareDto {
  @ApiProperty({ example: '1.0.1', description: 'Semantic firmware version' })
  @IsString()
  @MinLength(1)
  version: string;

  @ApiProperty({
    example: 'WS202 sensor firmware',
    description: 'Human-readable title',
  })
  @IsString()
  @MinLength(1)
  title: string;

  @ApiPropertyOptional({ example: 'Fixes battery reporting drift' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: 'device-profile-uuid',
    description: 'Target device profile; omit for any device',
  })
  @IsOptional()
  @IsUUID()
  deviceProfileId?: string;
}
