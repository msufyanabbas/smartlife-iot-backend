// src/modules/devices/codecs/milesight/vs350.codec.ts
// Milesight VS350 — Passage People Counter (IR beam, temperature, bi-directional counting)
//
// Telemetry channels:
//   0xFF 0x01 — ipso_version (1B, nibble-split)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0xFF — tsl_version (2B)
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0xFE — reset_event (1B)
//   0xFF 0x0B — device_status (1B)
//   0x01 0x75 — battery (uint8 %)
//   0x03 0x67 — temperature (int16 LE /10, °C)
//   0x04 0xCC — total_in(2B) + total_out(2B)
//   0x05 0xCC — period_in(2B) + period_out(2B)
//   0x0A 0xEF — timestamp (uint32 LE)
//   0x83 0x67 — temperature alarm: temp(int16 /10) + alarm_type(1B)
//   0x84 0xCC — total_in(2B) + total_out(2B) + total_count_alarm(1B)
//   0x85 0xCC — period_in(2B) + period_out(2B) + period_count_alarm(1B)
//   0x20 0xCE — history: ts(4B) + type(1B) + data (type0: 4B, type1: 8B)
//
// Downlink responses: 0xFF/0xFE standard, 0xF9/0xF8 extended (0xF8 carries result flag)
// History fetch/stop: 0xFD prefix

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Timezone map (int16 minutes → string) ─────────────────────────────────────
const TZ_MAP: Record<number, string> = {
  [-720]: 'UTC-12', [-660]: 'UTC-11', [-600]: 'UTC-10', [-570]: 'UTC-9:30',
  [-540]: 'UTC-9',  [-480]: 'UTC-8',  [-420]: 'UTC-7',  [-360]: 'UTC-6',
  [-300]: 'UTC-5',  [-240]: 'UTC-4',  [-210]: 'UTC-3:30',[-180]: 'UTC-3',
  [-120]: 'UTC-2',  [-60]:  'UTC-1',     [0]: 'UTC',       [60]: 'UTC+1',
   [120]: 'UTC+2',  [180]: 'UTC+3',   [210]: 'UTC+3:30', [240]: 'UTC+4',
   [270]: 'UTC+4:30',[300]: 'UTC+5',  [330]: 'UTC+5:30', [345]: 'UTC+5:45',
   [360]: 'UTC+6',  [390]: 'UTC+6:30',[420]: 'UTC+7',    [480]: 'UTC+8',
   [540]: 'UTC+9',  [570]: 'UTC+9:30',[600]: 'UTC+10',   [630]: 'UTC+10:30',
   [660]: 'UTC+11', [720]: 'UTC+12',  [765]: 'UTC+12:45',[780]: 'UTC+13',
   [840]: 'UTC+14',
};

function tzName(v: number): string { return TZ_MAP[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, val] of Object.entries(TZ_MAP)) {
    if (val === name) return parseInt(k);
  }
  return 180; // default UTC+3
}

