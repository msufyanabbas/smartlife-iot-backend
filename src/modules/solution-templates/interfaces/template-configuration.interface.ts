// src/modules/solution-templates/interfaces/template-configuration.interface.ts
//
// Declarative provisioning spec stored in SolutionTemplate.configuration (jsonb).
// SolutionTemplatesService.install() reads this and creates real Devices,
// Dashboards, RuleChains + Nodes, and Alarms inside a single transaction.
//
// Placeholders supported in any `name`/`label` field:
//   {n}            → 1-based index within a DeviceSpec's `count`
//   {installName}  → InstallTemplateDto.installationName (falls back to template name)

import type {
  DeviceType,
  DeviceStatus,
  AlarmSeverity,
  AlarmCondition,
  NodeType,
} from '@common/enums/index.enum';
import type { DeviceProtocol } from '@modules/devices/entities/device.entity';

export interface DeviceSpec {
  /** Supports {n} and {installName}. e.g. "Temperature Sensor {n}" */
  name: string;
  /** Must be a DeviceType enum value ('sensor' | 'actuator' | 'gateway' | ...) */
  type: DeviceType;
  /** Optional human label; supports the same placeholders as `name`. */
  label?: string;
  /** Matched against DeviceProfile.name for this tenant. Unmatched = left unset. */
  profileName?: string;
  /** Stored on Device.metadata.codecId — drives codec auto-selection on ingest. */
  codecId?: string;
  /** How many devices to create from this spec. Must be >= 1. */
  count: number;
  /** DeviceProtocol enum value; defaults to generic_mqtt when omitted. */
  protocol?: DeviceProtocol;
  /** Initial device status; defaults to DeviceStatus.INACTIVE. */
  status?: DeviceStatus;
  /** Recorded on Device.metadata for downstream alarm/rule wiring. */
  defaultTelemetryKeys?: string[];
}

export interface WidgetSpec {
  /** Widget type identifier, e.g. 'timeseries' | 'gauge' | 'status-widget'. */
  type: string;
  title: string;
  config?: Record<string, any>;
  row: number;
  col: number;
  width: number;
  height: number;
}

export interface DashboardSpec {
  /** Supports {installName}. */
  name: string;
  description?: string;
  widgets: WidgetSpec[];
}

/**
 * Which of the devices created by this installation the alarm attaches to.
 *   'all'   → every created device
 *   'first' → only the first
 *   number  → the first N
 */
export type DeviceSelector = 'all' | 'first' | number;

export interface AlarmSpec {
  name: string;
  deviceSelector: DeviceSelector;
  telemetryKey: string;
  /** Must be an AlarmCondition enum value. NOTE: equality is 'EQUAL', not 'EQUALS'. */
  condition: AlarmCondition;
  value: number;
  /** Required when condition is BETWEEN or OUTSIDE. */
  value2?: number;
  /** Must be an AlarmSeverity enum value ('info' | 'warning' | 'error' | 'critical'). */
  severity: AlarmSeverity;
}

export interface RuleNodeSpec {
  name: string;
  /** Must be a NodeType enum value. */
  type: NodeType;
  configuration?: Record<string, any>;
  position: { x: number; y: number };
}

export interface RuleConnectionSpec {
  /** Index into RuleChainSpec.nodes. */
  fromNodeIndex: number;
  toNodeIndex: number;
  /** e.g. 'success' | 'failure' | 'true' | 'false'. */
  connectionType: string;
}

export interface RuleChainSpec {
  /** Supports {installName}. */
  name: string;
  description?: string;
  messageTypes?: string[];
  nodes: RuleNodeSpec[];
  connections: RuleConnectionSpec[];
}

export interface TemplateConfiguration {
  devices?: DeviceSpec[];
  dashboards?: DashboardSpec[];
  ruleChains?: RuleChainSpec[];
  alarms?: AlarmSpec[];
}

/** Status of a single installation attempt. */
export enum InstallationStatus {
  INSTALLING = 'INSTALLING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ROLLED_BACK = 'ROLLED_BACK',
}

/** Shape returned by SolutionTemplatesService.install(). */
export interface InstallResult {
  success: boolean;
  installationId: string;
  installationName: string;
  templateName: string;
  devicesCreated: number;
  dashboardsCreated: number;
  ruleChainsCreated: number;
  alarmsCreated: number;
  deviceIds: string[];
  dashboardIds: string[];
  ruleChainIds: string[];
  alarmIds: string[];
}
