import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

export enum DeviceTransportType {
  MQTT = 'mqtt',
  HTTP = 'http',
  COAP = 'coap',
  LWM2M = 'lwm2m',
  SNMP = 'snmp',
}

export enum DeviceProvisionType {
  DISABLED = 'disabled',
  ALLOW_CREATE_NEW = 'allow_create_new',
  CHECK_PRE_PROVISIONED = 'check_pre_provisioned',
}

@Entity('device_profiles')
export class DeviceProfile extends BaseEntity {
  @Column({ unique: true })
  @Index()
  name: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ nullable: true })
  @Index()
  tenantId?: string;

  @Column({ default: true })
  default: boolean;

  // Device type and category
  @Column({ nullable: true })
  type?: string; // e.g., 'temperature_sensor', 'gateway', 'tracker'

  @Column({
    type: 'enum',
    enum: DeviceTransportType,
    default: DeviceTransportType.MQTT,
  })
  transportType: DeviceTransportType;

  @Column({
    type: 'enum',
    enum: DeviceProvisionType,
    default: DeviceProvisionType.DISABLED,
  })
  provisionType: DeviceProvisionType;

  // Transport configuration (protocol-specific settings)
  @Column({ type: 'jsonb', nullable: true })
  transportConfiguration?: {
    mqtt?: {
      deviceTelemetryTopic?: string;
      deviceAttributesTopic?: string;
      sparkplug?: boolean;
    };
    http?: {
      baseUrl?: string;
      authMethod?: string;
    };
    coap?: {
      powerMode?: string;
      edrxCycle?: number;
    };
  };

  // Profile data (telemetry keys, attributes, etc.)
  @Column({ type: 'jsonb', nullable: true })
  profileData?: {
    configuration?: {
      type?: string;
    };
    transportConfiguration?: any;
    provisionConfiguration?: any;
    alarms?: Array<{
      id: string;
      alarmType: string;
      createRules?: Record<string, any>;
      clearRule?: Record<string, any>;
      propagate?: boolean;
    }>;
  };

  // Telemetry and attributes configuration
  @Column({ type: 'jsonb', nullable: true })
  telemetryConfig?: {
    keys: Array<{
      key: string;
      label?: string;
      type: 'string' | 'long' | 'double' | 'boolean' | 'json';
      unit?: string;
      decimals?: number;
    }>;
  };

  @Column({ type: 'jsonb', nullable: true })
  attributesConfig?: {
    server: string[]; // Server-side attributes
    shared: string[]; // Shared attributes
    client: string[]; // Client-side attributes
  };

  // Alarm rules (like ThingsBoard)
  @Column({ type: 'jsonb', nullable: true })
  alarmRules?: Array<{
    id: string;
    alarmType: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
    createCondition: {
      condition: Array<{
        key: { key: string; type: string };
        valueType: string;
        predicate: {
          operation: string;
          value: any;
        };
      }>;
      spec?: {
        type: string;
      };
    };
    clearCondition?: any;
    propagate?: boolean;
    propagateRelationTypes?: string[];
  }>;

  // Device provisioning configuration
  @Column({ type: 'jsonb', nullable: true })
  provisionConfiguration?: {
    type?: string;
    provisionDeviceKey?: string;
    provisionDeviceSecret?: string;
  };

  // Firmware configuration
  @Column({ type: 'jsonb', nullable: true })
  firmwareConfiguration?: {
    defaultFirmwareId?: string;
    firmwareUpdateStrategy?: 'immediately' | 'on_connect' | 'scheduled';
  };

  // Rule chain configuration
  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ nullable: true })
  defaultDashboardId?: string;

  @Column({ nullable: true })
  defaultQueueName?: string;

  // Image
  @Column({ nullable: true })
  image?: string;

  // Additional info
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
}
