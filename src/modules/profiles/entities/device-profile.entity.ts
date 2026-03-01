import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import { Tenant } from '@/modules/index.entities';
import { DeviceProvisionType, DeviceTransportType } from '@common/enums/index.enum';

@Entity('device_profiles')
@Index(['tenantId', 'name'])
@Index(['tenantId', 'default'])
export class DeviceProfile extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column()
  @Index()
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: false })
  @Index()
  default: boolean;

  @Column({ nullable: true })
  type?: string;  // 'temperature_sensor', 'gateway', 'tracker'

  @Column({ nullable: true })
  image?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSPORT & PROVISION
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'enum', enum: DeviceTransportType, default: DeviceTransportType.MQTT })
  transportType: DeviceTransportType;

  @Column({ type: 'enum', enum: DeviceProvisionType, default: DeviceProvisionType.DISABLED })
  provisionType: DeviceProvisionType;

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSPORT CONFIGURATION (Protocol Settings)
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  transportConfiguration?: {
    mqtt?: {
      deviceTelemetryTopic?: string;      // WHERE device publishes telemetry
      deviceAttributesTopic?: string;     // WHERE device reads attributes
      deviceRpcRequestTopic?: string;     // WHERE device receives commands
      deviceRpcResponseTopic?: string;    // WHERE device sends command responses
      sparkplug?: boolean;                // Use Sparkplug B protocol?
    };
    http?: {
      baseUrl?: string;                   // API endpoint
      authMethod?: 'basic' | 'bearer' | 'apikey';
      headers?: Record<string, string>;
    };
    coap?: {
      powerMode?: 'PSM' | 'DRX' | 'ALWAYS_ON';  // Power Saving Mode
      edrxCycle?: number;                 // Extended DRX cycle (seconds)
      psmActiveTimer?: number;
    };
    lwm2m?: {
      bootstrapServer?: string;
      securityMode?: 'PSK' | 'RPK' | 'X509';
    };
  };

  // Example for MQTT Temperature Sensor:
  // transportConfiguration: {
  //   mqtt: {
  //     deviceTelemetryTopic: 'devices/temp-sensors/telemetry',
  //     deviceAttributesTopic: 'devices/temp-sensors/attributes',
  //     deviceRpcRequestTopic: 'devices/temp-sensors/rpc/request',
  //     deviceRpcResponseTopic: 'devices/temp-sensors/rpc/response',
  //     sparkplug: false
  //   }
  // }
  //
  // Example for HTTP Webhook Device:
  // transportConfiguration: {
  //   http: {
  //     baseUrl: 'https://api.smartlife.sa/telemetry',
  //     authMethod: 'bearer',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       'X-API-Version': 'v1'
  //     }
  //   }
  // }
  //
  // Example for LoRaWAN (via CoAP):
  // transportConfiguration: {
  //   coap: {
  //     powerMode: 'PSM',               // Power Saving Mode
  //     edrxCycle: 20,                  // Wake every 20 seconds
  //     psmActiveTimer: 60              // Active for 60 seconds
  //   }
  // }
  //
  // NOTE: Your MQTT service subscribes to broad patterns like:
  // - 'devices/+/telemetry'  (catches devices/temp-sensors/telemetry)
  // - 'sensors/+/data'       (catches sensors/ws202/data)
  // So when you create a profile with topic 'devices/temp-sensors/telemetry',
  // your wildcard subscription 'devices/+/telemetry' automatically catches it!

  // ══════════════════════════════════════════════════════════════════════════
  // TELEMETRY CONFIGURATION (What data does this device send?)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  telemetryConfig?: {
    keys: Array<{
      key: string;                      // Telemetry key name
      label?: string;                   // Human-readable label
      type: 'string' | 'long' | 'double' | 'boolean' | 'json';
      unit?: string;                    // °C, %, m/s, etc.
      decimals?: number;
    }>;
  };

  // Example for Temperature/Humidity Sensor:
  // telemetryConfig: {
  //   keys: [
  //     {
  //       key: 'temperature',
  //       label: 'Temperature',
  //       type: 'double',
  //       unit: '°C',
  //       decimals: 1
  //     },
  //     {
  //       key: 'humidity',
  //       label: 'Humidity',
  //       type: 'double',
  //       unit: '%',
  //       decimals: 0
  //     },
  //     {
  //       key: 'battery',
  //       label: 'Battery Level',
  //       type: 'long',
  //       unit: '%',
  //       decimals: 0
  //     },
  //     {
  //       key: 'signalStrength',
  //       label: 'Signal Strength',
  //       type: 'long',
  //       unit: 'dBm',
  //       decimals: 0
  //     }
  //   ]
  // }
  //
  // NOTE: This is just a SCHEMA definition. When device actually sends data,
  // it goes into the Telemetry entity (time-series table).

  // ══════════════════════════════════════════════════════════════════════════
  // ATTRIBUTES CONFIGURATION (Device state/config management)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  attributesConfig?: {
    server: string[];   // Server sets, device reads (e.g., firmware URL)
    shared: string[];   // Server sets, device can read/write (e.g., interval)
    client: string[];   // Device sets, server reads (e.g., signal strength)
  };

  // Example:
  // attributesConfig: {
  //   server: [
  //     'firmwareVersion',              // Server tells device: "You have v1.2.3"
  //     'firmwareUrl',                  // Server tells device: "Download from..."
  //     'configUrl'                     // Server tells device: "Config at..."
  //   ],
  //   shared: [
  //     'reportingInterval',            // Server sets to 60, device reads it
  //     'temperatureThreshold',         // Both can modify
  //     'alarmEnabled'
  //   ],
  //   client: [
  //     'currentFirmwareVersion',       // Device reports: "I'm running v1.2.3"
  //     'lastRebootTime',               // Device reports: "I rebooted at..."
  //     'rssi',                         // Device reports signal strength
  //     'uptime'                        // Device reports how long it's been on
  //   ]
  // }
  //
  // NOTE: Actual attribute VALUES are stored in the Attribute entity,
  // with scope='SERVER'|'SHARED'|'CLIENT' matching this config.

  // ══════════════════════════════════════════════════════════════════════════
  // ALARM RULES (Templates for creating Alarm entities)
  // ══════════════════════════════════════════════════════════════════════════
  
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

  // Example:
  // alarmRules: [
  //   {
  //     id: 'high-temp-alarm',
  //     alarmType: 'HIGH_TEMPERATURE',
  //     severity: 'CRITICAL',
  //     createCondition: {
  //       condition: [
  //         {
  //           key: { key: 'temperature', type: 'TIME_SERIES' },
  //           valueType: 'NUMERIC',
  //           predicate: {
  //             operation: 'GREATER',
  //             value: { defaultValue: 35 }
  //           }
  //         }
  //       ],
  //       spec: { type: 'SIMPLE' }
  //     },
  //     clearCondition: {
  //       condition: [
  //         {
  //           key: { key: 'temperature', type: 'TIME_SERIES' },
  //           predicate: {
  //             operation: 'LESS_OR_EQUAL',
  //             value: { defaultValue: 30 }
  //           }
  //         }
  //       ]
  //     },
  //     propagate: true,
  //     propagateRelationTypes: ['Contains']
  //   }
  // ]
  //
  // NOTE: This is a TEMPLATE. When temperature > 35°C:
  // 1. System reads this rule from DeviceProfile
  // 2. Creates an actual Alarm ENTITY with status='ACTIVE'
  // 3. When temperature drops to 30°C, Alarm entity status → 'CLEARED'

  // ══════════════════════════════════════════════════════════════════════════
  // PROVISIONING (How new devices register)
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  provisionConfiguration?: {
    type?: 'DISABLED' | 'ALLOW_CREATE_NEW_DEVICES' | 'CHECK_PRE_PROVISIONED_DEVICES';
    provisionDeviceKey?: string;        // Shared key for all devices of this profile
    provisionDeviceSecret?: string;     // Shared secret
  };

  // Example for Auto-Provisioning:
  // provisionConfiguration: {
  //   type: 'ALLOW_CREATE_NEW_DEVICES',
  //   provisionDeviceKey: 'smart-life-temp-sensors',
  //   provisionDeviceSecret: 'abc123xyz'
  // }
  //
  // How it works:
  // 1. New device connects with key='smart-life-temp-sensors' and secret='abc123xyz'
  // 2. Server checks: Does this match a DeviceProfile?
  // 3. Server auto-creates Device entity with this profile
  //
  // Example for Pre-Provisioned Only:
  // provisionConfiguration: {
  //   type: 'CHECK_PRE_PROVISIONED_DEVICES'
  // }
  // → Device MUST be manually added to DB before it can connect

  // ══════════════════════════════════════════════════════════════════════════
  // FIRMWARE OTA UPDATES
  // ══════════════════════════════════════════════════════════════════════════

  @Column({ type: 'jsonb', nullable: true })
  firmwareConfiguration?: {
    defaultFirmwareId?: string;         // Which firmware to use
    firmwareUpdateStrategy?: 'immediately' | 'on_connect' | 'scheduled';
    scheduledTime?: string;             // "02:00" (2 AM daily)
  };

  // Example:
  // firmwareConfiguration: {
  //   defaultFirmwareId: 'fw-ws202-v1.2.3',
  //   firmwareUpdateStrategy: 'on_connect',
  //   scheduledTime: '02:00'
  // }
  //
  // How it works:
  // 1. Device connects and reports: firmwareVersion='1.0.0'
  // 2. Server checks: defaultFirmwareId points to 'fw-ws202-v1.2.3'
  // 3. Server sends: "Update firmware to v1.2.3 from https://firmware.smartlife.sa/..."
  // 4. Device downloads, updates, reboots
  // 5. Device reconnects and reports: firmwareVersion='1.2.3'

  // ══════════════════════════════════════════════════════════════════════════
  // RULE CHAINS & DASHBOARDS 
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ nullable: true })
  defaultDashboardId?: string;

  @Column({ nullable: true })
  defaultQueueName?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // METADATA
  // ══════════════════════════════════════════════════════════════════════════
  
  @Column({ type: 'jsonb', nullable: true })
  additionalInfo?: Record<string, any>;
  // Example:
  // additionalInfo: {
  //   manufacturer: 'Milesight',
  //   supportUrl: 'https://support.milesight-iot.com',
  //   documentationUrl: 'https://docs.smartlife.sa/devices/ws202',
  //   category: 'environmental-sensor'
  // }
}
