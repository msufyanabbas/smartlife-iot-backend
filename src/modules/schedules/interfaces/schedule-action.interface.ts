// src/modules/schedules/interfaces/schedule-action.interface.ts
import {
  AttributeScope,
  NotificationChannel,
  ScheduleMaintenanceTask,
  ScheduleReportType,
  ScheduleTargetType,
} from '@common/enums/index.enum';

/** Time window a report or maintenance job covers. */
export type ScheduleTimeRange = '24h' | '7d' | '30d';

/**
 * How a device-scoped action selects its devices.
 *
 * DEVICE       → one device by id
 * DEVICE_TYPE  → every device of a `DeviceType` in the tenant
 * ASSET        → every device linked to an asset
 * ALL          → every device in the tenant
 */
export interface ScheduleDeviceTarget {
  targetType: ScheduleTargetType;
  deviceId?: string;
  deviceType?: string;
  assetId?: string;
}

// ─── DEVICE_COMMAND ──────────────────────────────────────────────────────────

export interface DeviceCommandActionConfig extends ScheduleDeviceTarget {
  /**
   * The command to queue.
   *
   * `method` maps to `DeviceCommand.commandType` and `params` to
   * `DeviceCommand.params` — the shape `DeviceCommandsService.createCommand()`
   * expects. A bare `{ method, params }` object is accepted so the config
   * reads like a ThingsBoard RPC request.
   */
  command: { method: string; params?: Record<string, any> };
  /** Per-command timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

// ─── ATTRIBUTE_UPDATE ────────────────────────────────────────────────────────

export interface AttributeUpdateActionConfig extends ScheduleDeviceTarget {
  /**
   * `shared` is pushed down to the device; `server` stays platform-side.
   * ThingsBoard's `SHARED_SCOPE` / `SERVER_SCOPE` spellings are accepted at
   * the DTO layer and normalised to this enum before persistence.
   */
  scope: AttributeScope;
  attributes: Array<{ key: string; value: any }>;
}

// ─── RULE_CHAIN_TRIGGER ──────────────────────────────────────────────────────

export interface RuleChainTriggerActionConfig {
  ruleChainId: string;
  /** Message type seen by the chain's filter nodes. Defaults to SCHEDULED_TRIGGER. */
  messageType?: string;
  payload?: Record<string, any>;
  /** Optional context device — becomes the message originator when set. */
  deviceId?: string;
}

// ─── SEND_NOTIFICATION ───────────────────────────────────────────────────────

export type ScheduleNotificationTarget =
  | 'TENANT_ADMIN'
  | 'ALL_USERS'
  | 'SPECIFIC_USER';

export interface NotificationActionConfig {
  targetType: ScheduleNotificationTarget;
  /** Required when `targetType` is SPECIFIC_USER. */
  userId?: string;
  title: string;
  message: string;
  channels: NotificationChannel[];
  /** Append a live platform summary (device/alarm/telemetry counts). */
  includeAnalytics?: boolean;
}

// ─── DATA_MAINTENANCE ────────────────────────────────────────────────────────

export interface MaintenanceActionConfig {
  taskType: ScheduleMaintenanceTask;
  /** Cut-off age in days. Defaults to 90. Ignored by RECALCULATE_STATS. */
  olderThanDays?: number;
  /** Narrow the job to a single device. Omit for the whole tenant. */
  deviceId?: string;
}

// ─── GENERATE_REPORT ─────────────────────────────────────────────────────────

export interface ReportActionConfig {
  reportType: ScheduleReportType;
  timeRange: ScheduleTimeRange;
  deliveryChannels: Array<'EMAIL' | 'IN_APP'>;
  /** Required when EMAIL is among the delivery channels. */
  recipientEmail?: string;
}

// ─── Union stored on Schedule.actionConfig ───────────────────────────────────

export interface ScheduleActionConfig {
  deviceCommand?: DeviceCommandActionConfig;
  attributeUpdate?: AttributeUpdateActionConfig;
  ruleChainTrigger?: RuleChainTriggerActionConfig;
  notification?: NotificationActionConfig;
  maintenance?: MaintenanceActionConfig;
  report?: ReportActionConfig;
}

/** Value returned by every action handler and stored on the execution row. */
export interface ScheduleActionResult {
  /** Human-readable one-liner shown in the execution list. */
  summary: string;
  /** Structured counters — lands in `schedule_executions.metadata`. */
  metadata: Record<string, any>;
  /** Full detail — JSON-serialised into `schedule_executions.result`. */
  details?: Record<string, any>;
}
