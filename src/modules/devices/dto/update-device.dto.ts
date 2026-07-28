// PartialType comes from @nestjs/swagger, not @nestjs/mapped-types: both copy
// the validation metadata, but only the swagger one carries @ApiProperty over,
// so the inherited fields (assetId included) show up in the PATCH docs.
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsEnum, IsObject, IsOptional } from 'class-validator';
import { CreateDeviceDto } from './create-device.dto';
import { DeviceStatus } from '@common/enums/index.enum';

export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {
  @ApiPropertyOptional({
    type: String, enum: DeviceStatus, enumName: 'DeviceStatus',
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
