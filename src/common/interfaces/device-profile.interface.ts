// src/common/interfaces/device-profile.interface.ts
import type {
  AlarmConditionKeyType,
  AlarmConditionSpecType,
  AlarmConditionTimeUnit,
  AlarmConditionValueType,
  AlarmPredicateOperation,
  CoapPowerMode,
  DevicePayloadType,
} from '@common/enums/index.enum';

// ═══════════════════════════════════════════════════════════════════════════
// TRANSPORT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface MqttTransportConfig {
  /** Topic the device publishes telemetry to. Default v1/devices/me/telemetry */
  deviceTelemetryTopic?: string;
  /** Topic the device publishes/reads attributes on. */
  deviceAttributesTopic?: string;
  /** Topic the device requests attribute values on. */
  deviceAttributesRequestTopic?: string;
  /** Topic the device receives RPC commands on. */
  deviceRpcRequestTopic?: string;
  /** Topic the device answers RPC commands on. */
  deviceRpcResponseTopic?: string;
  /** Ack a malformed payload instead of dropping it silently. */
  sendAckOnValidationException?: boolean;
  devicePayloadType?: DevicePayloadType | 'JSON' | 'PROTOBUF';
}

export interface HttpTransportConfig {
  deviceTelemetryUrl?: string;
  deviceAttributesUrl?: string;
  /** Bytes. Default 65536. */
  maxPayloadSize?: number;
}

export interface CoapTransportConfig {
  deviceTelemetryPath?: string;
  deviceAttributesPath?: string;
  powerMode?: CoapPowerMode | 'PSM' | 'DRX' | 'E_DRX';
  psmActivityTimer?: number;
  edrxCycle?: number;
}

export interface Lwm2mTransportConfig {
  /** OMA object IDs the server should read/observe, e.g. 3 (Device), 3303 (Temperature). */
  objectIds?: number[];
  /** Subscribe to notifications for those objects as soon as the client registers. */
  observeOnConnect?: boolean;
  /** Seconds. How long a registration stays valid before the client must update it. */
  lifetime?: number;
  /** Seconds between client-initiated registration updates. */
  defaultMinPeriod?: number;
  /** LwM2M 1.1 binding: U=UDP, T=TCP, S=SMS, N=Non-IP (values may be combined). */
  binding?: string;
  /** Transmit a reduced object set and let the client fetch the rest on demand. */
  bootstrapServerUpdateEnabled?: boolean;
}

/**
 * SNMP polling settings.
 *
 * SNMP inverts the usual direction: the platform POLLS the device rather than
 * the device pushing to the platform, so this config describes how to reach the
 * agent and which OIDs to read — there are no topics or ingest URLs.
 */
export interface SnmpTransportConfig {
  /** Agent port. 161 is the SNMP default. */
  port?: number;
  /** Protocol version the agent speaks. */
  version?: 'v1' | 'v2c' | 'v3';
  /** Shared secret for v1/v2c. v3 uses user-based security instead. */
  community?: string;
  /** Seconds between polls. */
  pollPeriodSeconds?: number;
  /** Milliseconds to wait for a response before giving up on one poll. */
  timeoutMs?: number;
  retries?: number;
  /** Which OIDs to read, and what telemetry key each maps to. */
  oidMappings?: Array<{
    oid: string;
    key: string;
    dataType?: 'string' | 'number' | 'boolean';
  }>;
}

/**
 * Protocol-specific settings for a device profile. Only the sub-object
 * matching the profile's `transportType` is meaningful; the others are kept
 * so switching transport does not discard previously entered settings.
 */
export interface DeviceTransportConfiguration {
  mqtt?: MqttTransportConfig;
  http?: HttpTransportConfig;
  coap?: CoapTransportConfig;
  lwm2m?: Lwm2mTransportConfig;
  snmp?: SnmpTransportConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// ALARM RULES
// ═══════════════════════════════════════════════════════════════════════════

/** Threshold, either a literal or resolved from another entity's attribute. */
export interface AlarmPredicateValue {
  defaultValue: number | string | boolean;
  dynamicValue?: {
    sourceType: string;
    sourceAttribute: string;
  };
}

export interface AlarmPredicate {
  operation: AlarmPredicateOperation;
  value: AlarmPredicateValue;
  /** Upper bound — only read when operation is BETWEEN. */
  value2?: AlarmPredicateValue;
}

export interface AlarmConditionFilter {
  /** Telemetry / attribute key under test, e.g. "temperature". */
  key: string;
  type: AlarmConditionKeyType | 'TIME_SERIES' | 'ATTRIBUTE' | 'ENTITY_FIELD';
  valueType: AlarmConditionValueType | 'NUMERIC' | 'STRING' | 'BOOLEAN';
  predicate: AlarmPredicate;
}

export interface AlarmConditionSpec {
  type: AlarmConditionSpecType | 'SIMPLE' | 'DURATION' | 'REPEATING';
  unit?: AlarmConditionTimeUnit;
  value?: number;
}

export interface AlarmRuleCondition {
  spec: AlarmConditionSpec;
  /** ALL filters must match for the rule to fire (AND semantics). */
  condition: AlarmConditionFilter[];
}

/**
 * One alarm rule declared on a DeviceProfile. This is a TEMPLATE: when the
 * condition matches for a device using the profile, ProfileAlarmService
 * materialises / triggers a concrete Alarm entity.
 */
export interface DeviceProfileAlarmRule {
  id: string;
  /** Becomes Alarm.name, e.g. "High Temperature". */
  alarmType: string;
  enabled: boolean;
  severity: 'critical' | 'error' | 'warning' | 'info';
  /** Propagate to related assets. */
  propagate: boolean;
  propagateToOwner: boolean;
  propagateToTenant: boolean;
  condition: AlarmRuleCondition;
  /** When these filters match, an active alarm is cleared. */
  clearRule?: {
    condition: AlarmConditionFilter[];
  };
  dashboardId?: string;
  alarmDetails?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// FIRMWARE / OTA
// ═══════════════════════════════════════════════════════════════════════════

export interface DeviceProfileFirmwareConfig {
  title?: string;
  version?: string;
  firmwareId?: string;
}
