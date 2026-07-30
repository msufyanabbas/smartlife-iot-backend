import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { BaseEntity } from '@common/entities/base.entity';
import type { Relation } from 'typeorm';
import type { Tenant } from '../../tenants/entities/tenant.entity';
import { DeviceProvisionType, DeviceTransportType } from '@common/enums/index.enum';
import type {
  DeviceProfileAlarmRule,
  DeviceProfileFirmwareConfig,
  DeviceTransportConfiguration,
} from '@common/interfaces/index.interface';

@Entity('device_profiles')
@Index(['tenantId', 'name'])
@Index(['tenantId', 'default'])
export class DeviceProfile extends BaseEntity {
  // ══════════════════════════════════════════════════════════════════════════
  // TENANT SCOPING (REQUIRED)
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  tenantId: string;

  @ManyToOne('Tenant')
  @JoinColumn({ name: 'tenantId' })
  tenant: Relation<Tenant>;

  // ══════════════════════════════════════════════════════════════════════════
  // BASIC INFO
  // ══════════════════════════════════════════════════════════════════════════

  @Column()

  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: false })

  default: boolean;

  @Column({ nullable: true })
  type?: string;  // 'temperature_sensor', 'gateway', 'tracker'

  @Column({ nullable: true })
  image?: string;

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE (One to Many Relationship)
  // ══════════════════════════════════════════════════════════════════════════
  // @Column()
  // deviceId: string;

  // @OneToMany(() => Device, device => device.deviceProfile, { onDelete: 'CASCADE' })
  // @JoinColumn({ name: 'deviceId' })
  // device: Device;

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSPORT & PROVISION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Stored as varchar rather than a PG enum so new transports need no DB enum
   * migration. Values are UPPERCASE (ThingsBoard contract) — the original
   * lowercase values were converted in the DeviceAssetProfileEnhancements
   * migration.
   */
  @Column({ type: 'varchar', default: DeviceTransportType.DEFAULT })
  transportType: DeviceTransportType;

  @Column({ type: 'varchar', default: DeviceProvisionType.DISABLED })
  provisionType: DeviceProvisionType;

  /**
   * Shared key/secret a device presents to self-register under this profile.
   * Only meaningful when provisionType !== DISABLED.
   *
   * NOTE: these supersede the legacy `provisionConfiguration` jsonb below,
   * which is retained (and backfilled from) for backwards compatibility.
   */
  @Column({ type: 'varchar', nullable: true })
  provisionDeviceKey?: string | null;

  @Column({ type: 'varchar', nullable: true })
  provisionDeviceSecret?: string | null;

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSPORT CONFIGURATION (Protocol Settings)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Protocol-specific settings. Populated with sensible defaults for the
   * chosen `transportType` by DeviceProfilesService.getDefaultTransportConfig()
   * when the caller does not supply one.
   *
   * Shape: see DeviceTransportConfiguration in
   * src/common/interfaces/device-profile.interface.ts
   *
   * Example (MQTT):
   *   { mqtt: { deviceTelemetryTopic: 'v1/devices/me/telemetry',
   *             devicePayloadType: 'JSON' } }
   */
  @Column({ type: 'jsonb', nullable: true })
  transportConfiguration?: DeviceTransportConfiguration | null;

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

  /**
   * Alarm templates evaluated by ProfileAlarmService every time telemetry
   * arrives for a device using this profile. This is NOT an alarm — when a
   * rule matches, a concrete Alarm entity is materialised / triggered.
   *
   * Shape: see DeviceProfileAlarmRule in
   * src/common/interfaces/device-profile.interface.ts
   *
   * Example:
   *   [{ id: 'alarm-1', alarmType: 'High Temperature', enabled: true,
   *      severity: 'critical', propagate: true, propagateToOwner: true,
   *      propagateToTenant: false,
   *      condition: { spec: { type: 'SIMPLE' }, condition: [{
   *        key: 'temperature', type: 'TIME_SERIES', valueType: 'NUMERIC',
   *        predicate: { operation: 'GREATER', value: { defaultValue: 40 } } }] },
   *      clearRule: { condition: [{ key: 'temperature', type: 'TIME_SERIES',
   *        valueType: 'NUMERIC',
   *        predicate: { operation: 'LESS_OR_EQUAL', value: { defaultValue: 35 } } }] } }]
   */
  @Column({ type: 'jsonb', nullable: true })
  alarmRules?: DeviceProfileAlarmRule[] | null;

  // ══════════════════════════════════════════════════════════════════════════
  // PROVISIONING (legacy jsonb — superseded by provisionDeviceKey/Secret)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @deprecated Use `provisionType` + `provisionDeviceKey` +
   * `provisionDeviceSecret`. Retained so seeded rows are not lost; the
   * DeviceAssetProfileEnhancements migration backfills the flat columns
   * from this object.
   */
  @Column({ type: 'jsonb', nullable: true })
  provisionConfiguration?: {
    type?: string;
    provisionDeviceKey?: string;
    provisionDeviceSecret?: string;
  } | null;

  // ══════════════════════════════════════════════════════════════════════════
  // QUEUE, DASHBOARD & OTA
  // ══════════════════════════════════════════════════════════════════════════

  /** Kafka queue this profile's telemetry is routed to. */
  @Column({ type: 'varchar', nullable: true })
  queueName?: string | null;

  @Column({ nullable: true })
  defaultRuleChainId?: string;

  @Column({ type: 'uuid', nullable: true })
  defaultDashboardId?: string | null;

  /** Firmware package pushed to devices of this profile. */
  @Column({ type: 'jsonb', nullable: true })
  firmwareConfig?: DeviceProfileFirmwareConfig | null;

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
