/**
 * Transport a device profile speaks.
 *
 * Stored as varchar (not a PG enum) so new transports need no DB enum
 * migration. Values are UPPERCASE to match the ThingsBoard wire contract.
 *
 * NOTE: the pre-existing lowercase values (`mqtt`, `http`, …) were converted
 * in migration `DeviceAssetProfileEnhancements`. SNMP is retained beyond the
 * ThingsBoard set because a seeded profile ("SNMP Network Device") uses it.
 */
export enum DeviceTransportType {
  DEFAULT = 'DEFAULT',
  MQTT = 'MQTT',
  COAP = 'COAP',
  HTTP = 'HTTP',
  LWM2M = 'LWM2M',
  SNMP = 'SNMP',
}

/**
 * How devices of this profile are allowed to self-register.
 *
 * Stored as varchar. Values are UPPERCASE to match ThingsBoard.
 */
export enum DeviceProvisionType {
  DISABLED = 'DISABLED',
  ALLOW_CREATE_NEW_DEVICES = 'ALLOW_CREATE_NEW_DEVICES',
  CHECK_PRE_PROVISIONED_DEVICES = 'CHECK_PRE_PROVISIONED_DEVICES',
}

/** Payload encoding a device uses on the wire. */
export enum DevicePayloadType {
  JSON = 'JSON',
  PROTOBUF = 'PROTOBUF',
}

/** CoAP power-saving mode negotiated with the device. */
export enum CoapPowerMode {
  PSM = 'PSM',
  DRX = 'DRX',
  E_DRX = 'E_DRX',
}

// ── Alarm-rule vocabulary (device profile `alarmRules`) ─────────────────────

/** How an alarm condition is sustained before it fires. */
export enum AlarmConditionSpecType {
  SIMPLE = 'SIMPLE',
  DURATION = 'DURATION',
  REPEATING = 'REPEATING',
}

export enum AlarmConditionTimeUnit {
  SECONDS = 'SECONDS',
  MINUTES = 'MINUTES',
  HOURS = 'HOURS',
  DAYS = 'DAYS',
}

/** Where the value under test comes from. */
export enum AlarmConditionKeyType {
  TIME_SERIES = 'TIME_SERIES',
  ATTRIBUTE = 'ATTRIBUTE',
  ENTITY_FIELD = 'ENTITY_FIELD',
}

export enum AlarmConditionValueType {
  NUMERIC = 'NUMERIC',
  STRING = 'STRING',
  BOOLEAN = 'BOOLEAN',
}

/** Comparison applied between the observed value and the threshold. */
export enum AlarmPredicateOperation {
  GREATER = 'GREATER',
  LESS = 'LESS',
  EQUAL = 'EQUAL',
  NOT_EQUAL = 'NOT_EQUAL',
  GREATER_OR_EQUAL = 'GREATER_OR_EQUAL',
  LESS_OR_EQUAL = 'LESS_OR_EQUAL',
  BETWEEN = 'BETWEEN',
}
