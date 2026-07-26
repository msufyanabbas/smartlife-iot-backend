import { IsEnum, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FirmwareTargetType } from '@common/enums/index.enum';

export class AssignFirmwareDto {
  @ApiProperty({ enum: FirmwareTargetType, enumName: 'FirmwareTargetType' })
  @IsEnum(FirmwareTargetType)
  targetType: FirmwareTargetType;

  @ApiProperty({ example: 'device-uuid-or-profile-uuid' })
  @IsUUID()
  targetId: string;
}
