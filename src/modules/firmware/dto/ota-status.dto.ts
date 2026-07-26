import { IsEnum, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FirmwareUpdateStatus } from '@common/enums/index.enum';

/** Device-reported OTA progress. Sent to POST /ota/:deviceToken/status. */
export class OtaStatusDto {
  @ApiProperty({ type: String, enum: FirmwareUpdateStatus, enumName: 'FirmwareUpdateStatus' })
  @IsEnum(FirmwareUpdateStatus)
  status: FirmwareUpdateStatus;

  @ApiPropertyOptional({ example: 42, description: 'Progress 0-100' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional({ example: 'checksum mismatch' })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiPropertyOptional({
    example: '1.0.1',
    description: 'Version installed on SUCCESS',
  })
  @IsOptional()
  @IsString()
  installedVersion?: string;
}
