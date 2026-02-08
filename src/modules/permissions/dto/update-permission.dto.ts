import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreatePermissionDto } from './create-permission.dto';

export class UpdatePermissionDto extends PartialType(CreatePermissionDto) {
  @ApiProperty({
    description: 'Resource that the permission applies to',
    example: 'devices',
    required: false,
  })
  resource?: string;

  @ApiProperty({
    description: 'Action that can be performed on the resource',
    example: 'update',
    required: false,
  })
  action?: string;
}