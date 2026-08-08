// src/common/enums/schedule.enum.ts

/**
 * How a schedule is timed.
 *
 * Replaces the old `ScheduleType` (REPORT | BACKUP | CLEANUP | EXPORT |
 * DEVICE_COMMAND), which conflated *when* a schedule fires with *what* it does.
 * The "what" now lives in {@link ScheduleActionType}; the migration
 * `SchedulesExecutionEngine` maps every legacy value across.
 */
export enum ScheduleTriggerType {
  /** Fires on a cron expression, evaluated in the schedule's timezone. */
  CRON = 'CRON',
  /** Fires every `intervalMs` milliseconds. */
  INTERVAL = 'INTERVAL',
  /** Fires exactly once at `startTime`, then disables itself. */
  ONE_TIME = 'ONE_TIME',
}

/** What a schedule actually does when it fires. */
export enum ScheduleActionType {
  /** Queue an RPC/command to one or more devices. */
  DEVICE_COMMAND = 'DEVICE_COMMAND',
  /** Write shared/server-scope attributes onto one or more devices. */
  ATTRIBUTE_UPDATE = 'ATTRIBUTE_UPDATE',
  /** Push a synthetic message through a rule chain. */
  RULE_CHAIN_TRIGGER = 'RULE_CHAIN_TRIGGER',
  /** Send an in-app / email / push notification. */
  SEND_NOTIFICATION = 'SEND_NOTIFICATION',
  /** Archive telemetry, clear old alarms, or recompute device statistics. */
  DATA_MAINTENANCE = 'DATA_MAINTENANCE',
  /** Render an analytics report and deliver it. */
  GENERATE_REPORT = 'GENERATE_REPORT',
}

/** Outcome of a single schedule run. Mirrors `schedule_executions.status`. */
export enum ScheduleExecutionStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

/** What caused a run — a timer tick or an operator pressing "run now". */
export enum ScheduleTriggerSource {
  CRON = 'CRON',
  MANUAL = 'MANUAL',
}

/** Which entities an action applies to. */
export enum ScheduleTargetType {
  DEVICE = 'DEVICE',
  DEVICE_TYPE = 'DEVICE_TYPE',
  ASSET = 'ASSET',
  ALL = 'ALL',
}

/** Maintenance jobs available to a DATA_MAINTENANCE schedule. */
export enum ScheduleMaintenanceTask {
  ARCHIVE_TELEMETRY = 'ARCHIVE_TELEMETRY',
  CLEAR_ALARMS = 'CLEAR_ALARMS',
  RECALCULATE_STATS = 'RECALCULATE_STATS',
}

/** Reports a GENERATE_REPORT schedule can produce. */
export enum ScheduleReportType {
  DEVICE_SUMMARY = 'DEVICE_SUMMARY',
  ALARM_SUMMARY = 'ALARM_SUMMARY',
  ENERGY_CONSUMPTION = 'ENERGY_CONSUMPTION',
  UPTIME_REPORT = 'UPTIME_REPORT',
}

/**
 * Legacy timing+action enum, retained so the migration and any unmigrated
 * caller still compile.
 *
 * @deprecated Use {@link ScheduleTriggerType} for timing and
 * {@link ScheduleActionType} for behaviour.
 */
export enum ScheduleType {
  REPORT = 'REPORT',
  BACKUP = 'BACKUP',
  CLEANUP = 'CLEANUP',
  EXPORT = 'EXPORT',
  DEVICE_COMMAND = 'DEVICE_COMMAND',
}
