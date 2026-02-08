import { ApiProperty } from '@nestjs/swagger';

export class PermissionResponseDto {
  @ApiProperty({
    description: 'Unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id: string;

  @ApiProperty({
    description: 'Resource that the permission applies to',
    example: 'devices',
  })
  resource: string;

  @ApiProperty({
    description: 'Action that can be performed on the resource',
    example: 'create',
  })
  action: string;

  @ApiProperty({
    description: 'Detailed description of what this permission allows',
    example: 'Allows creation of new devices in the system',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Whether this is a system-level permission',
    example: true,
  })
  isSystem: boolean;

  @ApiProperty({
    description: 'Permission in string format (resource:action)',
    example: 'devices:create',
  })
  permissionString: string;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-01T00:00:00.000Z',
  })
  updatedAt: Date;
}