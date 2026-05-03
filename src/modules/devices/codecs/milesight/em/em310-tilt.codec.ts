// src/modules/devices/codecs/milesight/em310-tilt.codec.ts
/**
 * Milesight EM310-TILT — LoRaWAN Tilt Sensor
 *
 * ── Telemetry channels ────────────────────────────────────────────────────────
 *   0xFF 0x01 — ipso_version (1B)
 *   0xFF 0x09 — hardware_version (2B)
 *   0xFF 0x0A — firmware_version (2B)
 *   0xFF 0xFF — tsl_version (2B)
 *   0xFF 0x16 — sn (8B hex)
 *   0xFF 0x0F — lorawan_class (1B)
 *   0xFF 0xFE — reset_event (1B)
 *   0xFF 0x0B — device_status (1B)
 *   0x01 0x75 — battery (uint8, %)
 *   0x03 0xCF — angle_x/y/z + threshold status (7B)
 *               angle_x(2B i16/100) + angle_y(2B i16/100) + angle_z(2B i16/100) + status(1B)
 *               status bits: bit0=threshold_x, bit1=threshold_y, bit2=threshold_z
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF          — reboot
 *   0xFF 0x28 0xFF          — query_device_status
 *   0xFF 0x4A 0x00          — sync_time
 *   0xFF 0x03 u16LE         — report_interval (s)
 *   0xFF 0x06 data(11B)     — angle_x/y/z alarm config
 *     data[0]: bits[2:0]=condition, bits[5:3]=axis (1=X, 2=Y, 3=Z)
 *     data[1-2]: threshold_min (i16LE × 100)
 *     data[3-4]: threshold_max (i16LE × 100)
 *     data[5-6]: lock_time (u16LE, s)
 *     data[7-8]: continue_time (u16LE, s)
 *   0xFF 0x62 u8            — initial_surface
 *     255=current_plane, 254=reset_zero_ref, 253=set_zero_cal, 252=clear_zero_cal
 *   0xFF 0x63 utf8(8B)      — angle_alarm_condition (e.g. "X&Y|Z")
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x03 0xCF (XYZ angle channel) — unique to EM310-TILT in this ecosystem.
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };

const CONDITION_MAP: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside', 5:'mutation' };
const CONDITION_R:   Record<string, number>  = { disable:0, below:1, above:2, between:3, outside:4, mutation:5 };

const SURFACE_MAP: Record<number, string> = {
  255:'current_plane', 254:'reset_zero_reference_point',
  253:'set_zero_calibration', 252:'clear_zero_calibration',
};
const SURFACE_R: Record<string, number> = {
  current_plane:255, reset_zero_reference_point:254,
  set_zero_calibration:253, clear_zero_calibration:252,
};

export class MilesightEM310TiltCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em310-tilt';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM310-TILT'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Tilt Sensor';
  readonly modelFamily     = 'EM310-TILT';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em310-tilt/em310-tilt.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'EM310-TILT',
    description:  'Tilt Sensor — 3-axis angle measurement with threshold alarms',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',      type: 'number' as const, unit: '%'  },
      { key: 'angle_x',     label: 'Angle X',      type: 'number' as const, unit: '°' },
      { key: 'angle_y',     label: 'Angle Y',      type: 'number' as const, unit: '°' },
      { key: 'angle_z',     label: 'Angle Z',      type: 'number' as const, unit: '°' },
      { key: 'threshold_x', label: 'Threshold X',  type: 'string' as const, enum: ['normal', 'trigger'] },
      { key: 'threshold_y', label: 'Threshold Y',  type: 'string' as const, enum: ['normal', 'trigger'] },
      { key: 'threshold_z', label: 'Threshold Z',  type: 'string' as const, enum: ['normal', 'trigger'] },
    ],
    commands: [
      { type: 'reboot',              label: 'Reboot Device',       params: [] },
      { type: 'query_device_status', label: 'Query Device Status', params: [] },
      { type: 'sync_time',           label: 'Sync Time',           params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 1 }],
      },
      {
        type:   'set_initial_surface',
        label:  'Set Initial Surface',
        params: [{ key: 'initial_surface', label: 'Surface', type: 'select' as const, required: true, options: ['current_plane', 'reset_zero_reference_point', 'set_zero_calibration', 'clear_zero_calibration'].map(v => ({ label: v, value: v })) }],
      },
      {
        type:   'set_angle_alarm_condition',
        label:  'Set Angle Alarm Condition',
        params: [{ key: 'angle_alarm_condition', label: 'Condition (e.g. X&Y|Z)', type: 'string' as const, required: true, default: 'X' }],
      },
      {
        type:   'set_angle_x_alarm',
        label:  'Set Angle X Alarm',
        params: [
          { key: 'condition',     label: 'Condition',   type: 'select' as const, required: true, options: ['disable','below','above','between','outside','mutation'].map(v => ({ label: v, value: v })) },
          { key: 'threshold_min', label: 'Min (°)',     type: 'number' as const, required: false, default: -45 },
          { key: 'threshold_max', label: 'Max (°)',     type: 'number' as const, required: false, default: 45  },
          { key: 'lock_time',     label: 'Lock Time (s)', type: 'number' as const, required: false, default: 0   },
          { key: 'continue_time', label: 'Continue Time (s)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_angle_y_alarm',
        label:  'Set Angle Y Alarm',
        params: [
          { key: 'condition',     label: 'Condition',   type: 'select' as const, required: true, options: ['disable','below','above','between','outside','mutation'].map(v => ({ label: v, value: v })) },
          { key: 'threshold_min', label: 'Min (°)',     type: 'number' as const, required: false, default: -45 },
          { key: 'threshold_max', label: 'Max (°)',     type: 'number' as const, required: false, default: 45  },
          { key: 'lock_time',     label: 'Lock Time (s)', type: 'number' as const, required: false, default: 0   },
          { key: 'continue_time', label: 'Continue Time (s)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_angle_z_alarm',
        label:  'Set Angle Z Alarm',
        params: [
          { key: 'condition',     label: 'Condition',   type: 'select' as const, required: true, options: ['disable','below','above','between','outside','mutation'].map(v => ({ label: v, value: v })) },
          { key: 'threshold_min', label: 'Min (°)',     type: 'number' as const, required: false, default: -45 },
          { key: 'threshold_max', label: 'Max (°)',     type: 'number' as const, required: false, default: 45  },
          { key: 'lock_time',     label: 'Lock Time (s)', type: 'number' as const, required: false, default: 0   },
          { key: 'continue_time', label: 'Continue Time (s)', type: 'number' as const, required: false, default: 0 },
        ],
      },
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery', keys: ['battery']  },
      { type: 'value'   as const, label: 'Angle X', keys: ['angle_x'], unit: '°' },
      { type: 'value'   as const, label: 'Angle Y', keys: ['angle_y'], unit: '°' },
      { type: 'value'   as const, label: 'Angle Z', keys: ['angle_z'], unit: '°' },
      { type: 'status'  as const, label: 'Threshold X', keys: ['threshold_x'] },
      { type: 'status'  as const, label: 'Threshold Y', keys: ['threshold_y'] },
      { type: 'status'  as const, label: 'Threshold Z', keys: ['threshold_z'] },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: Record<string, any> = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ─────────────────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] >> 4) & 0x0f}.${bytes[i] & 0x0f}`; i++;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => (b & 0xff).toString(16).padStart(2, '0')).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        decoded.lorawan_class = LORAWAN_CLASS[bytes[i++]] ?? 'unknown';
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = 'reset'; i++;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Telemetry channels ─────────────────────────────────────────────────

      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i++] & 0xff;
      }

      // ANGLE X/Y/Z + threshold status (7B)
      else if (ch === 0x03 && ty === 0xcf) {
        const rawX = (bytes[i+1] << 8) | bytes[i]; decoded.angle_x = (rawX > 0x7fff ? rawX - 0x10000 : rawX) / 100; i += 2;
        const rawY = (bytes[i+1] << 8) | bytes[i]; decoded.angle_y = (rawY > 0x7fff ? rawY - 0x10000 : rawY) / 100; i += 2;
        const rawZ = (bytes[i+1] << 8) | bytes[i]; decoded.angle_z = (rawZ > 0x7fff ? rawZ - 0x10000 : rawZ) / 100; i += 2;
        const status = bytes[i++] & 0xff;
        decoded.threshold_x = (status >> 0) & 1 ? 'trigger' : 'normal';
        decoded.threshold_y = (status >> 1) & 1 ? 'trigger' : 'normal';
        decoded.threshold_z = (status >> 2) & 1 ? 'trigger' : 'normal';
      }

      // ── Downlink response channels ─────────────────────────────────────────

      else if (ch === 0xfe || ch === 0xff) {
        const r = this.decodeDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, r.data);
        i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private decodeDownlinkResponse(
    ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x03:
        data.report_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x06: {
        const val      = bytes[offset] & 0xff;
        const condBits = val & 0x07;
        const axisBits = (val >> 3) & 0x07;
        const cfg = {
          condition:     CONDITION_MAP[condBits] ?? 'unknown',
          threshold_min: this.readInt16LE(bytes, offset + 1) / 100,
          threshold_max: this.readInt16LE(bytes, offset + 3) / 100,
          lock_time:     ((bytes[offset+6] << 8) | bytes[offset+5]) & 0xffff,
          continue_time: ((bytes[offset+8] << 8) | bytes[offset+7]) & 0xffff,
        };
        if      (axisBits === 1) data.angle_x_alarm_config = cfg;
        else if (axisBits === 2) data.angle_y_alarm_config = cfg;
        else if (axisBits === 3) data.angle_z_alarm_config = cfg;
        offset += 9; break;
      }

      case 0x10: data.reboot             = 'yes'; offset += 1; break;
      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      case 0x4a: data.sync_time          = 'yes'; offset += 1; break;

      case 0x62:
        data.initial_surface = SURFACE_MAP[bytes[offset]] ?? 'unknown'; offset += 1; break;

      case 0x63:
        data.angle_alarm_condition = this.readUtf8(bytes, offset, 8); offset += 8; break;

      default: offset += 1; break;
    }

    return { data, offset };
  }

  private readInt16LE(bytes: number[], offset: number): number {
    const raw = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
    return raw > 0x7fff ? raw - 0x10000 : raw;
  }

  private readUtf8(bytes: number[], offset: number, maxLen: number): string {
    let str = '';
    for (let j = 0; j < maxLen && offset + j < bytes.length; j++) {
      const b = bytes[offset + j];
      if (b === 0) break;
      if (b <= 0x7f) str += String.fromCharCode(b);
    }
    return str;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':               bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status':  bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':            bytes = [0xff, 0x4a, 0x00]; break;

      case 'set_report_interval': {
        const v = p.report_interval ?? p.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('report_interval: 1–64800 s');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_angle_x_alarm': bytes = this.encodeAngleAlarm(1, p); break;
      case 'set_angle_y_alarm': bytes = this.encodeAngleAlarm(2, p); break;
      case 'set_angle_z_alarm': bytes = this.encodeAngleAlarm(3, p); break;

      case 'set_angle_alarm_condition': {
        const s = String(p.angle_alarm_condition ?? p.condition ?? '');
        const utf8: number[] = [];
        for (let j = 0; j < s.length; j++) utf8.push(s.charCodeAt(j) & 0xff);
        // pad to 8 bytes
        while (utf8.length < 8) utf8.push(0);
        bytes = [0xff, 0x63, ...utf8.slice(0, 8)]; break;
      }

      case 'set_initial_surface': {
        const val = typeof p.initial_surface === 'string'
          ? (SURFACE_R[p.initial_surface] ?? 255)
          : (p.initial_surface ?? 255);
        bytes = [0xff, 0x62, val & 0xff]; break;
      }

      default:
        throw new Error(`EM310-TILT: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  private encodeAngleAlarm(axis: 1 | 2 | 3, p: any): number[] {
    const cfg = p.angle_x_alarm_config ?? p.angle_y_alarm_config ?? p.angle_z_alarm_config ?? p;
    const condition   = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
    const threshMin   = cfg.threshold_min ?? 0;
    const threshMax   = cfg.threshold_max ?? 0;
    const lockTime    = cfg.lock_time ?? 0;
    const continueTime = cfg.continue_time ?? 0;

    const dataByte = ((axis & 0x07) << 3) | (condition & 0x07);
    const minRaw   = Math.round(threshMin * 100); const minLE = minRaw < 0 ? minRaw + 0x10000 : minRaw;
    const maxRaw   = Math.round(threshMax * 100); const maxLE = maxRaw < 0 ? maxRaw + 0x10000 : maxRaw;

    return [
      0xff, 0x06, dataByte,
      minLE & 0xff, (minLE >> 8) & 0xff,
      maxLE & 0xff, (maxLE >> 8) & 0xff,
      lockTime    & 0xff, (lockTime    >> 8) & 0xff,
      continueTime & 0xff, (continueTime >> 8) & 0xff,
    ];
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x03 0xCF (XYZ angle) is unique to EM310-TILT.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x03 && bytes[i+1] === 0xcf) return true;
    }
    return false;
  }
}