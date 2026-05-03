// src/modules/devices/codecs/milesight/em310-udl.codec.ts
/**
 * Milesight EM310-UDL — LoRaWAN Ultrasonic Distance/Level Sensor
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
 *   0x03 0x82 — distance (uint16 LE, mm)   ← EM310-UDL fingerprint
 *   0x04 0x00 — position (uint8: 0=normal, 1=tilt)
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF        — reboot
 *   0xFF 0x02 u16LE       — collection_interval (s, range: [10, 60])
 *   0xFF 0x03 u16LE       — report_interval (s)
 *   0xFF 0x06 data(11B)   — distance_alarm_config
 *     data[0]: bits[2:0]=condition, bit3=1 (channel marker), bit7=alarm_release_enable
 *     data[1-2]: threshold_min (i16LE × 10, mm stored as 0.1mm units)
 *     data[3-4]: threshold_max (i16LE × 10)
 *     data[5-6]: lock_time (u16LE, s)
 *     data[7-8]: continue_time (u16LE, s)
 *
 * ── Threshold scale note ──────────────────────────────────────────────────────
 *   Encoder writes threshold × 10; decoder reads raw int16 (no division).
 *   Decoded threshold_min/max are therefore in 0.1 mm units.
 *   When encoding, provide threshold in mm — codec multiplies by 10 internally.
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x03 0x82 (distance, mm) — unique to EM310-UDL.
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };

const CONDITION_MAP: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_R:   Record<string, number>  = { disable:0, below:1, above:2, between:3, outside:4 };

export class MilesightEM310UdlCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em310-udl';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM310-UDL'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'EM310-UDL',
    description:  'Ultrasonic Distance/Level Sensor — distance and tilt position',
    telemetryKeys: [
      { key: 'battery',  label: 'Battery',  type: 'number' as const, unit: '%'  },
      { key: 'distance', label: 'Distance', type: 'number' as const, unit: 'mm' },
      { key: 'position', label: 'Position', type: 'string' as const, enum: ['normal', 'tilt'] },
    ],
    commands: [
      { type: 'reboot', label: 'Reboot Device', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 1 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 30, min: 10, max: 60 }],
      },
      {
        type:   'set_distance_alarm',
        label:  'Set Distance Alarm',
        params: [
          { key: 'condition',            label: 'Condition',           type: 'select' as const, required: true, options: ['disable','below','above','between','outside'].map(v => ({ label: v, value: v })) },
          { key: 'alarm_release_enable', label: 'Alarm Release Enable', type: 'boolean' as const, required: false },
          { key: 'threshold_min',        label: 'Min (mm)',            type: 'number' as const, required: false, default: 0    },
          { key: 'threshold_max',        label: 'Max (mm)',            type: 'number' as const, required: false, default: 5000 },
          { key: 'lock_time',            label: 'Lock Time (s)',        type: 'number' as const, required: false, default: 0    },
          { key: 'continue_time',        label: 'Continue Time (s)',    type: 'number' as const, required: false, default: 0    },
        ],
      },
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery',  keys: ['battery']  },
      { type: 'value'   as const, label: 'Distance', keys: ['distance'], unit: 'mm' },
      { type: 'status'  as const, label: 'Position', keys: ['position']             },
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
      // Distance — uint16 LE, mm
      else if (ch === 0x03 && ty === 0x82) {
        decoded.distance = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      // Position — 0=normal, 1=tilt
      else if (ch === 0x04 && ty === 0x00) {
        decoded.position = bytes[i++] === 1 ? 'tilt' : 'normal';
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
      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x02: data.collection_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x03: data.report_interval     = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x06: {
        const b   = bytes[offset] & 0xff;
        const cond = b & 0x07;
        const rel  = (b >> 7) & 0x01;
        const rawMin = (bytes[offset+2] << 8) | bytes[offset+1];
        const rawMax = (bytes[offset+4] << 8) | bytes[offset+3];
        data.distance_alarm_config = {
          condition:            CONDITION_MAP[cond] ?? 'unknown',
          alarm_release_enable: rel === 1 ? 'enable' : 'disable',
          // Stored as ×10 units; decoded as raw int16 per official decoder
          threshold_min: rawMin > 0x7fff ? rawMin - 0x10000 : rawMin,
          threshold_max: rawMax > 0x7fff ? rawMax - 0x10000 : rawMax,
          lock_time:     ((bytes[offset+6] << 8) | bytes[offset+5]) & 0xffff,
          continue_time: ((bytes[offset+8] << 8) | bytes[offset+7]) & 0xffff,
        };
        offset += 9; break;
      }

      default: offset += 1; break;
    }

    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot': bytes = [0xff, 0x10, 0xff]; break;

      case 'set_collection_interval': {
        const v = p.collection_interval ?? p.seconds ?? 30;
        if (v < 10 || v > 60) throw new Error('collection_interval: 10–60 s');
        bytes = [0xff, 0x02, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_report_interval': {
        const v = p.report_interval ?? p.seconds ?? 600;
        if (v < 1) throw new Error('report_interval must be >= 1 s');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_distance_alarm': {
        const cfg = p.distance_alarm_config ?? p;
        const condition = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
        const rel       = cfg.alarm_release_enable === 'enable' || cfg.alarm_release_enable === 1 ? 1 : 0;
        const dataByte  = (rel << 7) | (1 << 3) | (condition & 0x07);

        // Encoder stores thresholds ×10 (mm → 0.1mm units) as int16 LE
        const minRaw = Math.round((cfg.threshold_min ?? 0) * 10);
        const maxRaw = Math.round((cfg.threshold_max ?? 0) * 10);
        const minLE  = minRaw < 0 ? minRaw + 0x10000 : minRaw;
        const maxLE  = maxRaw < 0 ? maxRaw + 0x10000 : maxRaw;
        const lock   = cfg.lock_time    ?? 0;
        const cont   = cfg.continue_time ?? 0;

        bytes = [
          0xff, 0x06, dataByte,
          minLE & 0xff, (minLE >> 8) & 0xff,
          maxLE & 0xff, (maxLE >> 8) & 0xff,
          lock  & 0xff, (lock  >> 8) & 0xff,
          cont  & 0xff, (cont  >> 8) & 0xff,
        ]; break;
      }

      default:
        throw new Error(`EM310-UDL: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x03 0x82 (distance, mm) is unique to EM310-UDL.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x03 && bytes[i+1] === 0x82) return true;
    }
    return false;
  }
}