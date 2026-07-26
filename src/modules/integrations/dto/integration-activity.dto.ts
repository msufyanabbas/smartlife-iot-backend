import { ApiProperty } from '@nestjs/swagger';
import { IntegrationType, IntegrationStatus } from '@common/enums/index.enum';

/**
 * A single derived "recent activity" entry for an integration.
 *
 * NOTE: there is no dedicated integration activity/event log table, so each
 * entry is DERIVED from the integration's current state (most recent relevant
 * timestamp + status), not from a true append-only event stream.
 */
export class IntegrationActivityDto {
  @ApiProperty({ example: 'a1b2c3d4-...', description: 'Integration ID' })
  integrationId: string;

  @ApiProperty({
    example: 'Slack Notifications',
    description: 'Integration name',
  })
  integrationName: string;

  @ApiProperty({ type: String, enum: IntegrationType, enumName: 'IntegrationType', example: IntegrationType.WEBHOOK })
  type: IntegrationType;

  @ApiProperty({
    example: 'Connected',
    description:
      'Synthesized activity type derived from status/enabled (Connected | Error | Disabled)',
  })
  activityType: string;

  @ApiProperty({
    type: String, enum: IntegrationStatus, enumName: 'IntegrationStatus',
    example: IntegrationStatus.ACTIVE,
    description: 'Current integration status',
  })
  status: IntegrationStatus;

  @ApiProperty({
    example: 'Active — 1200/1250 messages succeeded',
    description: 'Human-readable summary (uses lastError when in error state)',
  })
  message: string;

  @ApiProperty({
    example: '2026-06-30T06:26:57.444Z',
    description:
      'Most recent relevant timestamp (max of lastActivity/lastFailure/lastSuccess/updatedAt/createdAt)',
  })
  timestamp: string;
}
