// src/common/interfaces/device-capability.interface.ts
//
// Describes what a device can DO — exposed to the UI for:
//   1. Dynamic dashboard widget rendering
//   2. Automation rule builder (trigger keys + action commands)
//   3. Device control panels

export interface DeviceCapability {
  // ── Identity ─────────────────────────────────────────────────────────────
  codecId:      string;   // 'milesight-ws558'
  manufacturer: string;   // 'Milesight'
  model:        string;   // 'WS558'
  description:  string;

  // ── Telemetry keys this device reports ───────────────────────────────────
  // Used in automation rule builder as trigger options
  telemetryKeys: TelemetryKeyDef[];

  // ── Commands this device accepts (downlink) ───────────────────────────────
  // Used in automation rule builder as action options
  commands: CommandDef[];

  // ── UI component hints for dashboard widget builder ───────────────────────
  uiComponents: UIComponentDef[];
}

// ── Telemetry key definition ─────────────────────────────────────────────────

export interface TelemetryKeyDef {
  key:         string;   // 'switch_1', 'temperature', 'rssi'
  label:       string;   // 'Switch 1', 'Temperature', 'Signal Strength'
  type:        'number' | 'string' | 'boolean';
  unit?:       string;   // '°C', 'V', 'mA', '%', 'dBm'
  min?:        number;
  max?:        number;
  enum?:       string[]; // ['on', 'off'] for string enums
  description?: string;
}

// ── Command definition ───────────────────────────────────────────────────────

export interface CommandDef {
  type:        string;   // 'control_switch', 'set_report_interval'
  label:       string;   // 'Control Switch', 'Set Report Interval'
  description?: string;
  params:      CommandParamDef[];
}

export interface CommandParamDef {
  key:          string;    // 'switch_2', 'interval', 'enable'
  label:        string;    // 'Switch 2', 'Interval (seconds)'
  type:         'number' | 'string' | 'boolean' | 'select';
  required:     boolean;
  default?:     any;
  min?:         number;
  max?:         number;
  options?:     { label: string; value: any }[];  // for select type
  description?: string;
}

// ── UI component hints ───────────────────────────────────────────────────────

export type UIComponentType =
  | 'toggle'        // on/off switch (switch_1...8)
  | 'gauge'         // circular gauge (temperature, humidity)
  | 'value'         // plain numeric value (voltage, power)
  | 'map'           // GPS map (latitude, longitude)
  | 'signal'        // signal bars (rssi, snr)
  | 'battery'       // battery indicator
  | 'status'        // device status indicator
  | 'chart';        // time-series chart

export interface UIComponentDef {
  type:           UIComponentType;
  label:          string;
  keys:           string[];
  unit?:          string;        // ← add this line
  command?:       string;
  commandParams?: Record<string, any>;
}