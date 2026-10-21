// src/modules/reports/report.enum.ts
//
// Declared in the module rather than the shared `index.enum.ts` barrel: that
// file is edited concurrently by other agents and nothing outside
// ReportsModule needs these names.
//
// All of them are stored as `character varying`, never as a PostgreSQL enum. A
// PG enum column needs `ALTER TYPE ... ADD VALUE` before a new TypeScript
// member can be inserted at all, and `@IsEnum` will accept a value the INSERT
// then rejects (CLAUDE.md §4e). Report kinds and formats are exactly the lists
// that grow.

/**
 * What a report covers. One kind == one row source == one existing platform
 * service. Adding a kind means adding a manifest below and one method on
 * `ReportGeneratorService`; it must never mean a new query engine, which is why
 * every manifest names the service that answers it.
 */
export enum ReportEntityKind {
  /** Raw per-key time series. TelemetryService.getTimeSeries(). */
  DEVICE_TELEMETRY = 'DEVICE_TELEMETRY',
  /** Bucketed telemetry. TelemetryService.getAggregated(). */
  DEVICE_TELEMETRY_AGGREGATED = 'DEVICE_TELEMETRY_AGGREGATED',
  /** One row of min/max/avg per device. TelemetryService.getStatistics(). */
  DEVICE_TELEMETRY_STATISTICS = 'DEVICE_TELEMETRY_STATISTICS',
  /** The device registry itself. Tenant-scoped Device repository. */
  DEVICE_INVENTORY = 'DEVICE_INVENTORY',
  /** Per-device activity and health. AnalyticsService.getDeviceAnalytics(). */
  DEVICE_ANALYTICS = 'DEVICE_ANALYTICS',
  /** Alarm rows over a window. Tenant-scoped Alarm repository. */
  ALARM_HISTORY = 'ALARM_HISTORY',
  /** Audit trail. AuditService.findAll(), with its own role-based filtering. */
  AUDIT_LOG = 'AUDIT_LOG',
}

export enum ReportFormat {
  CSV = 'CSV',
  JSON = 'JSON',
  PDF = 'PDF',
  /**
   * A real .xlsx workbook, not a CSV with a different extension.
   *
   * `report_templates.format` and `report_executions.format` are both plain
   * `varchar` columns (see the entities), NOT Postgres enums, so adding a
   * member here needs no migration — unlike `integrations.type`, where a
   * TypeScript-only addition passes `@IsEnum` and then fails at INSERT
   * (CLAUDE.md §4e).
   */
  XLSX = 'XLSX',
}

export enum ReportTrigger {
  MANUAL = 'MANUAL',
  SCHEDULE = 'SCHEDULE',
}

export enum ReportExecutionStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum ReportDateRangeMode {
  /** `lastHours` back from the moment of generation. */
  RELATIVE = 'RELATIVE',
  /** Fixed `from`/`to` instants. */
  ABSOLUTE = 'ABSOLUTE',
}

export enum ReportGroupingInterval {
  NONE = 'NONE',
  HOUR = 'HOUR',
  DAY = 'DAY',
  MONTH = 'MONTH',
}

export interface ReportColumnManifest {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp';
}

export interface ReportSourceManifest {
  kind: ReportEntityKind;
  label: string;
  /** The existing service this source delegates to, named so it can be checked. */
  backedBy: string;
  columns: ReportColumnManifest[];
  /** Used when the definition names no columns. */
  defaultColumns: string[];
  /** Filter keys this source actually applies. Others are ignored. */
  filters: string[];
  /**
   * `exact` — honours arbitrary from/to.
   * `snapped` — the backing service only takes a fixed set of windows, so the
   *   requested range is snapped to the nearest one and the result says which.
   * `ignored` — the source has no time dimension.
   */
  dateRange: 'exact' | 'snapped' | 'ignored';
  supportsGrouping: boolean;
  note?: string;
}

const TIMESTAMP = 'timestamp' as const;

