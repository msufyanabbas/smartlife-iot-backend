import { ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsObject, IsOptional } from 'class-validator';
import { CreateDeviceDto } from './create-device.dto';
import { DeviceStatus } from '@common/enums/index.enum';

export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {
  @ApiPropertyOptional({
    enum: DeviceStatus,
    example: DeviceStatus.ACTIVE,
    description: 'Device status',
  })
  @IsEnum(DeviceStatus)
  @IsOptional()
  status?: DeviceStatus;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, any>;
}
