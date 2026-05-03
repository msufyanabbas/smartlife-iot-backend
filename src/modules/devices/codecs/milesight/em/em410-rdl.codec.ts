// src/modules/devices/codecs/milesight/em410-rdl.codec.ts
/**
 * Milesight EM410-RDL — LoRaWAN Radar Distance/Level Sensor
 *
 * ── Key differences from EM400-MUD/TLD/UDL ───────────────────────────────────
 * - Distance is int16 (signed, can represent depth/level) vs uint16
 * - Additional channel: 0x06 0xC7 — radar_signal_rssi (int16/100) [fingerprint]
 * - Additional alarm channels: 0x94 0x82 (mutation alarm 5B), 0xB4 0x82 (exception 3B)
 * - 11B history record with mutation + event bitmask
 * - Extended downlink prefix 0xF9 for several commands (vs 0xFF)
 * - report_interval in minutes (0xFF 0x8E sub u16LE), not seconds
 * - collection_interval in minutes (0xF9 0x39 u16LE)
 * - time_zone in minutes-from-UTC (UTC+8 = 480)
 * - 4 alarm config types: distance(1), mutation(2), tank_distance(3), tank_mutation(4)
 * - Radar-specific commands: calibration, blind detection, signal quality, peak sorting
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
 *   0x04 0x82 — distance (int16 LE, mm — signed!)
 *   0x05 0x00 — position (uint8: 0=normal, 1=tilt)
 *   0x06 0xC7 — radar_signal_rssi (int16 LE /100) ← EM410-RDL unique fingerprint
 *   0x84 0x82 — distance alarm (3B): distance(int16) + alarm_type(1B)
 *               alarm_type: 0=threshold_alarm_release, 1=threshold_alarm, 2=mutation_alarm
 *   0x94 0x82 — distance mutation alarm (5B): distance(int16) + mutation(int16) + alarm_type(1B)
 *   0xB4 0x82 — distance exception alarm (3B): distance_raw(uint16) + exception_type(1B)
 *               exception_type: 0=blind_alarm_release, 1=blind_alarm, 2=no_target, 3=sensor_exception
 *   0x20 0xCE — history (11B): timestamp(4B u32) + distance(2B i16) + temperature(2B i16/10)
 *                              + mutation(2B i16) + event(1B bitmask)
 *               event bits: 0=threshold_alarm, 1=threshold_alarm_release, 2=blind_alarm,
 *                           3=blind_alarm_release, 4=mutation_alarm, 5=tilt_alarm
 *
 * ── Downlink commands ─────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF         — reboot
 *   0xFF 0x28 0x01         — report_status
 *   0xFF 0x8E 0x00 u16LE   — report_interval (min, [1,1440])
 *   0xF9 0x39 u16LE        — collection_interval (min, [1,1440])
 *   0xFF 0x4A 0xFF         — sync_time
 *   0xFF 0xBD i16LE        — time_zone (min, e.g. 480=UTC+8)
 *   0xFF 0x1B mode(1B) 0x00 0x00 max(u16LE) — distance_range
 *   0xFF 0x06 data(11B)    — alarm config (4 types via bits[5:3])
 *     data[0]: bits[2:0]=condition_or_5, bits[5:3]=id, bit7=alarm_release_enable
 *     data[1-2]: threshold_min (i16LE)
 *     data[3-4]: threshold_max or mutation (i16LE)
 *     data[5-8]: reserved zeros
 *   0xFF 0xF2 u16LE        — alarm_counts
 *   0xFF 0x2A 0x00         — radar_calibration
 *   0xFF 0x2A 0x01         — radar_blind_calibration
 *   0xFF 0xAB enable(1B) i16LE — distance_calibration_settings
 *   0xF9 0x12 u8           — distance_mode
 *   0xF9 0x13 u8           — blind_detection_enable
 *   0xF9 0x14 i16LE        — signal_quality
 *   0xF9 0x15 i16LE×10     — distance_threshold_sensitive
 *   0xF9 0x16 u8           — peak_sorting (0=closest, 1=strongest)
 *   0xFF 0x1C counts(1B) interval(1B) — recollection_config ([1,3], [1,10])
 *   0xFF 0x3E u8           — tilt_distance_link
 *   0xFF 0x69 u8           — retransmit_enable
 *   0xFF 0x6A 0x00 u16LE   — retransmit_interval (s)
 *   0xFF 0x6A 0x01 u16LE   — resend_interval (s)
 *   0xFD 0x6D 0xFF         — stop_transmit
 *   0xFF 0x68 u8           — history_enable
 *   0xFD 0x6B u32LE        — fetch_history (start only)
 *   0xFD 0x6C u32LE u32LE  — fetch_history (start + end)
 *   0xFF 0x27 0x01         — clear_history
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x06 0xC7 (radar_signal_rssi) — unique to EM410-RDL.
 *   Also matches on 0x94 0x82 (mutation alarm) or 0xB4 0x82 (exception alarm).
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };

const CONDITION_MAP: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside', 5:'mutation' };
const CONDITION_R:   Record<string, number> = { disable:0, below:1, above:2, between:3, outside:4, mutation:5 };

const DISTANCE_MODE_MAP: Record<number, string> = { 0:'general', 1:'rainwater', 2:'wastewater', 3:'tank' };
const DISTANCE_MODE_R:   Record<string, number>  = { general:0, rainwater:1, wastewater:2, tank:3 };

const PEAK_MAP: Record<number, string> = { 0:'closest', 1:'strongest' };
const PEAK_R:   Record<string, number>  = { closest:0, strongest:1 };

const ALARM_MAP: Record<number, string> = { 0:'threshold_alarm_release', 1:'threshold_alarm', 2:'mutation_alarm' };
const EXCEPTION_MAP: Record<number, string> = { 0:'blind_alarm_release', 1:'blind_alarm', 2:'no_target', 3:'sensor_exception' };

const TZ_MAP: Record<number, string> = {
  '-720':'UTC-12', '-660':'UTC-11', '-600':'UTC-10', '-570':'UTC-9:30', '-540':'UTC-9',
  '-480':'UTC-8', '-420':'UTC-7', '-360':'UTC-6', '-300':'UTC-5', '-240':'UTC-4',
  '-210':'UTC-3:30', '-180':'UTC-3', '-120':'UTC-2', '-60':'UTC-1', '0':'UTC',
  '60':'UTC+1', '120':'UTC+2', '180':'UTC+3', '210':'UTC+3:30', '240':'UTC+4',
  '270':'UTC+4:30', '300':'UTC+5', '330':'UTC+5:30', '345':'UTC+5:45', '360':'UTC+6',
  '390':'UTC+6:30', '420':'UTC+7', '480':'UTC+8', '540':'UTC+9', '570':'UTC+9:30',
  '600':'UTC+10', '630':'UTC+10:30', '660':'UTC+11', '720':'UTC+12',
  '765':'UTC+12:45', '780':'UTC+13', '840':'UTC+14',
};

export class MilesightEM410RdlCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em410-rdl';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM410-RDL'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Radar Sensor';
  readonly modelFamily     = 'EM410-RDL';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em410-rdl/em410-rdl.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'EM410-RDL',
    description:  'Radar Distance/Level Sensor — signed distance, RSSI, mutation/exception alarms, history',
    telemetryKeys: [
      { key: 'battery',           label: 'Battery',           type: 'number' as const, unit: '%'   },
      { key: 'temperature',       label: 'Temperature',       type: 'number' as const, unit: '°C'  },
      { key: 'distance',          label: 'Distance',          type: 'number' as const, unit: 'mm'  },
      { key: 'position',          label: 'Position',          type: 'string' as const, enum: ['normal', 'tilt'] },
      { key: 'radar_signal_rssi', label: 'Radar Signal RSSI', type: 'number' as const               },
    ],
    commands: [
      { type: 'reboot',                   label: 'Reboot Device',            params: [] },
      { type: 'report_status',            label: 'Report Status',            params: [] },
      { type: 'sync_time',                label: 'Sync Time',                params: [] },
      { type: 'stop_transmit',            label: 'Stop Transmit',            params: [] },
      { type: 'clear_history',            label: 'Clear History',            params: [] },
      { type: 'radar_calibration',        label: 'Radar Calibration',        params: [] },
      { type: 'radar_blind_calibration',  label: 'Radar Blind Calibration',  params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 20, min: 1, max: 1440 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 60, min: 1, max: 1440 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Offset (minutes, UTC+8=480)', type: 'number' as const, required: true, default: 180 }],
      },
      {
        type:   'set_distance_mode',
        label:  'Set Distance Mode',
        params: [{ key: 'distance_mode', label: 'Mode', type: 'select' as const, required: true, options: ['general','rainwater','wastewater','tank'].map(v => ({ label: v, value: v })) }],
      },
      {
        type:   'set_distance_alarm',
        label:  'Set Distance Alarm',
        params: [
          { key: 'condition',            label: 'Condition',           type: 'select' as const, required: true, options: ['disable','below','above','between','outside'].map(v => ({ label: v, value: v })) },
          { key: 'alarm_release_enable', label: 'Alarm Release Enable', type: 'boolean' as const, required: false },
          { key: 'threshold_min',        label: 'Min (mm)',            type: 'number' as const, required: false, default: 0    },
          { key: 'threshold_max',        label: 'Max (mm)',            type: 'number' as const, required: false, default: 5000 },
        ],
      },
      {
        type:   'set_distance_mutation_alarm',
        label:  'Set Distance Mutation Alarm',
        params: [
          { key: 'enable',               label: 'Enable',              type: 'boolean' as const, required: true  },
          { key: 'alarm_release_enable', label: 'Alarm Release Enable', type: 'boolean' as const, required: false },
          { key: 'mutation',             label: 'Mutation (mm)',        type: 'number'  as const, required: false, default: 100 },
        ],
      },
      {
        type:   'set_peak_sorting',
        label:  'Set Peak Sorting',
        params: [{ key: 'peak_sorting', label: 'Method', type: 'select' as const, required: true, options: [{ label: 'Closest', value: 'closest' }, { label: 'Strongest', value: 'strongest' }] }],
      },
      {
        type:   'set_blind_detection_enable',
        label:  'Set Blind Detection Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
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
      { type: 'battery' as const, label: 'Battery',           keys: ['battery']           },
      { type: 'value'   as const, label: 'Distance',          keys: ['distance'],          unit: 'mm' },
      { type: 'value'   as const, label: 'Temperature',       keys: ['temperature'],       unit: '°C' },
      { type: 'value'   as const, label: 'Radar Signal RSSI', keys: ['radar_signal_rssi']            },
      { type: 'status'  as const, label: 'Position',          keys: ['position']                     },
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
      // Distance — int16 (signed, mm)
      else if (ch === 0x04 && ty === 0x82) {
        const raw = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.distance = raw > 0x7fff ? raw - 0x10000 : raw; i += 2;
      }
      else if (ch === 0x05 && ty === 0x00) {
        decoded.position = bytes[i++] === 1 ? 'tilt' : 'normal';
      }
      // Radar signal RSSI — int16/100 — EM410-RDL unique channel
      else if (ch === 0x06 && ty === 0xc7) {
        const raw = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.radar_signal_rssi = (raw > 0x7fff ? raw - 0x10000 : raw) / 100; i += 2;
      }

      // Distance alarm (3B): distance(i16) + alarm_type(1B)
      else if (ch === 0x84 && ty === 0x82) {
        const raw = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        const dist = raw > 0x7fff ? raw - 0x10000 : raw;
        decoded.distance = dist;
        if (!decoded.event) decoded.event = [];
        (decoded.event as any[]).push({
          distance: dist,
          distance_alarm: ALARM_MAP[bytes[i+2] & 0xff] ?? 'unknown',
        });
        i += 3;
      }

      // Distance mutation alarm (5B): distance(i16) + mutation(i16) + alarm_type(1B)
      else if (ch === 0x94 && ty === 0x82) {
        const rawD = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        const dist = rawD > 0x7fff ? rawD - 0x10000 : rawD;
        const rawM = ((bytes[i+3] << 8) | bytes[i+2]) & 0xffff;
        const mut  = rawM > 0x7fff ? rawM - 0x10000 : rawM;
        decoded.distance = dist;
        if (!decoded.event) decoded.event = [];
        (decoded.event as any[]).push({
          distance: dist,
          distance_mutation: mut,
          distance_alarm: ALARM_MAP[bytes[i+4] & 0xff] ?? 'unknown',
        });
        i += 5;
      }

      // Distance exception alarm (3B): distance_raw(u16) + exception_type(1B)
      else if (ch === 0xb4 && ty === 0x82) {
        const rawD = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        const exc  = EXCEPTION_MAP[bytes[i+2] & 0xff] ?? 'unknown';
        const entry: Record<string, any> = { distance_exception: exc };
        // 0xFFFD=no target, 0xFFFF=sensor exception — don't set distance field
        if (rawD !== 0xfffd && rawD !== 0xffff) {
          entry.distance = rawD > 0x7fff ? rawD - 0x10000 : rawD;
        }
        if (!decoded.event) decoded.event = [];
        (decoded.event as any[]).push(entry);
        i += 3;
      }

      // History record (11B): timestamp(4B) + distance(2B i16) + temperature(2B i16/10)
      //                       + mutation(2B i16) + event(1B bitmask)
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i+3] << 24) | (bytes[i+2] << 16) | (bytes[i+1] << 8) | bytes[i]) >>> 0);
        const rawD = ((bytes[i+5] << 8) | bytes[i+4]) & 0xffff;
        const rawT = ((bytes[i+7] << 8) | bytes[i+6]) & 0xffff;
        const rawM = ((bytes[i+9] << 8) | bytes[i+8]) & 0xffff;
        const evtB = bytes[i+10] & 0xff;

        const entry: Record<string, any> = { timestamp: ts };

        if      (rawD === 0xfffd) entry.distance_sensor_status = 'no_target';
        else if (rawD === 0xffff) entry.distance_sensor_status = 'sensor_exception';
        else if (rawD === 0xfffe) entry.distance_sensor_status = 'disabled';
        else                      entry.distance = rawD > 0x7fff ? rawD - 0x10000 : rawD;

        if      (rawT === 0xfffe) entry.temperature_sensor_status = 'disabled';
        else if (rawT === 0xffff) entry.temperature_sensor_status = 'sensor_exception';
        else                      entry.temperature = (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10;

        const events: string[] = [];
        if ((evtB >> 0) & 1) events.push('threshold_alarm');
        if ((evtB >> 1) & 1) events.push('threshold_alarm_release');
        if ((evtB >> 2) & 1) events.push('blind_alarm');
        if ((evtB >> 3) & 1) events.push('blind_alarm_release');
        if ((evtB >> 4) & 1) {
          events.push('mutation_alarm');
          entry.distance_mutation = rawM > 0x7fff ? rawM - 0x10000 : rawM;
        }
        if ((evtB >> 5) & 1) events.push('tilt_alarm');
        if (events.length > 0) entry.event = events;

        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(entry);
        i += 11;
      }

      // ── Downlink response channels ─────────────────────────────────────────

      else if (ch === 0xfe || ch === 0xff) {
        const r = this.decodeDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, r.data);
        i = r.offset;
      }
      else if (ch === 0xf8 || ch === 0xf9) {
        const r = this.decodeDownlinkResponseExt(ch, ty, bytes, i);
        Object.assign(decoded, r.data);
        i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private readInt16(bytes: number[], offset: number): number {
    const raw = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
    return raw > 0x7fff ? raw - 0x10000 : raw;
  }

  private decodeDownlinkResponse(
    ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x06: {
        const b    = bytes[offset] & 0xff;
        const cond = b & 0x07;
        const id   = (b >> 3) & 0x07;
        const rel  = (b >> 7) & 0x01;
        const min  = this.readInt16(bytes, offset + 1);
        const max  = this.readInt16(bytes, offset + 3);
        const cfg  = {
          enable:               cond === 0 ? 'disable' : 'enable',
          condition:            CONDITION_MAP[cond] ?? 'unknown',
          alarm_release_enable: rel === 1 ? 'enable' : 'disable',
          threshold_min: min,
          threshold_max: max,
        };
        if      (id === 1) data.distance_alarm_config              = cfg;
        else if (id === 2) data.distance_mutation_alarm_config     = { enable: cfg.enable, alarm_release_enable: cfg.alarm_release_enable, mutation: max };
        else if (id === 3) data.tank_mode_distance_alarm_config    = cfg;
        else if (id === 4) data.tank_mode_distance_mutation_alarm_config = { enable: cfg.enable, alarm_release_enable: cfg.alarm_release_enable, mutation: max };
        offset += 9; break;
      }

      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x1b: {
        data.distance_range = {
          mode: DISTANCE_MODE_MAP[bytes[offset]] ?? 'unknown',
          max:  ((bytes[offset+4] << 8) | bytes[offset+3]) & 0xffff,
        };
        offset += 5; break;
      }
      case 0x1c:
        data.recollection_config = { counts: bytes[offset] & 0xff, interval: bytes[offset+1] & 0xff };
        offset += 2; break;
      case 0x27: data.clear_history  = 'yes'; offset += 1; break;
      case 0x28: data.report_status  = 'yes'; offset += 1; break;
      case 0x2a: {
        const ct = bytes[offset++] & 0xff;
        if      (ct === 0) data.radar_calibration       = 'yes';
        else if (ct === 1) data.radar_blind_calibration = 'yes';
        break;
      }
      case 0x3e: data.tilt_distance_link = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x4a: data.sync_time          = 'yes'; offset += 1; break;
      case 0x68: data.history_enable     = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: data.retransmit_enable  = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x6a: {
        const sub = bytes[offset] & 0xff;
        const val = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        if (sub === 0) data.retransmit_interval = val;
        else           data.resend_interval     = val;
        offset += 3; break;
      }
      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;
      case 0x8e: {
        // first byte is sub-type (0x00), then u16LE report_interval in minutes
        data.report_interval = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        offset += 3; break;
      }
      case 0xab: {
        data.distance_calibration_settings = {
          enable:            bytes[offset] === 1 ? 'enable' : 'disable',
          calibration_value: this.readInt16(bytes, offset + 1),
        };
        offset += 3; break;
      }
      case 0xbd: {
        const tz = this.readInt16(bytes, offset);
        data.time_zone = TZ_MAP[String(tz)] ?? `UTC${tz >= 0 ? '+' : ''}${tz/60}`;
        offset += 2; break;
      }
      case 0xf2: {
        data.alarm_counts = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
        offset += 2; break;
      }
      default: offset += 1; break;
    }

    return { data, offset };
  }

  private decodeDownlinkResponseExt(
    code: number, ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const hasResult = code === 0xf8;

    switch (ty) {
      case 0x12: {
        const val = bytes[offset] & 0xff;
        const res = hasResult ? bytes[offset+1] & 0xff : 0;
        if (res === 0) data.distance_mode = DISTANCE_MODE_MAP[val] ?? 'unknown';
        offset += hasResult ? 2 : 1; break;
      }
      case 0x13: {
        const val = bytes[offset] & 0xff;
        const res = hasResult ? bytes[offset+1] & 0xff : 0;
        if (res === 0) data.blind_detection_enable = val === 1 ? 'enable' : 'disable';
        offset += hasResult ? 2 : 1; break;
      }
      case 0x14: {
        const val = this.readInt16(bytes, offset);
        const res = hasResult ? bytes[offset+2] & 0xff : 0;
        if (res === 0) data.signal_quality = val;
        offset += hasResult ? 3 : 2; break;
      }
      case 0x15: {
        const val = this.readInt16(bytes, offset);
        const res = hasResult ? bytes[offset+2] & 0xff : 0;
        if (res === 0) data.distance_threshold_sensitive = val / 10;
        offset += hasResult ? 3 : 2; break;
      }
      case 0x16: {
        const val = bytes[offset] & 0xff;
        const res = hasResult ? bytes[offset+1] & 0xff : 0;
        if (res === 0) data.peak_sorting = PEAK_MAP[val] ?? 'unknown';
        offset += hasResult ? 2 : 1; break;
      }
      case 0x0d: {
        const en  = bytes[offset] & 0xff;
        const inv = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        const res = hasResult ? bytes[offset+3] & 0xff : 0;
        if (res === 0) data.retransmit_config = { enable: en === 1 ? 'enable' : 'disable', retransmit_interval: inv };
        offset += hasResult ? 4 : 3; break;
      }
      case 0x39: {
        const val = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
        const res = hasResult ? bytes[offset+2] & 0xff : 0;
        if (res === 0) data.collection_interval = val;
        offset += hasResult ? 3 : 2; break;
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
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status': bytes = [0xff, 0x28, 0x01]; break;
      case 'sync_time':     bytes = [0xff, 0x4a, 0xff]; break;
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history': bytes = [0xff, 0x27, 0x01]; break;
      case 'radar_calibration':       bytes = [0xff, 0x2a, 0x00]; break;
      case 'radar_blind_calibration': bytes = [0xff, 0x2a, 0x01]; break;

      case 'set_report_interval': {
        const v = p.report_interval ?? p.minutes ?? 20;
        if (v < 1 || v > 1440) throw new Error('report_interval: 1–1440 min');
        bytes = [0xff, 0x8e, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_collection_interval': {
        const v = p.collection_interval ?? p.minutes ?? 60;
        if (v < 1 || v > 1440) throw new Error('collection_interval: 1–1440 min');
        bytes = [0xf9, 0x39, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_time_zone': {
        const v = p.time_zone ?? 0;
        const le = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0xbd, le & 0xff, (le >> 8) & 0xff]; break;
      }
      case 'set_distance_range': {
        const mode = typeof p.mode === 'string' ? (DISTANCE_MODE_R[p.mode] ?? 0) : (p.mode ?? 0);
        const max  = p.max ?? 1000;
        bytes = [0xff, 0x1b, mode & 0xff, 0, 0, max & 0xff, (max >> 8) & 0xff]; break;
      }
      case 'set_distance_alarm':             bytes = this.encodeAlarmConfig(1, p); break;
      case 'set_distance_mutation_alarm':    bytes = this.encodeMutationConfig(2, p); break;
      case 'set_tank_distance_alarm':        bytes = this.encodeAlarmConfig(3, p); break;
      case 'set_tank_distance_mutation_alarm': bytes = this.encodeMutationConfig(4, p); break;

      case 'set_alarm_counts': {
        const v = p.alarm_counts ?? 10;
        bytes = [0xff, 0xf2, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_distance_calibration': {
        const en  = p.enable ? 1 : 0;
        const val = p.calibration_value ?? 0;
        const le  = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xab, en, le & 0xff, (le >> 8) & 0xff]; break;
      }
      case 'set_distance_mode': {
        const mode = typeof p.distance_mode === 'string' ? (DISTANCE_MODE_R[p.distance_mode] ?? 0) : (p.distance_mode ?? 0);
        bytes = [0xf9, 0x12, mode & 0xff]; break;
      }
      case 'set_blind_detection_enable':
        bytes = [0xf9, 0x13, p.enable ? 1 : 0]; break;
      case 'set_signal_quality': {
        const v = p.signal_quality ?? 0;
        const le = v < 0 ? v + 0x10000 : v;
        bytes = [0xf9, 0x14, le & 0xff, (le >> 8) & 0xff]; break;
      }
      case 'set_distance_threshold_sensitive': {
        const v = Math.round((p.distance_threshold_sensitive ?? 0) * 10);
        const le = v < 0 ? v + 0x10000 : v;
        bytes = [0xf9, 0x15, le & 0xff, (le >> 8) & 0xff]; break;
      }
      case 'set_peak_sorting': {
        const mode = typeof p.peak_sorting === 'string' ? (PEAK_R[p.peak_sorting] ?? 0) : (p.peak_sorting ?? 0);
        bytes = [0xf9, 0x16, mode & 0xff]; break;
      }
      case 'set_recollection_config': {
        const cfg = p.recollection_config ?? p;
        const cnt = cfg.counts ?? 1; const inv = cfg.interval ?? 5;
        if (cnt < 1 || cnt > 3)   throw new Error('recollection counts: 1–3');
        if (inv < 1 || inv > 10)  throw new Error('recollection interval: 1–10 s');
        bytes = [0xff, 0x1c, cnt & 0xff, inv & 0xff]; break;
      }
      case 'set_tilt_distance_link':
        bytes = [0xff, 0x3e, p.enable ? 1 : 0]; break;
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
        throw new Error(`EM410-RDL: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  private encodeAlarmConfig(id: number, p: any): number[] {
    const cfg  = p.distance_alarm_config ?? p.tank_mode_distance_alarm_config ?? p;
    const cond = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
    const rel  = cfg.alarm_release_enable === 'enable' || cfg.alarm_release_enable === 1 ? 1 : 0;
    const en   = cfg.enable === 'disable' || cfg.enable === 0 ? 0 : 1;
    const dataByte = (rel << 7) | ((id & 0x07) << 3) | (en === 0 ? 0 : cond & 0x07);
    const min = cfg.threshold_min ?? 0; const minLE = min < 0 ? min + 0x10000 : min;
    const max = cfg.threshold_max ?? 0; const maxLE = max < 0 ? max + 0x10000 : max;
    return [0xff, 0x06, dataByte, minLE & 0xff, (minLE >> 8) & 0xff, maxLE & 0xff, (maxLE >> 8) & 0xff, 0, 0, 0, 0];
  }

  private encodeMutationConfig(id: number, p: any): number[] {
    const cfg = p.distance_mutation_alarm_config ?? p.tank_mode_distance_mutation_alarm_config ?? p;
    const rel = cfg.alarm_release_enable === 'enable' || cfg.alarm_release_enable === 1 ? 1 : 0;
    const en  = cfg.enable === 'disable' || cfg.enable === 0 ? 0 : 1;
    const dataByte = (rel << 7) | ((id & 0x07) << 3) | (en === 0 ? 0 : 5); // condition=5=mutation
    const mut = cfg.mutation ?? 0; const mutLE = mut < 0 ? mut + 0x10000 : mut;
    return [0xff, 0x06, dataByte, 0, 0, mutLE & 0xff, (mutLE >> 8) & 0xff, 0, 0, 0, 0];
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // 0x06 0xC7 (radar_signal_rssi) is unique to EM410-RDL.
  // Also matches 0x94 0x82 (mutation) or 0xB4 0x82 (exception).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x06 && bytes[i+1] === 0xc7) return true; // radar RSSI
      if (bytes[i] === 0x94 && bytes[i+1] === 0x82) return true; // mutation alarm
      if (bytes[i] === 0xb4 && bytes[i+1] === 0x82) return true; // exception alarm
    }
    return false;
  }
}