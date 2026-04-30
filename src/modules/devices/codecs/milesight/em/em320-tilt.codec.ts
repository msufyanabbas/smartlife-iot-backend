// src/modules/devices/codecs/milesight/em320-tilt.codec.ts
/**
 * Milesight EM320-TILT — LoRaWAN Tilt Sensor
 *
 * ── Relation to EM310-TILT ────────────────────────────────────────────────────
 * Both are tilt sensors, but use different telemetry encoding:
 *
 * EM310-TILT: 0x03 0xCF — 7B — angle_x/y/z (int16/100) + 1B status bitmask
 * EM320-TILT: 0x03 0xD4 — 6B — each angle packed as int16 where:
 *   bits[15:1] = angle × 100 (arithmetic right-shift to decode)
 *   bit[0]     = threshold flag (0=normal, 1=trigger)
 *
 * Alarm config also differs:
 * EM310-TILT: lock_time + continue_time fields
 * EM320-TILT: report_interval + report_times fields
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
 *   0x03 0xD4 — angle X/Y/Z + threshold flags (6B)
 *     Each 2B word: int16 LE where bits[15:1] = angle×100, bit0 = threshold_flag
 *     angle = (int16_value >> 1) / 100  (arithmetic shift preserves sign)
 *     threshold = bit0 (0=normal, 1=trigger)
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF        — reboot
 *   0xFF 0x28 0xFF        — query_device_status
 *   0xFF 0x4A 0x00        — sync_time
 *   0xFF 0x03 u16LE       — report_interval (s)
 *   0xFF 0x06 data(11B)   — angle alarm config (X/Y/Z)
 *     data[0]: bits[2:0]=condition, bits[5:3]=axis (1=X, 2=Y, 3=Z)
 *     data[1-2]: threshold_min (i16LE × 100)
 *     data[3-4]: threshold_max (i16LE × 100)
 *     data[5-6]: report_interval (u16LE, min)
 *     data[7-8]: report_times (u16LE)
 *   0xFF 0x62 u8           — initial_surface (255/254/253/252)
 *   0xFF 0x63 utf8(8B)     — angle_alarm_condition (e.g. "X&Y|Z")
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x03 0xD4 — unique to EM320-TILT (EM310-TILT uses 0x03 0xCF).
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
const CONDITION_MAP: Record<number, string>  = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside', 5:'mutation' };
const CONDITION_R:   Record<string, number>  = { disable:0, below:1, above:2, between:3, outside:4, mutation:5 };
const SURFACE_MAP:   Record<number, string>  = {
  255:'current_plane', 254:'reset_zero_reference_point',
  253:'set_zero_calibration', 252:'clear_zero_calibration',
};
const SURFACE_R: Record<string, number> = {
  current_plane:255, reset_zero_reference_point:254,
  set_zero_calibration:253, clear_zero_calibration:252,
};

export class MilesightEM320TiltCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em320-tilt';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM320-TILT'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Tilt Sensor';
  readonly modelFamily     = 'EM320-TILT';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em320-tilt/em320-tilt.png';

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

      // ANGLE X/Y/Z with packed threshold flags (6B)
      // Each 2B: bits[15:1]=angle×100 (signed), bit0=threshold flag
      else if (ch === 0x03 && ty === 0xd4) {
        decoded.angle_x     = this.decodeAngle(bytes, i);
        decoded.threshold_x = (bytes[i] & 0x01) ? 'trigger' : 'normal'; i += 2;
        decoded.angle_y     = this.decodeAngle(bytes, i);
        decoded.threshold_y = (bytes[i] & 0x01) ? 'trigger' : 'normal'; i += 2;
        decoded.angle_z     = this.decodeAngle(bytes, i);
        decoded.threshold_z = (bytes[i] & 0x01) ? 'trigger' : 'normal'; i += 2;
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

  /** Decode angle: bits[15:1]/100, preserving sign via arithmetic right-shift. */
  private decodeAngle(bytes: number[], offset: number): number {
    const raw = (bytes[offset+1] << 8) | bytes[offset];
    const signed = raw > 0x7fff ? raw - 0x10000 : raw;
    return (signed >> 1) / 100;
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
          condition:       CONDITION_MAP[condBits] ?? 'unknown',
          threshold_min:   this.readInt16LE(bytes, offset + 1) / 100,
          threshold_max:   this.readInt16LE(bytes, offset + 3) / 100,
          report_interval: ((bytes[offset+6] << 8) | bytes[offset+5]) & 0xffff,
          report_times:    ((bytes[offset+8] << 8) | bytes[offset+7]) & 0xffff,
        };
        if      (axisBits === 1) data.angle_x_alarm_config = cfg;
        else if (axisBits === 2) data.angle_y_alarm_config = cfg;
        else if (axisBits === 3) data.angle_z_alarm_config = cfg;
        offset += 9; break;
      }

      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      case 0x4a: data.sync_time           = 'yes'; offset += 1; break;

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
        throw new Error(`EM320-TILT: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  private encodeAngleAlarm(axis: 1 | 2 | 3, p: any): number[] {
    const cfg = p.angle_x_alarm_config ?? p.angle_y_alarm_config ?? p.angle_z_alarm_config ?? p;
    const condition      = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
    const threshMin      = cfg.threshold_min ?? 0;
    const threshMax      = cfg.threshold_max ?? 0;
    const reportInterval = cfg.report_interval ?? 0;
    const reportTimes    = cfg.report_times ?? 0;

    const dataByte = ((axis & 0x07) << 3) | (condition & 0x07);
    const minRaw   = Math.round(threshMin * 100); const minLE = minRaw < 0 ? minRaw + 0x10000 : minRaw;
    const maxRaw   = Math.round(threshMax * 100); const maxLE = maxRaw < 0 ? maxRaw + 0x10000 : maxRaw;

    return [
      0xff, 0x06, dataByte,
      minLE & 0xff, (minLE >> 8) & 0xff,
      maxLE & 0xff, (maxLE >> 8) & 0xff,
      reportInterval & 0xff, (reportInterval >> 8) & 0xff,
      reportTimes    & 0xff, (reportTimes    >> 8) & 0xff,
    ];
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x03 0xD4 is unique to EM320-TILT (EM310-TILT uses 0x03 0xCF).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x03 && bytes[i+1] === 0xd4) return true;
    }
    return false;
  }
}