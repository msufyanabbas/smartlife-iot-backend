import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

// Enums
export enum QueueName {
  HIGH_PRIORITY = 'HighPriority',
  LOW_PRIORITY = 'LowPriority',
  MAIN = 'Main',
  SEQUENTIAL_BY_ORIGINATOR = 'SequentialByOriginator',
}

export enum SubmitStrategy {
  BURST = 'BURST',
  SEQUENTIAL_BY_ORIGINATOR = 'SEQUENTIAL_BY_ORIGINATOR',
  BATCH = 'BATCH',
}

export enum ProcessingStrategy {
  RETRY_FAILED_AND_TIMED_OUT = 'RETRY_FAILED_AND_TIMED_OUT',
  SKIP_ALL_FAILURES_AND_TIMED_OUT = 'SKIP_ALL_FAILURES_AND_TIMED_OUT',
  SKIP_ALL_FAILURES = 'SKIP_ALL_FAILURES',
  RETRY_ALL = 'RETRY_ALL',
}

export enum AlarmSeverity {
  CRITICAL = 'CRITICAL',
  MAJOR = 'MAJOR',
  MINOR = 'MINOR',
  WARNING = 'WARNING',
  INDETERMINATE = 'INDETERMINATE',
}

@Entity('asset_profiles')
export class AssetProfile extends BaseEntity {
  @Column({ unique: true })
  @Index()
  name: string;

  @Column({ nullable: true, type: 'text' })
  description?: string;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  @Column({ default: false })
  @Index()
  default: boolean;

  @Column({ nullable: true })
  image?: string;

  attributesConfig: any;
  customFields: any;
  metadataSchema: any;

  // ==================== HIERARCHY CONFIGURATION ====================
  
  @Column({ type: 'jsonb', nullable: true })
  hierarchyConfig?: {
    allowChildren: boolean;
    allowedChildTypes?: string[];
    requireParent?: boolean;
    allowedParentTypes?: string[];
    maxDepth?: number;
    inheritAttributesFromParent?: boolean;
    inheritDevicesFromParent?: boolean;
  };

  // ==================== LOCATION CONFIGURATION ====================
  
  @Column({ type: 'jsonb', nullable: true })
  locationConfig?: {
    required: boolean;
    requireAddress?: boolean;
    requireCoordinates?: boolean;
    allowManualEntry?: boolean;
    defaultZoom?: number;
    restrictToRegion?: {
      northEast?: { lat: number; lng: number };
      southWest?: { lat: number; lng: number };
    };
  };

  // ==================== MAP DISPLAY CONFIGURATION ====================
  
  @Column({ type: 'jsonb', nullable: true })
  mapConfig?: {
    icon?: string;
    iconColor?: string;
    markerType?: 'pin' | 'circle' | 'square' | 'custom';
    showLabel?: boolean;
    labelField?: string;
    clusterThreshold?: number;
    popupTemplate?: string;
  };

  // ==================== DEVICE ASSOCIATION RULES ====================
  
  @Column({ type: 'jsonb', nullable: true })
  deviceConfig?: {
    allowDevices: boolean;
    maxDevices?: number;
    allowedDeviceProfileIds?: string[];
    requireDevices?: boolean;
    minDevices?: number;
    inheritDevicesToChildren?: boolean;
    autoAssignByLocation?: boolean;
    locationProximityMeters?: number;
  };

  // ==================== ATTRIBUTES CONFIGURATION ====================
  
  @Column({ type: 'jsonb', nullable: true })
  attributesSchema?: {
    required: Array<{
      key: string;
      label: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
      description?: string;
      validation?: Record<string, any>; // ADD THIS LINE
      options?: Array<{ label: string; value: any }>;
      defaultValue?: any;
    }>;
    optional: Array<{
      key: string;
      label: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'select';
      description?: string;
      defaultValue?: any;
      options?: Array<{ label: string; value: any }>;
      validation?: Record<string, any>; // ADD THIS LINE
    }>;
  };

  @Column({ type: 'simple-array', nullable: true })
  serverAttributeKeys?: string[];

  @Column({ type: 'simple-array', nullable: true })
  sharedAttributeKeys?: string[];

  // ==================== CALCULATED FIELDS ====================
  
  @Column({ type: 'jsonb', nullable: true })
  calculatedFields?: Array<{
    id: string;
    name: string;
    type: 'number' | 'string' | 'boolean';
    expression: string;
    description?: string;
    unit?: string;
    decimalPlaces?: number;
    updateInterval?: number;
  }>;

  // ==================== RULE CHAIN CONFIGURATION ====================
  
  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ nullable: true })
  defaultEdgeRuleChainId?: string;

  // ==================== QUEUE CONFIGURATION ====================
  
  @Column({ nullable: true })
  defaultQueueName?: string;

  @Column({ type: 'jsonb', nullable: true })
  queueConfig?: {
    submitStrategy: string;
    processingStrategy: string;
    packProcessingTimeout?: number;
    submitStrategyCustom?: any;
  };

  // ==================== DASHBOARD CONFIGURATION ====================
  
  @Column({ nullable: true })
  defaultDashboardId?: string;

  @Column({ nullable: true })
  mobileDashboardId?: string;

  // ==================== ALARM RULES ====================
  
  @Column({ type: 'jsonb', nullable: true })
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: {
      condition: any;
      spec?: {
        type: string;
        unit?: string;
        value?: any;
        predicate?: any;
      };
    };
    clearCondition?: {
      condition: any;
      spec?: any;
    };
    propagate: any;
    propagateToParent?: boolean;
    propagateToChildren?: boolean;
    schedule?: {
      type: 'ALWAYS' | 'SPECIFIC_TIME' | 'CUSTOM';
      timezone?: string;
      daysOfWeek?: number[];
      startsOn?: number;
      endsOn?: number;
    };
    alarmDetails?: string;
    dashboardId?: string;
  }>;

  // ==================== METADATA & ADDITIONAL INFO ====================
  
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;

  // ==================== VERSION CONTROL ====================
  
  @Column({ type: 'jsonb', nullable: true })
  versionControl?: {
    enabled: boolean;
    repositoryUrl?: string;
    branch?: string;
    readOnly?: boolean;
    showMergeCommits?: boolean;
    authMethod?: 'password' | 'ssh' | 'token';
    username?: string;
  };
}