export class MilesightVS350Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs350';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS350'];
  readonly protocol        = 'lorawan' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/vs-series/vs350/vs350.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'VS350',
    description:  'Passage People Counter — IR beam bi-directional counting with temperature',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'  },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C' },
      { key: 'total_in',    label: 'Total In',    type: 'number' as const              },
      { key: 'total_out',   label: 'Total Out',   type: 'number' as const              },
      { key: 'period_in',   label: 'Period In',   type: 'number' as const              },
      { key: 'period_out',  label: 'Period Out',  type: 'number' as const              },
    ],
    commands: [
      { type: 'reboot',                   label: 'Reboot Device',             params: [] },
      { type: 'report_status',            label: 'Report Status',             params: [] },
      { type: 'sync_time',                label: 'Sync Time',                 params: [] },
      { type: 'reset_cumulative_in',      label: 'Reset Cumulative In',       params: [] },
      { type: 'reset_cumulative_out',     label: 'Reset Cumulative Out',      params: [] },
      { type: 'stop_transmit',            label: 'Stop Transmit',             params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 60, min: 1, max: 1440 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Time Zone', type: 'string' as const, required: true, default: 'UTC+3' }],
      },
      {
        type:   'set_reset_cumulative_enable',
        label:  'Set Reset Cumulative Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_reset_cumulative_interval',
        label:  'Set Reset Cumulative Interval',
        params: [{ key: 'reset_cumulative_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 1440, min: 1 }],
      },
      {
        type:   'set_report_cumulative_enable',
        label:  'Set Report Cumulative Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_temperature_alarm_config',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'condition',     label: 'Condition',  type: 'select' as const, required: true, options: ['disable','below','above','between','outside'].map(v => ({ label: v, value: v })) },
          { key: 'threshold_min', label: 'Min (°C)',   type: 'number' as const, required: false, default: 0  },
          { key: 'threshold_max', label: 'Max (°C)',   type: 'number' as const, required: false, default: 40 },
        ],
      },
      {
        type:   'set_temperature_calibration',
        label:  'Set Temperature Calibration',
        params: [
          { key: 'enable',            label: 'Enable',           type: 'boolean' as const, required: true  },
          { key: 'calibration_value', label: 'Offset (°C)',      type: 'number'  as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmit_enable',
        label:  'Set Retransmit Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'fetch_history',
        label:  'Fetch History',
        params: [
          { key: 'start_time', label: 'Start Time (Unix)', type: 'number' as const, required: true  },
          { key: 'end_time',   label: 'End Time (Unix)',   type: 'number' as const, required: false },
        ],
      },
      {
        type:   'set_d2d_enable',
        label:  'Set D2D Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
    ],
    uiComponents: [
      { type: 'gauge' as const, label: 'Battery',     keys: ['battery'],     unit: '%'  },
      { type: 'value' as const, label: 'Temperature', keys: ['temperature'], unit: '°C' },
      { type: 'value' as const, label: 'Total In',    keys: ['total_in']                },
      { type: 'value' as const, label: 'Total Out',   keys: ['total_out']               },
      { type: 'value' as const, label: 'Period In',   keys: ['period_in']               },
      { type: 'value' as const, label: 'Period Out',  keys: ['period_out']              },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute / version channels ──────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal'; i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Telemetry channels ────────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // TEMPERATURE (0x03 0x67) — int16 LE /10
      else if (ch === 0x03 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }

      // TOTAL IN/OUT (0x04 0xCC)
      else if (ch === 0x04 && ty === 0xcc) {
        decoded.total_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // PERIOD IN/OUT (0x05 0xCC)
      else if (ch === 0x05 && ty === 0xcc) {
        decoded.period_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // TIMESTAMP (0x0A 0xEF)
      else if (ch === 0x0a && ty === 0xef) {
        decoded.timestamp = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // TEMPERATURE ALARM (0x83 0x67) — temp(int16 /10) + alarm(1B)
      else if (ch === 0x83 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        const alarmMap: Record<number, string> = {
          0: 'threshold alarm release', 1: 'threshold alarm',
          3: 'high temperature alarm',  4: 'high temperature alarm release',
        };
        decoded.temperature_alarm = alarmMap[bytes[i + 2]] ?? 'unknown';
        i += 3;
      }

      // TOTAL IN/OUT ALARM (0x84 0xCC) — total_in(2) + total_out(2) + alarm(1)
      else if (ch === 0x84 && ty === 0xcc) {
        decoded.total_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.total_count_alarm = bytes[i + 4] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 5;
      }

      // PERIOD IN/OUT ALARM (0x85 0xCC) — period_in(2) + period_out(2) + alarm(1)
      else if (ch === 0x85 && ty === 0xcc) {
        decoded.period_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.period_count_alarm = bytes[i + 4] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 5;
      }

      // HISTORY (0x20 0xCE)
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        const type = bytes[i + 4];
        const entry: Record<string, any> = { timestamp: ts };
        if (type === 0) {
          // period_in(2) + period_out(2)
          entry.period_in  = ((bytes[i + 6] << 8) | bytes[i + 5]) & 0xffff;
          entry.period_out = ((bytes[i + 8] << 8) | bytes[i + 7]) & 0xffff;
          i += 9;
        } else if (type === 1) {
          // period_in(2) + period_out(2) + total_in(2) + total_out(2)
          entry.period_in  = ((bytes[i + 6] << 8) | bytes[i + 5]) & 0xffff;
          entry.period_out = ((bytes[i + 8] << 8) | bytes[i + 7]) & 0xffff;
          entry.total_in   = ((bytes[i + 10] << 8) | bytes[i + 9]) & 0xffff;
          entry.total_out  = ((bytes[i + 12] << 8) | bytes[i + 11]) & 0xffff;
          i += 13;
        } else {
          i += 5; // unknown type — skip header
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleStdDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF9 / 0xF8) ─────────────────────────
      else if (ch === 0xf9 || ch === 0xf8) {
        const result = this.handleExtDownlink(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleStdDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;
    const i16 = (o: number) => { const v = u16(o); return v > 0x7fff ? v - 0x10000 : v; };
    const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };

    switch (ty) {
      case 0x06: {
        const byte0   = bytes[offset] & 0xff;
        const cond    = condMap[byte0 & 0x07] ?? 'unknown';
        const src     = (byte0 >>> 3) & 0x07;
        if (src === 1) {
          data.people_period_alarm_config = {
            condition:     cond,
            threshold_out: u16(offset + 1),
            threshold_in:  u16(offset + 3),
          };
        } else if (src === 2) {
          data.people_cumulative_alarm_config = {
            condition:     cond,
            threshold_out: u16(offset + 1),
            threshold_in:  u16(offset + 3),
          };
        } else if (src === 3) {
          data.temperature_alarm_config = {
            condition:     cond,
            threshold_min: u16(offset + 1) / 10,
            threshold_max: u16(offset + 3) / 10,
          };
        }
        offset += 9; break;
      }
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x28:
        data.report_status = 'yes'; offset += 1; break;
      case 0x35:
        data.d2d_key = bytes.slice(offset, offset + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        offset += 8; break;
      case 0x4a:
        data.sync_time = 'yes'; offset += 1; break;
      case 0x68:
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69:
        data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const t = bytes[offset] & 0xff;
        if (t === 0) data.retransmit_interval = u16(offset + 1);
        else         data.resend_interval     = u16(offset + 1);
        offset += 3; break;
      }
      case 0x6b: // fetch_history start ack
      case 0x6d:
        data.stop_transmit = 'yes'; offset += 1; break;
      case 0x84:
        data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e:
        // skip first byte (sub-type), uint16 LE
        data.report_interval = u16(offset + 1); offset += 3; break;
      case 0x96: {
        const modeMap: Record<number, string> = {
          1: 'someone_enter', 2: 'someone_leave', 3: 'counting_threshold_alarm',
          4: 'temperature_threshold_alarm', 5: 'temperature_threshold_alarm_release',
        };
        const cfg: Record<string, any> = {
          mode:               modeMap[bytes[offset]] ?? 'unknown',
          enable:             bytes[offset + 1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset + 2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            ('0' + (bytes[offset + 4] & 0xff).toString(16)).slice(-2) +
                              ('0' + (bytes[offset + 3] & 0xff).toString(16)).slice(-2),
          time:               u16(offset + 5),
          time_enable:        bytes[offset + 7] === 1 ? 'enable' : 'disable',
        };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(cfg);
        offset += 8; break;
      }
      case 0xa6:
        data.reset_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xa7:
        data.reset_cumulative_interval = u16(offset); offset += 2; break;
      case 0xa8: {
        const t = bytes[offset] & 0xff;
        if (t === 0x01) data.reset_cumulative_in  = 'yes';
        else            data.reset_cumulative_out = 'yes';
        offset += 1; break;
      }
      case 0xa9:
        data.report_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xaa:
        data.report_temperature_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xab:
        data.temperature_calibration_settings = {
          enable:            bytes[offset] === 1 ? 'enable' : 'disable',
          calibration_value: i16(offset + 1) / 10,
        };
        offset += 3; break;
      case 0xbd:
        data.time_zone = tzName(i16(offset)); offset += 2; break;
      case 0xef:
        data.reset_cumulative_config = {
          enable: bytes[offset] === 1 ? 'enable' : 'disable',
          hour:   bytes[offset + 1] & 0xff,
          minute: bytes[offset + 2] & 0xff,
        };
        offset += 3; break;
      default:
        offset += 1; break;
    }
    return { data, offset };
  }

  private handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x10: {
        const typeMap: Record<number, string> = { 0: 'period', 1: 'immediately' };
        data.report_type = typeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      default:
        offset += 1; break;
    }
    // 0xF8 carries result flag
    if (code === 0xf8) {
      const rv = bytes[offset++] & 0xff;
      if (rv !== 0) {
        const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
        const req = { ...data };
        return {
          data: { device_response_result: { channel_type: ty, result: resultMap[rv] ?? 'unknown', request: req } },
          offset,
        };
      }
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const i16 = (v: number) => { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; };
    const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
    const hexBytes = (hex: string) => { const o: number[] = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
    const d2dCmd  = (cmd: string) => [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];

    switch (type) {
      case 'reboot':         bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':  bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':      bytes = [0xff, 0x4a, 0xff]; break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        bytes = [0xff, 0x8e, 0x00, ...u16(v)]; break;
      }

      case 'set_report_type': {
        const m: Record<string, number> = { period: 0, immediately: 1 };
        bytes = [0xf9, 0x10, m[params.report_type ?? 'period'] ?? 0]; break;
      }

      case 'set_time_zone': {
        const v = tzValue(params.time_zone ?? 'UTC+3');
        bytes = [0xff, 0xbd, ...i16(v)]; break;
      }

      case 'set_reset_cumulative_enable':
        bytes = [0xff, 0xa6, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_reset_cumulative_interval': {
        const v = params.reset_cumulative_interval ?? 1440;
        if (v < 1 || v > 65535) throw new Error('reset_cumulative_interval must be 1–65535');
        bytes = [0xff, 0xa7, ...u16(v)]; break;
      }

      case 'reset_cumulative_in':  bytes = [0xff, 0xa8, 0x01]; break;
      case 'reset_cumulative_out': bytes = [0xff, 0xa8, 0x02]; break;

      case 'set_report_cumulative_enable':
        bytes = [0xff, 0xa9, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_report_temperature_enable':
        bytes = [0xff, 0xaa, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_temperature_calibration': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const val    = params.calibration_value ?? 0;
        bytes = [0xff, 0xab, enable, ...i16(Math.round(val * 10))]; break;
      }

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexBytes(key)]; break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = {
          someone_enter: 1, someone_leave: 2, counting_threshold_alarm: 3,
          temperature_threshold_alarm: 4, temperature_threshold_alarm_release: 5,
        };
        const mode       = modeMap[params.mode ?? 'someone_enter'] ?? 1;
        const enable     = params.enable             === 'enable' ? 1 : 0;
        const loraUplink = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd        = params.d2d_cmd ?? '0000';
        const time       = params.time ?? 0;
        const timeEnable = params.time_enable === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [0xff, 0x96, mode, enable, loraUplink, ...d2dCmd(cmd), ...u16(time), timeEnable]; break;
      }

      case 'set_people_period_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x01 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte,
          ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0),
          0x00, 0x00, 0x00, 0x00]; break;
      }

      case 'set_people_cumulative_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x02 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte,
          ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0),
          0x00, 0x00, 0x00, 0x00]; break;
      }

      case 'set_temperature_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x03 << 3) | (0x01 << 6);
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 0;
        bytes = [0xff, 0x06, dataByte,
          ...u16(Math.round(min * 10)), ...u16(Math.round(max * 10)),
          0x00, 0x00, 0x00, 0x00]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('retransmit_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x00, ...u16(v)]; break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('resend_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x01, ...u16(v)]; break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = end === 0
          ? [0xfd, 0x6b, ...u32(start)]
          : [0xfd, 0x6c, ...u32(start), ...u32(end)];
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff]; break;

      default:
        throw new Error(`VS350: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS350 is uniquely identified by:
  //   0x04 0xCC — total_in + total_out (not used by VS132/VS133 which use 0xD2)
  //   0x05 0xCC — period_in + period_out
  //   0x84 0xCC — total count alarm
  //   0x85 0xCC — period count alarm

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x04 && ty === 0xcc) return true;
      if (ch === 0x05 && ty === 0xcc) return true;
      if (ch === 0x84 && ty === 0xcc) return true;
      if (ch === 0x85 && ty === 0xcc) return true;
    }
    return false;
  }
}