/**
 * The declarative catalogue behind `GET /reports/sources`.
 *
 * It is what the report builder form renders — column pickers and filter
 * controls per kind — and it is also the contract `ReportsService` validates a
 * definition against, so a template cannot name a column the source does not
 * produce. Same shape of single source of truth as
 * `integration-catalogue.ts` and `rule-node-catalogue.ts`.
 */
export const REPORT_SOURCES: Record<ReportEntityKind, ReportSourceManifest> = {
  [ReportEntityKind.DEVICE_TELEMETRY]: {
    kind: ReportEntityKind.DEVICE_TELEMETRY,
    label: 'Device telemetry (raw)',
    backedBy: 'TelemetryService.getTimeSeries()',
    columns: [
      { key: 'deviceId', label: 'Device ID', type: 'string' },
      { key: 'deviceName', label: 'Device', type: 'string' },
      { key: 'deviceKey', label: 'Device key', type: 'string' },
      { key: 'key', label: 'Telemetry key', type: 'string' },
      { key: 'timestamp', label: 'Timestamp', type: TIMESTAMP },
      { key: 'value', label: 'Value', type: 'number' },
    ],
    defaultColumns: ['deviceName', 'key', 'timestamp', 'value'],
    filters: ['deviceIds', 'deviceStatus', 'deviceType', 'telemetryKeys'],
    dateRange: 'exact',
    supportsGrouping: false,
    note:
      'telemetryKeys is required — the raw source is one series per (device, key) ' +
      'and TelemetryService.getTimeSeries() takes a single key.',
  },

  [ReportEntityKind.DEVICE_TELEMETRY_AGGREGATED]: {
    kind: ReportEntityKind.DEVICE_TELEMETRY_AGGREGATED,
    label: 'Device telemetry (bucketed)',
    backedBy: 'TelemetryService.getAggregated()',
    columns: [
      { key: 'deviceId', label: 'Device ID', type: 'string' },
      { key: 'deviceName', label: 'Device', type: 'string' },
      { key: 'period', label: 'Period', type: TIMESTAMP },
      { key: 'count', label: 'Readings', type: 'number' },
      { key: 'temperatureAvg', label: 'Temp avg', type: 'number' },
      { key: 'temperatureMin', label: 'Temp min', type: 'number' },
      { key: 'temperatureMax', label: 'Temp max', type: 'number' },
      { key: 'humidityAvg', label: 'Humidity avg', type: 'number' },
      { key: 'humidityMin', label: 'Humidity min', type: 'number' },
      { key: 'humidityMax', label: 'Humidity max', type: 'number' },
      { key: 'pressureAvg', label: 'Pressure avg', type: 'number' },
      { key: 'batteryAvg', label: 'Battery avg', type: 'number' },
    ],
    defaultColumns: [
      'deviceName',
      'period',
      'count',
      'temperatureAvg',
      'humidityAvg',
    ],
    filters: ['deviceIds', 'deviceStatus', 'deviceType'],
    dateRange: 'exact',
    supportsGrouping: true,
    note:
      'The aggregate columns are the denormalised telemetry columns ' +
      'TelemetryService.getAggregated() computes — temperature, humidity, ' +
      'pressure and battery. Arbitrary jsonb keys are NOT aggregated by that ' +
      'method, so use the raw source for them.',
  },

  [ReportEntityKind.DEVICE_TELEMETRY_STATISTICS]: {
    kind: ReportEntityKind.DEVICE_TELEMETRY_STATISTICS,
    label: 'Device telemetry statistics',
    backedBy: 'TelemetryService.getStatistics()',
    columns: [
      { key: 'deviceId', label: 'Device ID', type: 'string' },
      { key: 'deviceName', label: 'Device', type: 'string' },
      { key: 'totalRecords', label: 'Readings', type: 'number' },
      { key: 'temperatureAvg', label: 'Temp avg', type: 'number' },
      { key: 'temperatureMin', label: 'Temp min', type: 'number' },
      { key: 'temperatureMax', label: 'Temp max', type: 'number' },
      { key: 'humidityAvg', label: 'Humidity avg', type: 'number' },
      { key: 'humidityMin', label: 'Humidity min', type: 'number' },
      { key: 'humidityMax', label: 'Humidity max', type: 'number' },
      { key: 'pressureAvg', label: 'Pressure avg', type: 'number' },
      { key: 'batteryAvg', label: 'Battery avg', type: 'number' },
      { key: 'signalAvg', label: 'Signal avg', type: 'number' },
      { key: 'firstRecord', label: 'First reading', type: TIMESTAMP },
      { key: 'lastRecord', label: 'Last reading', type: TIMESTAMP },
    ],
    defaultColumns: [
      'deviceName',
      'totalRecords',
      'temperatureAvg',
      'humidityAvg',
      'lastRecord',
    ],
    filters: ['deviceIds', 'deviceStatus', 'deviceType'],
    dateRange: 'exact',
    supportsGrouping: false,
  },

  [ReportEntityKind.DEVICE_INVENTORY]: {
    kind: ReportEntityKind.DEVICE_INVENTORY,
    label: 'Device inventory and status',
    backedBy: 'Tenant-scoped Device repository',
    columns: [
      { key: 'id', label: 'Device ID', type: 'string' },
      { key: 'name', label: 'Device', type: 'string' },
      { key: 'deviceKey', label: 'Device key', type: 'string' },
      { key: 'type', label: 'Type', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'protocol', label: 'Protocol', type: 'string' },
      { key: 'manufacturer', label: 'Manufacturer', type: 'string' },
      { key: 'model', label: 'Model', type: 'string' },
      { key: 'assetId', label: 'Asset ID', type: 'string' },
      { key: 'customerId', label: 'Customer ID', type: 'string' },
      { key: 'deviceProfileId', label: 'Device profile ID', type: 'string' },
      { key: 'lastSeenAt', label: 'Last seen', type: TIMESTAMP },
      { key: 'messageCount', label: 'Messages', type: 'number' },
      { key: 'errorCount', label: 'Errors', type: 'number' },
      { key: 'createdAt', label: 'Registered', type: TIMESTAMP },
    ],
    defaultColumns: [
      'name',
      'deviceKey',
      'type',
      'status',
      'lastSeenAt',
      'messageCount',
    ],
    filters: ['deviceIds', 'deviceStatus', 'deviceType', 'assetIds', 'customerId'],
    dateRange: 'exact',
    supportsGrouping: false,
    note:
      'The date range filters on registration date (createdAt), since a device ' +
      'row has no other time dimension.',
  },

  [ReportEntityKind.DEVICE_ANALYTICS]: {
    kind: ReportEntityKind.DEVICE_ANALYTICS,
    label: 'Device analytics',
    backedBy: 'AnalyticsService.getDeviceAnalytics()',
    columns: [
      { key: 'id', label: 'Device ID', type: 'string' },
      { key: 'name', label: 'Device', type: 'string' },
      { key: 'type', label: 'Type', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'lastSeenAt', label: 'Last seen', type: TIMESTAMP },
      { key: 'messageCount', label: 'Messages (lifetime)', type: 'number' },
      { key: 'messagesInWindow', label: 'Messages (window)', type: 'number' },
      { key: 'errorCount', label: 'Errors', type: 'number' },
      { key: 'uptimePercentage', label: 'Uptime %', type: 'number' },
      { key: 'activeAlarms', label: 'Active alarms', type: 'number' },
      { key: 'dataGeneratedBytes', label: 'Data (bytes)', type: 'number' },
      { key: 'telemetryKeyCount', label: 'Telemetry keys', type: 'number' },
    ],
    defaultColumns: [
      'name',
      'status',
      'messagesInWindow',
      'uptimePercentage',
      'activeAlarms',
    ],
    filters: ['deviceStatus', 'deviceType'],
    dateRange: 'snapped',
    supportsGrouping: false,
    note:
      'AnalyticsService.getDeviceAnalytics() accepts one of five fixed windows ' +
      '(1h, 1d, 7d, 30d, 90d), so the requested range is snapped to the nearest ' +
      'and the generated report states the window it actually used.',
  },

  [ReportEntityKind.ALARM_HISTORY]: {
    kind: ReportEntityKind.ALARM_HISTORY,
    label: 'Alarm history',
    backedBy: 'Tenant-scoped Alarm repository',
    columns: [
      { key: 'id', label: 'Alarm ID', type: 'string' },
      { key: 'name', label: 'Alarm', type: 'string' },
      { key: 'severity', label: 'Severity', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'deviceId', label: 'Device ID', type: 'string' },
      { key: 'deviceName', label: 'Device', type: 'string' },
      { key: 'message', label: 'Message', type: 'string' },
      { key: 'currentValue', label: 'Value', type: 'number' },
      { key: 'triggerCount', label: 'Triggers', type: 'number' },
      { key: 'triggeredAt', label: 'First triggered', type: TIMESTAMP },
      { key: 'lastTriggeredAt', label: 'Last triggered', type: TIMESTAMP },
      { key: 'acknowledgedAt', label: 'Acknowledged', type: TIMESTAMP },
      { key: 'clearedAt', label: 'Cleared', type: TIMESTAMP },
      { key: 'resolvedAt', label: 'Resolved', type: TIMESTAMP },
      { key: 'createdAt', label: 'Created', type: TIMESTAMP },
    ],
    defaultColumns: [
      'name',
      'severity',
      'status',
      'deviceName',
      'lastTriggeredAt',
      'triggerCount',
    ],
    filters: ['deviceIds', 'alarmSeverity', 'alarmStatus', 'customerId'],
    dateRange: 'exact',
    supportsGrouping: false,
    note:
      'The date range filters on createdAt, so an alarm materialised by a device ' +
      'profile but never triggered still appears — which is the point of the ' +
      'INACTIVE rows ProfileAlarmService writes (CLAUDE.md §4b).',
  },

  [ReportEntityKind.AUDIT_LOG]: {
    kind: ReportEntityKind.AUDIT_LOG,
    label: 'Audit log',
    backedBy: 'AuditService.findAll()',
    columns: [
      { key: 'timestamp', label: 'Timestamp', type: TIMESTAMP },
      { key: 'action', label: 'Action', type: 'string' },
      { key: 'entityType', label: 'Entity type', type: 'string' },
      { key: 'entityId', label: 'Entity ID', type: 'string' },
      { key: 'entityName', label: 'Entity', type: 'string' },
      { key: 'userName', label: 'User', type: 'string' },
      { key: 'userEmail', label: 'Email', type: 'string' },
      { key: 'severity', label: 'Severity', type: 'string' },
      { key: 'success', label: 'Success', type: 'boolean' },
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'ipAddress', label: 'IP', type: 'string' },
    ],
    defaultColumns: [
      'timestamp',
      'action',
      'entityType',
      'entityName',
      'userName',
      'success',
    ],
    filters: ['auditAction', 'auditEntityType', 'auditSuccess', 'search'],
    dateRange: 'exact',
    supportsGrouping: false,
    note:
      'Goes through AuditService.findAll(), which applies its own role-based ' +
      'filtering from the CALLER. A CUSTOMER_USER therefore gets only their own ' +
      'actions — and a scheduled run uses the template owner’s saved identity, ' +
      'which is recorded on the execution row.',
  },
};

export const REPORT_FILTER_KEYS = [
  'deviceIds',
  'deviceStatus',
  'deviceType',
  'assetIds',
  'customerId',
  'telemetryKeys',
  'alarmSeverity',
  'alarmStatus',
  'auditAction',
  'auditEntityType',
  'auditSuccess',
  'search',
] as const;

export type ReportFilterKey = (typeof REPORT_FILTER_KEYS)[number];
