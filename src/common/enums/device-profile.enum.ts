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

  // ── Industrial / carrier transports ────────────────────────────────────────
  // All three are polling or carrier-borne rather than broker-push, and all
  // three are varchar values, so no DB enum migration is needed for THESE
  // (unlike `devices.protocol`, which is a real PG enum — see
  // IndustrialProtocols1788100000000).
  //
  //  OPCUA  — the platform opens a session to an OPC-UA server and subscribes
  //           to monitored items (OpcuaAdapter). Connection details live in
  //           `opcua_servers`, not in the profile, because the endpoint and its
  //           credentials are per-server, not per-profile.
  //  BACNET — Who-Is / ReadPropertyMultiple against a BACnet/IP device
  //           (BacnetAdapter). Object list lives in `bacnet_devices`.
  //  NB_IOT — a carrier BEARER, not an application protocol. A device marked
  //           NB_IOT still speaks CoAP, MQTT-SN or HTTP on the wire; the
  //           transport type exists so the device can be MODELLED as NB-IoT and
  //           carry its SIM identity and radio metrics (`nbiot_devices`).
  OPCUA = 'OPCUA',
  BACNET = 'BACNET',
  NB_IOT = 'NB_IOT',
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
