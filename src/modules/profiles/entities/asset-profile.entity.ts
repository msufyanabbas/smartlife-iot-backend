import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

@Entity('asset_profiles')
export class AssetProfile extends BaseEntity {
  @Column({ unique: true })
  @Index()
  name: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  @Column({ default: false })
  default: boolean;

  // Profile image
  @Column({ nullable: true })
  image?: string;

  // Asset attributes configuration
  @Column({ type: 'jsonb', nullable: true })
  attributesConfig?: {
    server: string[]; // Server-side attributes
    shared: string[]; // Shared attributes
  };

  // Dashboard configuration
  @Column({ nullable: true })
  defaultDashboardId?: string;

  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ nullable: true })
  defaultQueueName?: string;

  // Alarm rules for assets
  @Column({ type: 'jsonb', nullable: true })
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: any;
    clearCondition?: any;
    propagate?: boolean;
  }>;

  // Custom fields definition
  @Column({ type: 'jsonb', nullable: true })
  customFields?: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'json';
    required?: boolean;
    defaultValue?: any;
    options?: any[]; // For select/dropdown fields
  }>;

  // Metadata schema
  @Column({ type: 'jsonb', nullable: true })
  metadataSchema?: {
    properties: Record<
      string,
      {
        type: string;
        title?: string;
        description?: string;
        required?: boolean;
      }
    >;
  };

  // Additional info
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
