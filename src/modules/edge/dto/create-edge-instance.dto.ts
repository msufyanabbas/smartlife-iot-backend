import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateEdgeInstanceDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  location: string;

  @ApiProperty()
  @IsString()
  version: string;

  @ApiProperty()
  @IsString()
  ipAddress: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  metrics?: {
    cpu: number;
    memory: number;
    storage: number;
    uptime: string;
  };
}
