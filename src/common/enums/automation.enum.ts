// ─────────────────────────────────────────────────────────────────────────────
// LEGACY (v1 engine) — kept so the rows seeded/created before the execution
// engine landed still deserialise. `AutomationService.normaliseTrigger()`
// maps these onto the v2 members below; nothing new should be written with them.
// ─────────────────────────────────────────────────────────────────────────────

export enum TriggerType {
  THRESHOLD = 'threshold',
  STATE = 'state',
  SCHEDULE = 'schedule',
  EVENT = 'event',
}

export enum ActionType {
  CONTROL = 'control',
  SET_VALUE = 'setValue',
  NOTIFICATION = 'notification',
  WEBHOOK = 'webhook',
}

export enum AutomationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 EXECUTION ENGINE
//
// All three are stored inside jsonb columns (`trigger`, `conditions`,
// `actions`), NOT as PG enums — adding a member needs no migration.
// ─────────────────────────────────────────────────────────────────────────────

/** What makes an automation run. */
export enum AutomationTriggerType {
  TELEMETRY = 'TELEMETRY',
  ATTRIBUTE = 'ATTRIBUTE',
  ALARM = 'ALARM',
  DEVICE_STATUS = 'DEVICE_STATUS',
  SCHEDULE = 'SCHEDULE',
  MANUAL = 'MANUAL',
}

/** Comparison used by a single condition row. */
export enum AutomationConditionOperator {
  GT = 'GT',
  LT = 'LT',
  EQ = 'EQ',
  NEQ = 'NEQ',
  GTE = 'GTE',
  LTE = 'LTE',
  BETWEEN = 'BETWEEN',
  CONTAINS = 'CONTAINS',
  EXISTS = 'EXISTS',
}

/** Where a condition reads its actual value from. */
export enum AutomationConditionSource {
  TELEMETRY = 'TELEMETRY',
  ATTRIBUTE = 'ATTRIBUTE',
  DEVICE_FIELD = 'DEVICE_FIELD',
}

/** What an automation does once its conditions pass. */
export enum AutomationActionType {
  SEND_NOTIFICATION = 'SEND_NOTIFICATION',
  SEND_COMMAND = 'SEND_COMMAND',
  UPDATE_ATTRIBUTE = 'UPDATE_ATTRIBUTE',
  CREATE_ALARM = 'CREATE_ALARM',
  CLEAR_ALARM = 'CLEAR_ALARM',
  TRIGGER_RULE_CHAIN = 'TRIGGER_RULE_CHAIN',
  WEBHOOK = 'WEBHOOK',
  UPDATE_DEVICE_STATUS = 'UPDATE_DEVICE_STATUS',
}

/** Outcome of one execution — mirrors AutomationLog.status. */
export enum AutomationExecutionStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  PARTIAL = 'partial',
}
