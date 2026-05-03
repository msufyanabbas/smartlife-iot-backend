// src/modules/devices/codecs/milesight/wt101.codec.ts
// Milesight WT101 — Smart Radiator Thermostat
// Channels: Ambient Temp, Target Temp, Valve Opening, Motor Stroke/Position,
//           Tamper, Window Detection, Freeze Protection
// Downlink: Full heating schedule (v1.3+), DST, freeze, child lock, etc.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightWT101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-wt101';
  readonly manufacturer    = 'Milesight';
  readonly model           = 'WT101';
  readonly description     = 'Smart Radiator Thermostat — Valve, Temperature, Heating Schedule';
  readonly supportedModels = ['WT101'];
  readonly protocol        = 'lorawan' as const;

  // Timezone map (minutes → label) — used by 0xbd command
  private readonly TZ: Record<number, string> = {
    '-720': 'UTC-12', '-660': 'UTC-11', '-600': 'UTC-10', '-570': 'UTC-9:30',
    '-540': 'UTC-9',  '-480': 'UTC-8',  '-420': 'UTC-7',  '-360': 'UTC-6',
    '-300': 'UTC-5',  '-240': 'UTC-4',  '-210': 'UTC-3:30','-180': 'UTC-3',
    '-120': 'UTC-2',  '-60':  'UTC-1',     0: 'UTC',         60: 'UTC+1',
     120: 'UTC+2',    180: 'UTC+3',      210: 'UTC+3:30',   240: 'UTC+4',
     270: 'UTC+4:30', 300: 'UTC+5',      330: 'UTC+5:30',   345: 'UTC+5:45',
     360: 'UTC+6',    390: 'UTC+6:30',   420: 'UTC+7',      480: 'UTC+8',
     540: 'UTC+9',    570: 'UTC+9:30',   600: 'UTC+10',     630: 'UTC+10:30',
     660: 'UTC+11',   720: 'UTC+12',     765: 'UTC+12:45',  780: 'UTC+13',
     840: 'UTC+14',
  } as any;

  // v1 timezone map (unit: 10 minutes) — used by legacy 0x17 response
  private readonly TZ_V1: Record<number, string> = {
    '-120': 'UTC-12', '-110': 'UTC-11', '-100': 'UTC-10', '-95': 'UTC-9:30',
    '-90':  'UTC-9',  '-80':  'UTC-8',  '-70':  'UTC-7',  '-60': 'UTC-6',
    '-50':  'UTC-5',  '-40':  'UTC-4',  '-35':  'UTC-3:30','-30': 'UTC-3',
    '-20':  'UTC-2',  '-10':  'UTC-1',    0: 'UTC',          10: 'UTC+1',
      20:   'UTC+2',   30:    'UTC+3',    35: 'UTC+3:30',    40: 'UTC+4',
      45:   'UTC+4:30',50:    'UTC+5',    55: 'UTC+5:30',    57: 'UTC+5:45',
      60:   'UTC+6',   65:    'UTC+6:30', 70: 'UTC+7',       80: 'UTC+8',
      90:   'UTC+9',   95:    'UTC+9:30',100: 'UTC+10',     105: 'UTC+10:30',
     110:   'UTC+11', 120:    'UTC+12',  127: 'UTC+12:45',  130: 'UTC+13',
     140:   'UTC+14',
  } as any;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WT101',
    description:  'Smart Radiator Thermostat — valve, temperature, heating schedule, freeze protection',
    telemetryKeys: [
      { key: 'batteryLevel',      label: 'Battery',          type: 'number' as const, unit: '%'  },
      { key: 'temperature',       label: 'Temperature',      type: 'number' as const, unit: '°C' },
      { key: 'target_temperature',label: 'Target Temp',      type: 'number' as const, unit: '°C' },
      { key: 'valve_opening',     label: 'Valve Opening',    type: 'number' as const, unit: '%'  },
      { key: 'tamper_status',     label: 'Tamper Status',    type: 'string' as const, enum: ['installed', 'uninstalled'] },
      { key: 'window_detection',  label: 'Window Detection', type: 'string' as const, enum: ['normal', 'open'] },
      { key: 'freeze_protection', label: 'Freeze Protection',type: 'string' as const, enum: ['normal', 'triggered'] },
      { key: 'motor_position',    label: 'Motor Position',   type: 'number' as const              },
    ],
    commands: [
      { type: 'reboot',     label: 'Reboot Device', params: [] },
      { type: 'sync_time',  label: 'Sync Time',      params: [] },
      { type: 'report_status', label: 'Report Status', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 1440 }],
      },
      {
        type:   'set_target_temperature',
        label:  'Set Target Temperature',
        params: [
          { key: 'temperature', label: 'Temperature (°C)', type: 'number' as const, required: true, default: 20, min: 5, max: 35 },
          { key: 'tolerance',   label: 'Tolerance (°C)',   type: 'number' as const, required: false, default: 0.5 },
        ],
      },
      {
        type:   'set_valve_opening',
        label:  'Set Valve Opening',
        params: [{ key: 'opening', label: 'Opening (%)', type: 'number' as const, required: true, default: 0, min: 0, max: 100 }],
      },
      {
        type:   'set_temperature_control_enable',
        label:  'Set Temperature Control Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_temperature_control_mode',
        label:  'Set Temperature Control Mode',
        params: [{ key: 'mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Auto', value: 'auto' }, { label: 'Manual', value: 'manual' }] }],
      },
      {
        type:   'set_temperature_calibration',
        label:  'Set Temperature Calibration',
        params: [
          { key: 'enable',            label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'calibration_value', label: 'Offset (°C)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_freeze_protection',
        label:  'Set Freeze Protection',
        params: [
          { key: 'enable',      label: 'Enable',      type: 'boolean' as const, required: true  },
          { key: 'temperature', label: 'Temperature (°C)', type: 'number' as const, required: false, default: 5, min: 1, max: 10 },
        ],
      },
      {
        type:   'set_open_window_detection',
        label:  'Set Open Window Detection',
        params: [
          { key: 'enable',                label: 'Enable',           type: 'boolean' as const, required: true  },
          { key: 'temperature_threshold', label: 'Drop Threshold (°C)', type: 'number' as const, required: false, default: 2 },
          { key: 'time',                  label: 'Time (minutes)',   type: 'number' as const, required: false, default: 15 },
        ],
      },
      { type: 'valve_calibration',             label: 'Valve Calibration',       params: [] },
      { type: 'restore_open_window_detection', label: 'Restore Window Detection', params: [] },
      {
        type:   'set_child_lock',
        label:  'Set Child Lock',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Time Zone', type: 'string' as const, required: true, default: 'UTC+3' }],
      },
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery',          keys: ['batteryLevel']       },
      { type: 'gauge'   as const, label: 'Temperature',      keys: ['temperature'],       unit: '°C' },
      { type: 'gauge'   as const, label: 'Valve Opening',    keys: ['valve_opening'],     unit: '%'  },
      { type: 'value'   as const, label: 'Target Temp',      keys: ['target_temperature'],unit: '°C' },
      { type: 'status'  as const, label: 'Window Detection', keys: ['window_detection']              },
    ],
  };
}

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    for (let i = 0; i < bytes.length; ) {
      const channelId   = bytes[i++];
      const channelType = bytes[i++];

      // ── Attribute channels ──────────────────────────────────────────────

      if (channelId === 0xff && channelType === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (channelId === 0xff && channelType === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (channelId === 0xff && channelType === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (channelId === 0xff && channelType === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (channelId === 0xff && channelType === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join('');
        i += 8;
      }
      else if (channelId === 0xff && channelType === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i++]] ?? 'unknown';
      }
      else if (channelId === 0xff && channelType === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }
      else if (channelId === 0xff && channelType === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // Battery
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.batteryLevel = bytes[i++];
      }
      // Ambient temperature
      else if (channelId === 0x03 && channelType === 0x67) {
        decoded.temperature = this.i16(bytes, i) / 10;
        i += 2;
      }
      // Target temperature
      else if (channelId === 0x04 && channelType === 0x67) {
        decoded.target_temperature = this.i16(bytes, i) / 10;
        i += 2;
      }
      // Valve opening (%)
      else if (channelId === 0x05 && channelType === 0x92) {
        decoded.valve_opening = bytes[i++];
      }
      // Installation / tamper status
      else if (channelId === 0x06 && channelType === 0x00) {
        decoded.tamper_status = bytes[i++] === 0 ? 'installed' : 'uninstalled';
      }
      // Open window detection
      else if (channelId === 0x07 && channelType === 0x00) {
        decoded.window_detection = bytes[i++] === 0 ? 'normal' : 'open';
      }
      // Motor stroke calibration result
      else if (channelId === 0x08 && channelType === 0xe5) {
        const resultMap: Record<number, string> = {
          0: 'success', 1: 'fail: out of range', 2: 'fail: uninstalled',
          3: 'calibration cleared', 4: 'temperature control disabled',
        };
        decoded.motor_calibration_result = resultMap[bytes[i++]] ?? 'unknown';
      }
      // Motor stroke
      else if (channelId === 0x09 && channelType === 0x90) {
        decoded.motor_stroke = this.u16(bytes, i);
        i += 2;
      }
      // Freeze protection status
      else if (channelId === 0x0a && channelType === 0x00) {
        decoded.freeze_protection = bytes[i++] === 0 ? 'normal' : 'triggered';
      }
      // Motor current position
      else if (channelId === 0x0b && channelType === 0x90) {
        decoded.motor_position = this.u16(bytes, i);
        i += 2;
      }

      // ── Heating schedule uplink (f9 prefix) ─────────────────────────────

      else if (channelId === 0xf9 && channelType === 0x33) {
        decoded.heating_date = this.parseHeatingDate(bytes, i);
        i += 7;
      }
      else if (channelId === 0xf9 && channelType === 0x34) {
        if (!decoded.heating_schedule) decoded.heating_schedule = [];
        (decoded.heating_schedule as any[]).push(this.parseHeatingSchedule(bytes, i));
        i += 9;
      }

      // ── Downlink response frames (0xfe / 0xff prefix) ────────────────────

      else if (channelId === 0xfe || channelId === 0xff) {
        const result = this.handleDownlink(channelType, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xf8 / 0xf9 prefix) — v1.3+ ────────

      else if (channelId === 0xf8 || channelId === 0xf9) {
        const result = this.handleDownlinkExt(channelId, channelType, bytes, i);
        for (const [k, v] of Object.entries(result.data)) {
          if (Array.isArray(decoded[k]) && Array.isArray(v)) {
            decoded[k] = [...(decoded[k] as any[]), ...v];
          } else {
            decoded[k] = v;
          }
        }
        i = result.offset;
      }

      else { break; }
    }

    return decoded;
  }

  // ── Standard downlink response handler (0xfe / 0xff) ─────────────────────

  private handleDownlink(
    channelType: number, bytes: number[], offset: number,
  ): { data: DecodedTelemetry; offset: number } {
    const d: DecodedTelemetry = {};

    switch (channelType) {
      case 0x10:
        d.reboot = 'yes';
        offset += 1; break;

      case 0x17:
        d.time_zone = this.TZ_V1[this.i16(bytes, offset)] ?? 'unknown';
        offset += 2; break;

      case 0x25:
        d.child_lock_config = { enable: bytes[offset++] === 1 ? 'enable' : 'disable' }; break;

      case 0x28:
        d.report_status = 'yes';
        offset += 1; break;

      case 0x3b: {
        const timeSyncMap: Record<number, string> = { 0: 'disable', 2: 'enable' };
        d.time_sync_enable = timeSyncMap[bytes[offset++]] ?? 'unknown'; break;
      }

      case 0x4a:
        d.sync_time = 'yes';
        offset += 1; break;

      case 0x57:
        d.restore_open_window_detection = 'yes';
        offset += 1; break;

      case 0x8e:
        // first byte is sub-type (0x00), skip it
        d.report_interval = this.u16(bytes, offset + 1);
        offset += 3; break;

      case 0xae: {
        const modeMap: Record<number, string> = { 0: 'auto', 1: 'manual' };
        d.temperature_control = { mode: modeMap[bytes[offset++]] ?? 'unknown' }; break;
      }

      case 0xab:
        d.temperature_calibration_settings = {
          enable:            bytes[offset] === 1 ? 'enable' : 'disable',
          calibration_value: this.i16(bytes, offset + 1) / 10,
        };
        offset += 3; break;

      case 0xac: {
        const algoMap: Record<number, string> = { 0: 'rate', 1: 'pid' };
        d.valve_control_algorithm = algoMap[bytes[offset++]] ?? 'unknown'; break;
      }

      case 0xad:
        d.valve_calibration = 'yes';
        offset += 1; break;

      case 0xaf:
        d.open_window_detection = {
          enable:                bytes[offset] === 1 ? 'enable' : 'disable',
          temperature_threshold: this.i8(bytes[offset + 1]) / 10,
          time:                  this.u16(bytes, offset + 2),
        };
        offset += 4; break;

      case 0xb0:
        d.freeze_protection_config = {
          enable:      bytes[offset] === 1 ? 'enable' : 'disable',
          temperature: this.i16(bytes, offset + 1) / 10,
        };
        offset += 3; break;

      case 0xb1:
        d.target_temperature    = this.i8(bytes[offset]);
        d.temperature_tolerance = this.u16(bytes, offset + 1) / 10;
        offset += 3; break;

      case 0xb3:
        d.temperature_control = { enable: bytes[offset++] === 1 ? 'enable' : 'disable' }; break;

      case 0xb4:
        d.valve_opening = bytes[offset++]; break;

      case 0xba:
        d.dst_config = {
          enable:         bytes[offset] === 1 ? 'enable' : 'disable',
          offset:         this.i8(bytes[offset + 1]),
          start_month:    bytes[offset + 2],
          start_week_num: (bytes[offset + 3] & 0xff) >> 4,
          start_week_day: bytes[offset + 3] & 0x0f,
          start_time:     this.u16(bytes, offset + 4),
          end_month:      bytes[offset + 6],
          end_week_num:   (bytes[offset + 7] & 0xff) >> 4,
          end_week_day:   bytes[offset + 7] & 0x0f,
          end_time:       this.u16(bytes, offset + 8),
        };
        offset += 10; break;

      case 0xbd:
        d.time_zone = this.TZ[this.i16(bytes, offset)] ?? 'unknown';
        offset += 2; break;

      case 0xc4:
        d.outside_temperature_control = {
          enable:  bytes[offset] === 1 ? 'enable' : 'disable',
          timeout: bytes[offset + 1],
        };
        offset += 2; break;

      case 0xf8: {
        const modeMap: Record<number, string> = { 0: 'keep', 1: 'embedded temperature control', 2: 'off' };
        d.offline_control_mode = modeMap[bytes[offset++]] ?? 'unknown'; break;
      }

      default:
        throw new Error(`WT101: unknown downlink response 0x${channelType.toString(16)}`);
    }

    return { data: d, offset };
  }

  // ── Extended downlink handler (0xf8 / 0xf9 prefix) — v1.3+ ───────────────

  private handleDownlinkExt(
    code: number, channelType: number, bytes: number[], offset: number,
  ): { data: DecodedTelemetry; offset: number } {
    const d: DecodedTelemetry = {};

    switch (channelType) {
      case 0x33:
        d.heating_date = this.parseHeatingDate(bytes, offset);
        offset += 7; break;

      case 0x34:
        d.heating_schedule = [this.parseHeatingSchedule(bytes, offset)];
        offset += 9; break;

      case 0x35:
        d.target_temperature_range = {
          min: this.i8(bytes[offset]),
          max: this.i8(bytes[offset + 1]),
        };
        offset += 2; break;

      case 0x36:
        d.display_ambient_temperature = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x37: {
        const stratMap: Record<number, string> = { 0: 'keep', 1: 'close' };
        d.window_detection_valve_strategy = stratMap[bytes[offset++]] ?? 'unknown'; break;
      }

      case 0x38:
        d.effective_stroke = {
          enable: bytes[offset] === 1 ? 'enable' : 'disable',
          rate:   bytes[offset + 1],
        };
        offset += 2; break;

      case 0x3a:
        d.change_report_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      default:
        throw new Error(`WT101: unknown ext downlink response 0x${channelType.toString(16)}`);
    }

    // 0xf8 code means a result status byte follows
    if (code === 0xf8) {
      const resultVal = bytes[offset++];
      if (resultVal !== 0) {
        const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
        return {
          data: {
            device_response_result: {
              channel_type: channelType,
              result:       resultMap[resultVal] ?? 'unknown',
              request:      d,
            },
          },
          offset,
        };
      }
    }

    return { data: d, offset };
  }

  // ── Encode downlink ───────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff]; break;

      case 'sync_time':
        bytes = [0xff, 0x4a, 0xff]; break;

      case 'report_status':
        bytes = [0xff, 0x28, 0x00]; break;

      case 'report_heating_date':
        bytes = [0xff, 0x28, 0x01]; break;

      case 'report_heating_schedule':
        bytes = [0xff, 0x28, 0x02]; break;

      case 'set_report_interval': {
        // params: { interval: number } — minutes 1–1440
        const v = Math.min(1440, Math.max(1, params.interval ?? 10));
        bytes = [0xff, 0x8e, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_time_zone': {
        // params: { time_zone: 'UTC+3' } → 180 minutes
        const val    = this.tzToMinutes(params.time_zone ?? 'UTC+3');
        const signed = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xbd, signed & 0xff, (signed >> 8) & 0xff]; break;
      }

      case 'set_time_sync_enable': {
        // params: { enable: 'enable'|'disable' }
        bytes = [0xff, 0x3b, params.enable === 'enable' ? 2 : 0]; break;
      }

      case 'set_temperature_calibration': {
        // params: { enable: 'enable'|'disable', calibration_value: number }
        const en  = params.enable === 'enable' ? 1 : 0;
        const val = Math.round((params.calibration_value ?? 0) * 10);
        const v16 = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xab, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_temperature_control_enable': {
        bytes = [0xff, 0xb3, params.enable === 'enable' ? 1 : 0]; break;
      }

      case 'set_temperature_control_mode': {
        // params: { mode: 'auto'|'manual' }
        bytes = [0xff, 0xae, params.mode === 'manual' ? 1 : 0]; break;
      }

      case 'set_target_temperature': {
        // params: { temperature: number, tolerance: number }
        const temp = params.temperature ?? 20;
        const tol  = Math.round((params.tolerance ?? 0) * 10);
        const t8   = temp < 0 ? temp + 0x100 : temp;
        bytes = [0xff, 0xb1, t8 & 0xff, tol & 0xff, (tol >> 8) & 0xff]; break;
      }

      case 'set_target_temperature_range': {
        // params: { min: 5–15, max: 16–35 }
        bytes = [0xf9, 0x35, params.min ?? 5, params.max ?? 35]; break;
      }

      case 'set_open_window_detection': {
        // params: { enable, temperature_threshold, time }
        const en   = params.enable === 'enable' ? 1 : 0;
        const thr  = Math.round((params.temperature_threshold ?? 2) * 10);
        const t8   = thr < 0 ? thr + 0x100 : thr;
        const time = params.time ?? 1;
        bytes = [0xff, 0xaf, en, t8 & 0xff, time & 0xff, (time >> 8) & 0xff]; break;
      }

      case 'restore_open_window_detection':
        bytes = [0xff, 0x57, 0xff]; break;

      case 'set_valve_opening': {
        bytes = [0xff, 0xb4, Math.min(100, Math.max(0, params.opening ?? 0))]; break;
      }

      case 'valve_calibration':
        bytes = [0xff, 0xad, 0xff]; break;

      case 'set_valve_control_algorithm': {
        bytes = [0xff, 0xac, params.algorithm === 'pid' ? 1 : 0]; break;
      }

      case 'set_freeze_protection': {
        const en  = params.enable === 'enable' ? 1 : 0;
        const val = Math.round((params.temperature ?? 5) * 10);
        const v16 = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xb0, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_child_lock': {
        bytes = [0xff, 0x25, params.enable === 'enable' ? 1 : 0]; break;
      }

      case 'set_offline_control_mode': {
        const modeMap: Record<string, number> = { keep: 0, 'embedded temperature control': 1, off: 2 };
        bytes = [0xff, 0xf8, modeMap[params.mode ?? 'keep'] ?? 0]; break;
      }

      case 'set_outside_temperature': {
        // params: { temperature: number } — format: 0x03 + int16LE + 0xff
        const val = Math.round((params.temperature ?? 0) * 10);
        const v16 = val < 0 ? val + 0x10000 : val;
        bytes = [0x03, v16 & 0xff, (v16 >> 8) & 0xff, 0xff]; break;
      }

      case 'set_outside_temperature_control': {
        const en = params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xc4, en, Math.min(60, Math.max(3, params.timeout ?? 10))]; break;
      }

      case 'set_display_ambient_temperature': {
        bytes = [0xf9, 0x36, params.enable === 'enable' ? 1 : 0]; break;
      }

      case 'set_window_detection_valve_strategy': {
        bytes = [0xf9, 0x37, params.strategy === 'close' ? 1 : 0]; break;
      }

      case 'set_dst': {
        // params: { enable, offset, start_month, start_week_num, start_week_day,
        //           start_time, end_month, end_week_num, end_week_day, end_time }
        const en   = params.enable === 'enable' ? 1 : 0;
        const off  = params.offset ?? 60;
        const off8 = off < 0 ? off + 0x100 : off;
        const swn  = params.start_week_num ?? 2;
        const swd  = params.start_week_day ?? 7;
        const ewn  = params.end_week_num   ?? 1;
        const ewd  = params.end_week_day   ?? 7;
        const st   = params.start_time ?? 120;
        const et   = params.end_time   ?? 180;
        bytes = [
          0xff, 0xba, en, off8 & 0xff,
          params.start_month ?? 3,
          ((swn << 4) | swd) & 0xff,
          st & 0xff, (st >> 8) & 0xff,
          params.end_month ?? 10,
          ((ewn << 4) | ewd) & 0xff,
          et & 0xff, (et >> 8) & 0xff,
        ]; break;
      }

      case 'set_effective_stroke': {
        const en = params.enable === 'enable' ? 1 : 0;
        bytes = [0xf9, 0x38, en, Math.min(100, Math.max(0, params.rate ?? 50))]; break;
      }

      case 'set_heating_date': {
        // params: { enable, report_interval, start_month, start_day, end_month, end_day }
        const en = params.enable === 'enable' ? 1 : 0;
        const ri = params.report_interval ?? 720;
        bytes = [
          0xf9, 0x33, en,
          ri & 0xff, (ri >> 8) & 0xff,
          params.start_month ?? 10,
          params.start_day   ?? 1,
          params.end_month   ?? 4,
          params.end_day     ?? 30,
        ]; break;
      }

      case 'set_heating_schedule': {
        // params: { index:1–16, enable, temperature_control_mode:'auto'|'manual',
        //   value, report_interval, execute_time, week_recycle: { monday, tuesday, ... } }
        const idx  = Math.min(16, Math.max(1, params.index ?? 1)) - 1;
        const en   = params.enable === 'enable' ? 1 : 0;
        const mode = params.temperature_control_mode === 'manual' ? 1 : 0;
        const ri   = params.report_interval ?? 10;
        const et   = params.execute_time    ?? 480;
        const wr   = params.week_recycle    ?? {};
        const dayOffset: Record<string, number> = {
          monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
          friday: 5, saturday: 6, sunday: 7,
        };
        let days = 0x00;
        for (const [day, shift] of Object.entries(dayOffset)) {
          if (wr[day] === 'enable' || wr[day] === 1) days |= (1 << shift);
        }
        bytes = [
          0xf9, 0x34,
          idx & 0xff,
          en,
          mode,
          (params.value ?? 20) & 0xff,
          ri & 0xff, (ri >> 8) & 0xff,
          et & 0xff, (et >> 8) & 0xff,
          days & 0xff,
        ]; break;
      }

      case 'set_change_report_enable': {
        bytes = [0xf9, 0x3a, params.enable === 'enable' ? 1 : 0]; break;
      }

      default:
        throw new Error(`WT101: unsupported command: ${type}`);
    }

    return { data: Buffer.from(bytes).toString('base64'), fPort: 85 };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private u16(bytes: number[], offset: number): number {
    return ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
  }

  private i16(bytes: number[], offset: number): number {
    const v = this.u16(bytes, offset);
    return v > 0x7fff ? v - 0x10000 : v;
  }

  private i8(byte: number): number {
    const v = byte & 0xff;
    return v > 0x7f ? v - 0x100 : v;
  }

  private tzToMinutes(tzName: string): number {
    for (const [key, val] of Object.entries(this.TZ)) {
      if (val === tzName) return parseInt(key);
    }
    return 180; // default UTC+3 (Saudi Arabia)
  }

  private parseHeatingDate(bytes: number[], offset: number): Record<string, any> {
    return {
      enable:          bytes[offset] === 1 ? 'enable' : 'disable',
      report_interval: this.u16(bytes, offset + 1),
      start_month:     bytes[offset + 3],
      start_day:       bytes[offset + 4],
      end_month:       bytes[offset + 5],
      end_day:         bytes[offset + 6],
    };
  }

  private parseHeatingSchedule(bytes: number[], offset: number): Record<string, any> {
    const modeMap: Record<number, string> = { 0: 'auto', 1: 'manual' };
    const days = bytes[offset + 8];
    const dayNames: Record<string, number> = {
      monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
      friday: 5, saturday: 6, sunday: 7,
    };
    const week_recycle: Record<string, string> = {};
    for (const [day, shift] of Object.entries(dayNames)) {
      week_recycle[day] = ((days >> shift) & 0x01) === 1 ? 'enable' : 'disable';
    }
    return {
      index:                    (bytes[offset] & 0xff) + 1,
      enable:                   bytes[offset + 1] === 1 ? 'enable' : 'disable',
      temperature_control_mode: modeMap[bytes[offset + 2]] ?? 'unknown',
      value:                    bytes[offset + 3],
      report_interval:          this.u16(bytes, offset + 4),
      execute_time:             this.u16(bytes, offset + 6),
      week_recycle,
    };
  }
}