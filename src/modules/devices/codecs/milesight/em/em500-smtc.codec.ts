// src/modules/devices/codecs/milesight/em500-smtc.codec.ts
/**
 * Milesight EM500-SMTC — LoRaWAN Soil Moisture / Temperature / EC Sensor
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
 *   0x04 0x68 — moisture (uint8 /2, %r.h.)      — low-resolution variant
 *   0x04 0xCA — moisture (uint16 LE /100, %r.h.) — high-resolution variant
 *   0x05 0x7F — ec (uint16 LE, µs/cm)            ← unique fingerprint
 *   0x83 0xD7 — temperature mutation alarm (5B):
 *               temperature(i16/10) + temperature_mutation(i16/10) + alarm_type(1B)
 *               alarm_type: 0=threshold_alarm, 1=threshold_alarm_release, 2=mutation_alarm
 *   0x20 0xCE — history (10B): timestamp(4B u32) + ec(2B u16) + temperature(2B i16/10) + moisture(2B u16/100)
 *
 * ── Moisture channel notes ────────────────────────────────────────────────────
 *   The device may send moisture as either:
 *   - 0x04 0x68: uint8, value / 2 → range 0–127.5 %r.h. (older firmware)
 *   - 0x04 0xCA: uint16 LE, value / 100 → range 0–655.35 %r.h. (newer firmware, higher precision)
 *   History always uses the 2B / 100 format.
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   Standard EM500 command set (no encoder source provided; using patterns from
 *   EM500-PT100 / EM500-LGT as reference):
 *   0xFF 0x10 0xFF         — reboot
 *   0xFF 0x28 0xFF         — report_status
 *   0xFF 0x4A 0xFF         — sync_time
 *   0xFF 0x02 u16LE        — collection_interval (s)
 *   0xFF 0x1C counts(1B) interval(1B) — recollection_config
 *   0xFF 0x03 u16LE        — report_interval (s)
 *   0xFF 0x11 u32LE        — timestamp (unix s)
 *   0xFF 0x17 i16LE        — time_zone (×10 units, UTC+8=80)
 *   0xFF 0x3B u8           — time_sync_enable
 *   0xFF 0x68 u8           — history_enable
 *   0xFD 0x6B u32LE        — fetch_history (start only)
 *   0xFD 0x6C u32LE u32LE  — fetch_history (start + end)
 *   0xFD 0x6D 0xFF         — stop_transmit
 *   0xFF 0x27 0x01         — clear_history
 *   0xFF 0x69 u8           — retransmit_enable
 *   0xFF 0x6A 0x00 u16LE   — retransmit_interval (s)
 *   0xFF 0x6A 0x01 u16LE   — resend_interval (s)
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x05 0x7F (EC µs/cm, uint16) — unique to EM500-SMTC.
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
const TEMP_ALARM_MAP: Record<number, string> = { 0:'threshold_alarm', 1:'threshold_alarm_release', 2:'mutation_alarm' };

const TZ_MAP: Record<number, string> = {
  '-120':'UTC-12','-110':'UTC-11','-100':'UTC-10','-95':'UTC-9:30','-90':'UTC-9',
  '-80':'UTC-8','-70':'UTC-7','-60':'UTC-6','-50':'UTC-5','-40':'UTC-4',
  '-35':'UTC-3:30','-30':'UTC-3','-20':'UTC-2','-10':'UTC-1','0':'UTC',
  '10':'UTC+1','20':'UTC+2','30':'UTC+3','35':'UTC+3:30','40':'UTC+4',
  '45':'UTC+4:30','50':'UTC+5','55':'UTC+5:30','57':'UTC+5:45','60':'UTC+6',
  '65':'UTC+6:30','70':'UTC+7','80':'UTC+8','90':'UTC+9','95':'UTC+9:30',
  '100':'UTC+10','105':'UTC+10:30','110':'UTC+11','120':'UTC+12',
  '127':'UTC+12:45','130':'UTC+13','140':'UTC+14',
};
const TZ_R: Record<string, number> = Object.fromEntries(Object.entries(TZ_MAP).map(([k,v]) => [v, Number(k)]));

const D2D_MODE_MAP: Record<number, string> = { 1:'threshold_alarm', 2:'threshold_alarm_release', 3:'mutation_alarm' };
const D2D_MODE_R:   Record<string, number>  = { threshold_alarm:1, threshold_alarm_release:2, mutation_alarm:3 };

export class MilesightEM500SmtcCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em500-smtc';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM500-SMTC'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Soil Sensor';
  readonly modelFamily     = 'EM500-SMTC';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em500-smtc/em500-smtc.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'EM500-SMTC',
    description:  'Soil Moisture / Temperature / EC Sensor — precision agriculture monitoring',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'     },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C'    },
      { key: 'moisture',    label: 'Moisture',    type: 'number' as const, unit: '%'     },
      { key: 'ec',          label: 'EC',          type: 'number' as const, unit: 'µs/cm' },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'report_status', label: 'Report Status',  params: [] },
      { type: 'sync_time',     label: 'Sync Time',      params: [] },
      { type: 'stop_transmit', label: 'Stop Transmit',  params: [] },
      { type: 'clear_history', label: 'Clear History',  params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 60 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60 }],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_d2d_enable',
        label:  'Set D2D Enable',
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
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery',     keys: ['battery']     },
      { type: 'gauge'   as const, label: 'Moisture',    keys: ['moisture'],    unit: '%'     },
      { type: 'value'   as const, label: 'Temperature', keys: ['temperature'], unit: '°C'    },
      { type: 'value'   as const, label: 'EC',          keys: ['ec'],          unit: 'µs/cm' },
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
        const raw = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10; i += 2;
      }
      // Moisture low-resolution (uint8 /2, matches humidity encoding)
      else if (ch === 0x04 && ty === 0x68) {
        decoded.moisture = (bytes[i++] & 0xff) / 2;
      }
      // Moisture high-resolution (uint16 LE /100)
      else if (ch === 0x04 && ty === 0xca) {
        decoded.moisture = (((bytes[i+1] << 8) | bytes[i]) & 0xffff) / 100; i += 2;
      }
      // EC — uint16 LE, µs/cm; unique fingerprint
      else if (ch === 0x05 && ty === 0x7f) {
        decoded.ec = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      // Temperature mutation alarm (5B)
      else if (ch === 0x83 && ty === 0xd7) {
        const rawT = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        const rawM = ((bytes[i+3] << 8) | bytes[i+2]) & 0xffff;
        decoded.temperature            = (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10;
        decoded.temperature_mutation   = (rawM > 0x7fff ? rawM - 0x10000 : rawM) / 10;
        decoded.temperature_alarm      = TEMP_ALARM_MAP[bytes[i+4] & 0xff] ?? 'unknown';
        i += 5;
      }
      // History (10B): timestamp(4B u32) + ec(2B u16) + temperature(2B i16/10) + moisture(2B u16/100)
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i+3] << 24) | (bytes[i+2] << 16) | (bytes[i+1] << 8) | bytes[i]) >>> 0);
        const ec   = ((bytes[i+5] << 8) | bytes[i+4]) & 0xffff;
        const rawT = ((bytes[i+7] << 8) | bytes[i+6]) & 0xffff;
        const temp = (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10;
        const mois = (((bytes[i+9] << 8) | bytes[i+8]) & 0xffff) / 100;
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({ timestamp: ts, ec, temperature: temp, moisture: mois });
        i += 10;
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

  private readInt16LE(bytes: number[], offset: number): number {
    const raw = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
    return raw > 0x7fff ? raw - 0x10000 : raw;
  }

  private decodeDownlinkResponse(
    ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x02: data.collection_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x03: data.report_interval     = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x11: {
        data.timestamp = (((bytes[offset+3] << 24) | (bytes[offset+2] << 16) | (bytes[offset+1] << 8) | bytes[offset]) >>> 0);
        offset += 4; break;
      }
      case 0x17: {
        const tz = this.readInt16LE(bytes, offset);
        data.time_zone = TZ_MAP[String(tz)] ?? `UTC${tz >= 0 ? '+' : ''}${tz/10}`;
        offset += 2; break;
      }
      case 0x1c:
        data.recollection_config = { counts: bytes[offset] & 0xff, interval: bytes[offset+1] & 0xff };
        offset += 2; break;
      case 0x27: data.clear_history    = 'yes'; offset += 1; break;
      case 0x28: data.report_status    = 'yes'; offset += 1; break;
      case 0x35: {
        data.d2d_key = bytes.slice(offset, offset + 8).map(b => (b & 0xff).toString(16).padStart(2, '0')).join('');
        offset += 8; break;
      }
      case 0x3b: data.time_sync_enable  = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x4a: data.sync_time         = 'yes'; offset += 1; break;
      case 0x68: data.history_enable    = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: data.retransmit_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x6a: {
        const sub = bytes[offset] & 0xff;
        const val = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        if (sub === 0) data.retransmit_interval = val;
        else           data.resend_interval     = val;
        offset += 3; break;
      }
      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;
      case 0x84: data.d2d_enable    = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x96: {
        const d2d: Record<string, any> = {
          mode:               D2D_MODE_MAP[bytes[offset] & 0xff] ?? 'unknown',
          enable:             bytes[offset+1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset+2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            (bytes[offset+4] & 0xff).toString(16).padStart(2,'0') +
                              (bytes[offset+3] & 0xff).toString(16).padStart(2,'0'),
        };
        offset += 8;
        if (!data.d2d_master_config) data.d2d_master_config = [];
        (data.d2d_master_config as any[]).push(d2d); break;
      }
      case 0xf2: data.alarm_report_counts  = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0xf5: data.alarm_release_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      default: offset += 1; break;
    }

    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':     bytes = [0xff, 0x4a, 0xff]; break;
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history': bytes = [0xff, 0x27, 0x01]; break;

      case 'set_collection_interval': {
        const v = p.collection_interval ?? p.seconds ?? 300;
        bytes = [0xff, 0x02, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_recollection_config': {
        const cfg = p.recollection_config ?? p;
        bytes = [0xff, 0x1c, (cfg.counts ?? 1) & 0xff, (cfg.interval ?? 5) & 0xff]; break;
      }
      case 'set_report_interval': {
        const v = p.report_interval ?? p.seconds ?? 600;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_timestamp': {
        const v = p.timestamp ?? 0;
        bytes = [0xff, 0x11, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; break;
      }
      case 'set_time_zone': {
        const v = typeof p.time_zone === 'string' ? (TZ_R[p.time_zone] ?? 0) : (p.time_zone ?? 0);
        const le = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0x17, le & 0xff, (le >> 8) & 0xff]; break;
      }
      case 'set_time_sync_enable':
        bytes = [0xff, 0x3b, p.enable ? 1 : 0]; break;

      case 'set_alarm_release_enable':
        bytes = [0xff, 0xf5, p.enable ? 1 : 0]; break;
      case 'set_alarm_report_counts': {
        const v = p.alarm_report_counts ?? 10;
        bytes = [0xff, 0xf2, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_d2d_config': {
        const cfg  = p.d2d_master_config ?? p;
        const mode = typeof cfg.mode === 'string' ? (D2D_MODE_R[cfg.mode] ?? 1) : (cfg.mode ?? 1);
        const en   = cfg.enable === 'enable' || cfg.enable === 1 ? 1 : 0;
        const lora = cfg.lora_uplink_enable === 'enable' || cfg.lora_uplink_enable === 1 ? 1 : 0;
        const cmd  = typeof cfg.d2d_cmd === 'string' ? cfg.d2d_cmd : '0000';
        const cmdB = [parseInt(cmd.slice(2,4), 16) || 0, parseInt(cmd.slice(0,2), 16) || 0];
        bytes = [0xff, 0x96, mode & 0xff, en, lora, ...cmdB, 0, 0, 0]; break;
      }
      case 'set_d2d_key': {
        const key = (p.d2d_key ?? '0000000000000000').padEnd(16,'0').slice(0,16);
        const keyBytes = Array.from({length:8}, (_,j) => parseInt(key.slice(j*2, j*2+2), 16) || 0);
        bytes = [0xff, 0x35, ...keyBytes]; break;
      }
      case 'set_d2d_enable':
        bytes = [0xff, 0x84, p.enable ? 1 : 0]; break;

      case 'set_history_enable':
        bytes = [0xff, 0x68, p.enable ? 1 : 0]; break;
      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, p.enable ? 1 : 0]; break;
      case 'set_retransmit_interval': {
        const v = p.retransmit_interval ?? p.seconds ?? 60;
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_resend_interval': {
        const v = p.resend_interval ?? p.seconds ?? 60;
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'fetch_history': {
        const start = p.start_time ?? 0;
        const end   = p.end_time;
        if (end !== undefined && end !== 0) {
          bytes = [0xfd, 0x6c,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
            end   & 0xff, (end   >> 8) & 0xff, (end   >> 16) & 0xff, (end   >> 24) & 0xff];
        } else {
          bytes = [0xfd, 0x6b,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff];
        }
        break;
      }

      default:
        throw new Error(`EM500-SMTC: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x05 0x7F (EC µs/cm, uint16) — unique to EM500-SMTC.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x05 && bytes[i+1] === 0x7f) return true;
    }
    return false;
  }
}