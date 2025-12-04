import { ApiProperty } from '@nestjs/swagger';

export class TwoFactorChallengeDto {
  @ApiProperty({ example: true })
  requires2FA: boolean;

  @ApiProperty({ example: 'user-id-123' })
  userId: string;

  @ApiProperty({ example: 'authenticator' })
  method: string;
}