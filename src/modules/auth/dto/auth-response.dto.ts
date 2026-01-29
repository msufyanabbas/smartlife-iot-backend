import { UserRole } from '@common/enums/index.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class UserInfoDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Unique user identifier',
  })
  id: string;

  @ApiProperty({
    example: 'john.doe@smartlife.sa',
    description: 'User email address',
  })
  email: string;

  @ApiProperty({
    example: 'John Doe',
    description: 'User full name',
  })
  name: string;

  @ApiProperty({
    example: UserRole.TENANT_ADMIN,
    description: 'User role',
    enum: UserRole,
  })
  role: UserRole;

  @ApiPropertyOptional({
    example: 'tenant-uuid',
    description: 'Tenant ID (if user belongs to a tenant)',
  })
  tenantId?: string;

  @ApiPropertyOptional({
    example: 'customer-uuid',
    description: 'Customer ID (if user belongs to a customer)',
  })
  customerId?: string;
}

export class AuthResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token',
  })
  accessToken: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT refresh token',
  })
  refreshToken: string;

  @ApiProperty({
    example: 900,
    description: 'Access token expiration time in seconds',
  })
  expiresIn: number;

  @ApiProperty({
    example: 'Bearer',
    description: 'Token type',
  })
  tokenType: string;

  @ApiProperty({
    description: 'User information',
    example: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      email: 'user@example.com',
      name: 'John Doe',
      role: 'user',
    },
  })
  user: UserInfoDto;
}
