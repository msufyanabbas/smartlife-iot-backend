// src/modules/auth/dto/auth-response.dto.ts
import { UserRole } from '@common/enums/index.enum';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserInfoDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: 'john.doe@smartlife.sa' })
  email: string;

  @ApiProperty({ example: 'John Doe' })
  name: string;

  @ApiProperty({ enum: UserRole, example: UserRole.TENANT_ADMIN })
  role: UserRole;

  // Frontend needs this immediately after login to show the "verify email" banner
  @ApiProperty({ example: false })
  emailVerified: boolean;

  @ApiPropertyOptional({ example: 'tenant-uuid' })
  tenantId?: string;

  @ApiPropertyOptional({ example: 'customer-uuid' })
  customerId?: string;

  // Denormalized from subscription — prevents an extra GET /subscriptions
  // call after every login just to show/hide plan-gated UI elements
  @ApiPropertyOptional({ example: 'free' })
  plan?: string;
}

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  refreshToken: string;

  @ApiProperty({ example: 900, description: 'Access token expiry in seconds (15 min = 900)' })
  expiresIn: number;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({ type: UserInfoDto })
  user: UserInfoDto;
}
