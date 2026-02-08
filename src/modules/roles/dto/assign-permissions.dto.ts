import { IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignPermissionsDto {
  @ApiProperty({ 
    example: ['123e4567-e89b-12d3-a456-426614174001', '123e4567-e89b-12d3-a456-426614174002'],
    description: 'Array of permission IDs to assign to this role'
  })
  @IsArray()
  @IsUUID('4', { each: true })
  permissionIds: string[];
}