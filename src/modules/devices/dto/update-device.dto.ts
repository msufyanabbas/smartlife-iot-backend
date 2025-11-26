import { ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { CreateDeviceDto } from './create-device.dto';
import { DeviceStatus } from '../entities/device.entity';

export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {
  @ApiPropertyOptional({
    enum: DeviceStatus,
    example: DeviceStatus.ACTIVE,
    description: 'Device status',
  })
  @IsEnum(DeviceStatus)
  @IsOptional()
  status?: DeviceStatus;
}
