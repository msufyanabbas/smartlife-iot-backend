// src/modules/devices/codecs/milesight/em400-mud.codec.ts
/**
 * Milesight EM400-MUD — LoRaWAN Multifunctional Ultrasonic Distance/Level Sensor
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
 *   0x03 0x67 — temperature (int16 LE /10, °C)
 *   0x04 0x82 — distance (uint16 LE, mm)           ← EM400-MUD fingerprint
 *   0x05 0x00 — position (uint8: 0=normal, 1=tilt)
 *   0x83 0x67 — temperature + alarm (3B): temp(2B i16/10) + alarm_type(1B)
 *   0x84 0x82 — distance + alarm (3B): distance(2B u16) + alarm_type(1B)
 *     alarm_type: 0=threshold_alarm_release, 1=threshold_alarm
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF          — reboot
 *   0xFF 0x4A 0x00          — sync_time
 *   0xFF 0x28 0xFF          — query_device_status
 *   0xFF 0x02 u16LE         — collection_interval (s, [60, 64800])
 *   0xFF 0x03 u16LE         — report_interval (s, [60, 64800])
 *   0xFF 0x70 u16LE         — people_existing_height (mm)
 *   0xFF 0x77 u16LE         — install_height (mm, [30, 4500])
 *   0xFF 0x13 u8            — install_height_enable
 *   0xFF 0x71 u8            — working_mode (0=standard, 1=bin, 2=parking)
 *   0xFF 0x3E u8            — tilt_linkage_distance_enable
 *   0xFF 0x56 u8            — tof_detection_enable
 *   0xFF 0x1C counts(1B) interval(1B) — recollection_config
 *   0xFF 0x06 data(11B)     — alarm config (standard or bin mode)
 *     data[0]: bits[2:0]=condition, bits[5:3]=mode (1=standard, 2=bin), bit7=alarm_release_enable
 *     data[1-2]: threshold_min (u16LE, mm)
 *     data[3-4]: threshold_max (u16LE, mm)
 *     data[5-8]: reserved zeros
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x04 0x82 (distance on channel 4) — unique to EM400-MUD.
 *   EM310-UDL uses 0x03 0x82 (distance on channel 3).
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
const CONDITION_MAP: Record<number, string>  = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_R:   Record<string, number>  = { disable:0, below:1, above:2, between:3, outside:4 };
const WORKING_MAP:   Record<number, string>  = { 0:'standard', 1:'bin', 2:'parking' };
const WORKING_R:     Record<string, number>  = { standard:0, bin:1, parking:2 };
const ALARM_MAP:     Record<number, string>  = { 0:'threshold_alarm_release', 1:'threshold_alarm' };

export class MilesightEM400MudCodec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-em400-mud';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM400-MUD'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Multifunctional Sensor';
  readonly modelFamily     = 'EM400-MUD';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em400-mud/em400-mud.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'EM400-MUD',
    description:  'Multifunctional Ultrasonic Distance/Level Sensor — standard/bin/parking modes, T/H, tilt',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'  },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C' },
      { key: 'distance',    label: 'Distance',    type: 'number' as const, unit: 'mm' },
      { key: 'position',    label: 'Position',    type: 'string' as const, enum: ['normal', 'tilt'] },
      { key: 'distance_alarm',    label: 'Distance Alarm',     type: 'string' as const },
      { key: 'temperature_alarm', label: 'Temperature Alarm',  type: 'string' as const },
    ],
    commands: [
      { type: 'reboot',              label: 'Reboot Device',       params: [] },
      { type: 'sync_time',           label: 'Sync Time',           params: [] },
      { type: 'query_device_status', label: 'Query Device Status', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 60, max: 64800 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60, max: 64800 }],
      },
      {
        type:   'set_working_mode',
        label:  'Set Working Mode',
        params: [{ key: 'working_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Standard', value: 'standard' }, { label: 'Bin', value: 'bin' }, { label: 'Parking', value: 'parking' }] }],
      },
      {
        type:   'set_install_height',
        label:  'Set Install Height',
        params: [{ key: 'install_height', label: 'Height (mm)', type: 'number' as const, required: true, default: 1000, min: 30, max: 4500 }],
      },
      {
        type:   'set_install_height_enable',
        label:  'Set Install Height Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_standard_mode_alarm',
        label:  'Set Standard Mode Alarm',
        params: [
          { key: 'condition',            label: 'Condition',           type: 'select' as const, required: true, options: ['disable','below','above','between','outside'].map(v => ({ label: v, value: v })) },
          { key: 'alarm_release_enable', label: 'Alarm Release Enable', type: 'boolean' as const, required: false },
          { key: 'threshold_min',        label: 'Min (mm)',            type: 'number' as const, required: false, default: 0    },
          { key: 'threshold_max',        label: 'Max (mm)',            type: 'number' as const, required: false, default: 5000 },
        ],
      },
      {
        type:   'set_bin_mode_alarm',
        label:  'Set Bin Mode Alarm',
        params: [
          { key: 'condition',            label: 'Condition',           type: 'select' as const, required: true, options: ['disable','below','above','between','outside'].map(v => ({ label: v, value: v })) },
          { key: 'alarm_release_enable', label: 'Alarm Release Enable', type: 'boolean' as const, required: false },
          { key: 'threshold_min',        label: 'Min (mm)',            type: 'number' as const, required: false, default: 0    },
          { key: 'threshold_max',        label: 'Max (mm)',            type: 'number' as const, required: false, default: 5000 },
        ],
      },
      {
        type:   'set_tilt_linkage_distance_enable',
        label:  'Set Tilt Linkage Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery',     keys: ['battery']     },
      { type: 'value'   as const, label: 'Temperature', keys: ['temperature'], unit: '°C' },
      { type: 'value'   as const, label: 'Distance',    keys: ['distance'],    unit: 'mm' },
      { type: 'status'  as const, label: 'Position',    keys: ['position']                },
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
      else if (ch === 0x03 && ty === 0x67) {
        const raw = (bytes[i+1] << 8) | bytes[i];
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10; i += 2;
      }
      // EM400-MUD: distance on channel 0x04 (vs EM310-UDL channel 0x03)
      else if (ch === 0x04 && ty === 0x82) {
        decoded.distance = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      else if (ch === 0x05 && ty === 0x00) {
        decoded.position = bytes[i++] === 1 ? 'tilt' : 'normal';
      }
      // Temperature with alarm flag (3B)
      else if (ch === 0x83 && ty === 0x67) {
        const raw = (bytes[i+1] << 8) | bytes[i];
        decoded.temperature      = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        decoded.temperature_alarm = ALARM_MAP[bytes[i+2] & 0xff] ?? 'unknown'; i += 3;
      }
      // Distance with alarm flag (3B)
      else if (ch === 0x84 && ty === 0x82) {
        decoded.distance       = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.distance_alarm = ALARM_MAP[bytes[i+2] & 0xff] ?? 'unknown'; i += 3;
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
      case 0x02: data.collection_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x03: data.report_interval     = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x06: {
        const b    = bytes[offset] & 0xff;
        const cond = b & 0x07;
        const mode = (b >> 3) & 0x07;
        const rel  = (b >> 7) & 0x01;
        const cfg  = {
          condition:            CONDITION_MAP[cond] ?? 'unknown',
          alarm_release_enable: rel === 1 ? 'enable' : 'disable',
          threshold_min:        ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff,
          threshold_max:        ((bytes[offset+4] << 8) | bytes[offset+3]) & 0xffff,
        };
        if      (mode === 1) data.standard_mode_alarm_config = cfg;
        else if (mode === 2) data.bin_mode_alarm_config      = cfg;
        offset += 9; break;
      }

      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x13: data.install_height_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x1c:
        data.recollection_config = { counts: bytes[offset] & 0xff, interval: bytes[offset+1] & 0xff };
        offset += 2; break;

      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      case 0x3e: data.tilt_linkage_distance_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x4a: data.sync_time           = 'yes'; offset += 1; break;
      case 0x56: data.tof_detection_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x70: data.people_existing_height = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x71: data.working_mode           = WORKING_MAP[bytes[offset++]] ?? 'unknown'; break;
      case 0x77: data.install_height         = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      default: offset += 1; break;
    }

    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':              bytes = [0xff, 0x10, 0xff]; break;
      case 'sync_time':           bytes = [0xff, 0x4a, 0x00]; break;
      case 'query_device_status': bytes = [0xff, 0x28, 0xff]; break;

      case 'set_collection_interval': {
        const v = p.collection_interval ?? p.seconds ?? 300;
        if (v < 60 || v > 64800) throw new Error('collection_interval: 60–64800 s');
        bytes = [0xff, 0x02, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_report_interval': {
        const v = p.report_interval ?? p.seconds ?? 600;
        if (v < 60 || v > 64800) throw new Error('report_interval: 60–64800 s');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_people_existing_height': {
        const v = p.people_existing_height ?? 20;
        bytes = [0xff, 0x70, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_install_height': {
        const v = p.install_height ?? 1000;
        if (v < 30 || v > 4500) throw new Error('install_height: 30–4500 mm');
        bytes = [0xff, 0x77, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_install_height_enable':
        bytes = [0xff, 0x13, p.enable ? 1 : 0]; break;
      case 'set_working_mode': {
        const mode = typeof p.working_mode === 'string' ? (WORKING_R[p.working_mode] ?? 0) : (p.working_mode ?? 0);
        bytes = [0xff, 0x71, mode & 0xff]; break;
      }
      case 'set_tilt_linkage_distance_enable':
        bytes = [0xff, 0x3e, p.enable ? 1 : 0]; break;
      case 'set_tof_detection_enable':
        bytes = [0xff, 0x56, p.enable ? 1 : 0]; break;

      case 'set_standard_mode_alarm': bytes = this.encodeAlarm(1, p.standard_mode_alarm_config ?? p); break;
      case 'set_bin_mode_alarm':      bytes = this.encodeAlarm(2, p.bin_mode_alarm_config      ?? p); break;

      case 'set_recollection_config': {
        const cfg = p.recollection_config ?? p;
        bytes = [0xff, 0x1c, (cfg.counts ?? 1) & 0xff, (cfg.interval ?? 5) & 0xff]; break;
      }

      default:
        throw new Error(`EM400-MUD: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  private encodeAlarm(mode: 1 | 2, cfg: any): number[] {
    const condition = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
    const rel       = cfg.alarm_release_enable === 'enable' || cfg.alarm_release_enable === 1 ? 1 : 0;
    const dataByte  = (rel << 7) | ((mode & 0x07) << 3) | (condition & 0x07);
    const min = cfg.threshold_min ?? 0;
    const max = cfg.threshold_max ?? 0;
    return [
      0xff, 0x06, dataByte,
      min & 0xff, (min >> 8) & 0xff,
      max & 0xff, (max >> 8) & 0xff,
      0, 0, 0, 0,
    ];
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x04 0x82 (distance on channel 4) — unique to EM400-MUD.
  // EM310-UDL uses 0x03 0x82 (channel 3).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x04 && bytes[i+1] === 0x82) return true; // distance ch4
      if (bytes[i] === 0x84 && bytes[i+1] === 0x82) return true; // distance+alarm ch4
    }
    return false;
  }
}