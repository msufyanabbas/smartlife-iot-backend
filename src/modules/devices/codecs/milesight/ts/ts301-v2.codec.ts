// src/modules/devices/codecs/milesight/ts301-v2.codec.ts
// Milesight TS301 v2 — Temperature + Humidity + Magnet Sensor
//
// Supersedes TS301 v1. Major differences:
//   NEW telemetry channels:
//     0x03 0x9A — humidity (int16 LE /10, %r.h.)        ← NEW (SHT4X only)
//     0x83 0x9A — humidity threshold alarm (3B)         ← NEW
//     0x93 0x9A — humidity mutation alarm (5B)          ← NEW
//     0xB3 0x9A — humidity sensor status (1B)           ← NEW
//     0xFF 0xA0 — sensor_id (nibble-packed type+sn)     ← NEW
//   Changed alarm type encoding:
//     0x83 0x67 / 0x84 0x67 — now 9 alarm types (0-8) not 3
//     0x93 0x67 / 0x94 0x67 — mutation uses type=8, value /10 (not /100)
//   History frame changes (0x20 0xCE):
//     New format: ts(4B) + mask(1B) + humidity_data(2B) + temperature_data(2B)
//     Sentinel values: -9990 = not available, -10000 = magnet close, -10010 = magnet open, -10020 = over_range
//     History event codes: 0-13 (richer than v1's 0-6)
//   NEW downlink commands:
//     0xF9 0x72 — dst_config (DST, 9B payload)
//     0xF9 0x9A — magnet_delay_time (uint16 LE ms)
//     0xF9 0x70 — shutdown
//     0xFF 0x7E — alarm_config (interval + counts)
//     0xFF 0xF5 — alarm_release_enable
//     Various D2D: 0xF9 0x63/0x66/0x69/0x6F/0x32/0x31, 0xFF 0x35/0x96
//   Timezone encoding: MINUTES (UTC+8=480) vs v1's hour×10
//   Alarm config 0xFF 0x06: alarm_type in bits[5:3] now 0=temp, 2=temp_mutation, 4=hum, 6=hum_mutation
//   Calibration 0xFF 0xEA: channel 0=temp (idx 0), channel 2=humidity (idx 2)
//
// canDecode: 0x03 0x9A (humidity), 0x83/0x93 0x9A (hum alarm), 0xB3 0x9A (hum status)
// Those channels are unique to v2; v1 lacks humidity entirely.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let c = 0; c < hex.length; c += 2) out.push(parseInt(hex.substr(c, 2), 16));
  return out;
}

// ── UC521-style timezone map (MINUTES not hour×10) ────────────────────────────
const TZ: Record<number, string> = {
  [-720]:'UTC-12',[-660]:'UTC-11',[-600]:'UTC-10',[-570]:'UTC-9:30',
  [-540]:'UTC-9', [-480]:'UTC-8', [-420]:'UTC-7', [-360]:'UTC-6',
  [-300]:'UTC-5', [-240]:'UTC-4', [-210]:'UTC-3:30',[-180]:'UTC-3',
  [-120]:'UTC-2', [-60]:'UTC-1',   [0]:'UTC',       [60]:'UTC+1',
  [120]:'UTC+2',  [180]:'UTC+3',  [210]:'UTC+3:30', [240]:'UTC+4',
  [270]:'UTC+4:30',[300]:'UTC+5', [330]:'UTC+5:30', [345]:'UTC+5:45',
  [360]:'UTC+6',  [390]:'UTC+6:30',[420]:'UTC+7',  [480]:'UTC+8',
  [540]:'UTC+9',  [570]:'UTC+9:30',[600]:'UTC+10', [630]:'UTC+10:30',
  [660]:'UTC+11', [720]:'UTC+12', [765]:'UTC+12:45',[780]:'UTC+13',
  [840]:'UTC+14',
};
function tzName(v: number): string { return TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(TZ)) if (n === name) return parseInt(k);
  return 480;
}

// ── Alarm type map (v2 uses 9 types) ─────────────────────────────────────────
const ALARM_MAP: Record<number, string> = {
  0:'above_threshold_alarm', 1:'above_threshold_alarm_release',
  2:'below_threshold_alarm',  3:'below_threshold_alarm_release',
  4:'between_threshold_alarm',5:'between_threshold_alarm_release',
  6:'outside_threshold_alarm',7:'outside_threshold_alarm_release',
  8:'mutation_alarm',
};

// ── History event codes ────────────────────────────────────────────────────────
const HIST_EVENT: Record<number, string> = {
  0:'none', 1:'above_threshold_alarm', 2:'above_threshold_alarm_release',
  3:'below_threshold_alarm', 4:'below_threshold_alarm_release',
  5:'between_threshold_alarm', 6:'between_threshold_alarm_release',
  7:'outside_threshold_alarm', 8:'outside_threshold_alarm_release',
  9:'mutation_alarm', 10:'period_report', 11:'magnet_alarm',
  12:'abnormal_alarm', 13:'button_trigger',
};

// Sentinel values used in history data
const HIST_NOT_AVAIL = -9990;   // raw -999.0 → skip
const HIST_MAGNET_CLOSE = -10000; // raw -1000.0
const HIST_MAGNET_OPEN  = -10010; // raw -1001.0 (actually -1001)
const HIST_OVER_RANGE   = -10020; // raw -1002.0

function readHistoryValue(raw: number): any {
  if (raw === HIST_NOT_AVAIL)   return undefined; // not available
  if (raw === HIST_MAGNET_CLOSE) return 'close';
  if (raw === HIST_MAGNET_OPEN)  return 'open';
  if (raw === HIST_OVER_RANGE)   return 'over_range';
  return raw / 10;
}

export class MilesightTS301V2Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ts301-v2';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS301-v2', 'TS301v2'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Temperature, Humidity & Magnet Sensor';
  readonly modelFamily     = 'TS301';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ts-series/ts301-v2/ts301.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'TS301-v2',
    description:  'Temperature, Humidity & Magnet Sensor — SHT4X probe with 9-type alarm system and D2D support',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'  },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C' },
      { key: 'humidity',    label: 'Humidity',    type: 'number' as const, unit: '%'  },
      { key: 'magnet',      label: 'Magnet',      type: 'string' as const, enum: ['open', 'close'] },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'report_status', label: 'Report Status', params: [] },
      { type: 'sync_time',     label: 'Sync Time',     params: [] },
      { type: 'clear_history', label: 'Clear History', params: [] },
      { type: 'stop_transmit', label: 'Stop Transmit', params: [] },
      { type: 'shutdown',      label: 'Shutdown',       params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 1440 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Time Zone', type: 'string' as const, required: true, default: 'UTC+8' }],
      },
      {
        type:   'set_temperature_unit_display',
        label:  'Set Temperature Unit',
        params: [{ key: 'temperature_unit_display', label: 'Unit', type: 'select' as const, required: true, options: [{ label: 'Celsius', value: 'celsius' }, { label: 'Fahrenheit', value: 'fahrenheit' }] }],
      },
      {
        type:   'set_temperature_alarm_config',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'enable',        label: 'Enable',              type: 'boolean' as const, required: true  },
          { key: 'condition',     label: 'Condition',           type: 'select'  as const, required: true,  options: [{ label: 'Below', value: 'below' }, { label: 'Above', value: 'above' }, { label: 'Between', value: 'between' }, { label: 'Outside', value: 'outside' }] },
          { key: 'threshold_min', label: 'Min Threshold (°C)',  type: 'number'  as const, required: false, default: 0  },
          { key: 'threshold_max', label: 'Max Threshold (°C)',  type: 'number'  as const, required: false, default: 60 },
        ],
      },
      {
        type:   'set_humidity_alarm_config',
        label:  'Set Humidity Alarm',
        params: [
          { key: 'enable',        label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'condition',     label: 'Condition', type: 'select'  as const, required: true,  options: [{ label: 'Below', value: 'below' }, { label: 'Above', value: 'above' }, { label: 'Between', value: 'between' }, { label: 'Outside', value: 'outside' }] },
          { key: 'threshold_min', label: 'Min (%)',   type: 'number'  as const, required: false, default: 0   },
          { key: 'threshold_max', label: 'Max (%)',   type: 'number'  as const, required: false, default: 100 },
        ],
      },
      {
        type:   'set_temperature_mutation_alarm_config',
        label:  'Set Temperature Mutation Alarm',
        params: [
          { key: 'enable',   label: 'Enable',       type: 'boolean' as const, required: true  },
          { key: 'mutation', label: 'Mutation (°C)', type: 'number'  as const, required: false, default: 5 },
        ],
      },
      {
        type:   'set_humidity_mutation_alarm_config',
        label:  'Set Humidity Mutation Alarm',
        params: [
          { key: 'enable',   label: 'Enable',      type: 'boolean' as const, required: true  },
          { key: 'mutation', label: 'Mutation (%)', type: 'number'  as const, required: false, default: 10 },
        ],
      },
      {
        type:   'set_alarm_config',
        label:  'Set Alarm Config',
        params: [
          { key: 'alarm_interval', label: 'Interval (minutes)', type: 'number' as const, required: false, default: 10 },
          { key: 'alarm_counts',   label: 'Counts',              type: 'number' as const, required: false, default: 1  },
        ],
      },
      {
        type:   'set_magnet_throttle',
        label:  'Set Magnet Throttle',
        params: [{ key: 'magnet_throttle', label: 'Throttle (ms)', type: 'number' as const, required: true, default: 0 }],
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
      { type: 'gauge' as const, label: 'Battery',     keys: ['battery'],     unit: '%'  },
      { type: 'value' as const, label: 'Temperature', keys: ['temperature'], unit: '°C' },
      { type: 'value' as const, label: 'Humidity',    keys: ['humidity'],    unit: '%'  },
      { type: 'value' as const, label: 'Magnet',      keys: ['magnet']                  },
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

      // ── Attributes ──────────────────────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++]; decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2; }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A',1:'Class B',2:'Class C',3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Sensor ID (0xFF 0xA0) ────────────────────────────────────────────────
      else if (ch === 0xff && ty === 0xa0) {
        const data  = bytes[i] & 0xff;
        const stype = data & 0x0f;
        const stypeMap: Record<number, string> = { 1:'PT100', 2:'SHT4X', 3:'DS18B20', 4:'MAGNET' };
        decoded.sensor_type = stypeMap[stype] ?? 'unknown';
        decoded.sensor_sn   = bytes.slice(i + 1, i + 9).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 9;
      }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Temperature (0x03 0x67) ───────────────────────────────────────────────
      else if (ch === 0x03 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10; i += 2;
      }

      // ── Magnet (0x03 0x00) ────────────────────────────────────────────────────
      else if (ch === 0x03 && ty === 0x00) {
        decoded.magnet = bytes[i] === 1 ? 'open' : 'close'; i += 1;
      }

      // ── Humidity (0x03 0x9A) — int16 LE /10 ──────────────────────────────────
      else if (ch === 0x03 && ty === 0x9a) {
        decoded.humidity = i16(bytes, i) / 10; i += 2;
      }

      // ── Temperature threshold alarm (0x83 0x67) ──────────────────────────────
      else if (ch === 0x83 && ty === 0x67) {
        const tv = i16(bytes, i) / 10;
        const at = ALARM_MAP[bytes[i + 2] & 0xff] ?? 'unknown';
        decoded.temperature = tv; decoded.temperature_alarm = at;
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ temperature: tv, temperature_alarm: at }); i += 3;
      }

      // ── Humidity threshold alarm (0x83 0x9A) ─────────────────────────────────
      else if (ch === 0x83 && ty === 0x9a) {
        const hv = i16(bytes, i) / 10;
        const at = ALARM_MAP[bytes[i + 2] & 0xff] ?? 'unknown';
        decoded.humidity = hv; decoded.humidity_alarm = at;
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ humidity: hv, humidity_alarm: at }); i += 3;
      }

      // ── Temperature mutation alarm (0x93 0x67) — mutation /10 ────────────────
      else if (ch === 0x93 && ty === 0x67) {
        const tv = i16(bytes, i) / 10;
        const mv = i16(bytes, i + 2) / 10;
        const at = ALARM_MAP[8]; // always mutation_alarm
        decoded.temperature = tv; decoded.temperature_mutation = mv; decoded.temperature_alarm = at;
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ temperature: tv, temperature_alarm: at, temperature_mutation: mv }); i += 5;
      }

      // ── Humidity mutation alarm (0x93 0x9A) ──────────────────────────────────
      else if (ch === 0x93 && ty === 0x9a) {
        const hv = i16(bytes, i) / 10;
        const mv = i16(bytes, i + 2) / 10;
        const at = ALARM_MAP[8];
        decoded.humidity = hv; decoded.humidity_mutation = mv; decoded.humidity_alarm = at;
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ humidity: hv, humidity_alarm: at, humidity_mutation: mv }); i += 5;
      }

      // ── Temperature sensor status (0xB3 0x67) ────────────────────────────────
      else if (ch === 0xb3 && ty === 0x67) {
        const stMap: Record<number, string> = { 0:'collection_failed', 1:'over_range', 2:'under_range' };
        decoded.temperature_sensor_status = stMap[bytes[i] & 0xff] ?? 'unknown'; i += 1;
      }

      // ── Humidity sensor status (0xB3 0x9A) ───────────────────────────────────
      else if (ch === 0xb3 && ty === 0x9a) {
        const stMap: Record<number, string> = { 0:'collection_failed', 1:'over_range', 2:'under_range' };
        decoded.humidity_sensor_status = stMap[bytes[i] & 0xff] ?? 'unknown'; i += 1;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────────
      // ts(4B) + mask(1B) + humidity_data(2B int16) + temperature_data(2B int16)
      // mask: bits[7:4]=temp_event, bits[3:0]=hum_event
      // Sentinel values in data: -999=not_avail, -1000=magnet_close, -1001=magnet_open, -1002=over_range
      else if (ch === 0x20 && ty === 0xce) {
        const ts      = u32(bytes, i);
        const mask    = bytes[i + 4] & 0xff;
        const humEv   = mask & 0x0f;
        const tempEv  = (mask >>> 4) & 0x0f;
        const humRaw  = i16(bytes, i + 5);
        const tempRaw = i16(bytes, i + 7);
        const entry: Record<string, any> = { timestamp: ts };

        const humVal  = readHistoryValue(humRaw);
        const tempVal = readHistoryValue(tempRaw);

        if (tempVal !== undefined) {
          if (tempVal === 'close' || tempVal === 'open') { entry.magnet = tempVal; entry.event = HIST_EVENT[tempEv] ?? 'unknown'; }
          else { entry.temperature = tempVal; entry.temperature_event = HIST_EVENT[tempEv] ?? 'unknown'; }
        }
        if (humVal !== undefined) {
          if (humVal === 'close' || humVal === 'open') { entry.magnet = humVal; entry.event = HIST_EVENT[humEv] ?? 'unknown'; }
          else { entry.humidity = humVal; entry.humidity_event = HIST_EVENT[humEv] ?? 'unknown'; }
        }
        i += 9;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── FD post-back channels ─────────────────────────────────────────────────
      else if (ch === 0xfd && ty === 0x6b) {
        decoded.retrieval_historical_data_by_time = { timestamp: u32(bytes, i) }; i += 4;
      }
      else if (ch === 0xfd && ty === 0x6c) {
        decoded.retrieval_historical_data_by_time_range = { start_time: u32(bytes, i), end_time: u32(bytes, i + 4) }; i += 8;
      }
      else if (ch === 0xfd && ty === 0x6d) { decoded.stop_historical_data_retrieval = 'yes'; i += 1; }

      // ── Standard downlink responses ───────────────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data); i = result.offset;
      }
      else if (ch === 0xf8 || ch === 0xf9) {
        const result = this.handleDownlinkExt(ch, ty, bytes, i);
        Object.assign(decoded, result.data); i = result.offset;
      }
      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const condMap: Record<number, string> = { 0:'disable',1:'below',2:'above',3:'between',4:'outside',5:'mutation' };

    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x06: {
        // alarm config: bits[2:0]=condition, bits[5:3]=alarm_channel, bit6=enable
        // alarm_channel: 0=temp threshold, 2=temp mutation, 4=hum threshold, 6=hum mutation
        const ctrl   = b[offset] & 0xff;
        const condV  = ctrl & 0x07;
        const alarmCh = (ctrl >>> 3) & 0x07;
        const enBit  = (ctrl >>> 6) & 1;
        if (alarmCh === 0) {
          data.temperature_alarm_config = { enable: enBit === 1 ? 'enable' : 'disable', condition: condMap[condV] ?? 'unknown', threshold_min: i16(b, offset + 1) / 10, threshold_max: i16(b, offset + 3) / 10 };
        } else if (alarmCh === 2) {
          data.temperature_mutation_alarm_config = { enable: enBit === 1 ? 'enable' : 'disable', mutation: u16(b, offset + 3) / 10 };
        } else if (alarmCh === 4) {
          data.humidity_alarm_config = { enable: enBit === 1 ? 'enable' : 'disable', condition: condMap[condV] ?? 'unknown', threshold_min: u16(b, offset + 1) / 10, threshold_max: u16(b, offset + 3) / 10 };
        } else if (alarmCh === 6) {
          data.humidity_mutation_alarm_config = { enable: enBit === 1 ? 'enable' : 'disable', mutation: u16(b, offset + 3) / 10 };
        }
        offset += 9; break;
      }
      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2d: {
        const modeMap: Record<number, string> = { 0:'disable',1:'enable',255:'auto' };
        data.display_mode = modeMap[b[offset] & 0xff] ?? 'unknown'; offset += 1; break;
      }
      case 0x35: data.d2d_key = b.slice(offset, offset + 8).map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join(''); offset += 8; break;
      case 0x4a: data.sync_time = 'yes'; offset += 1; break;
      case 0x68: data.history_enable    = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: data.retransmit_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const sub = b[offset] & 0xff;
        if (sub === 0) data.retransmit_interval = u16(b, offset + 1);
        else           data.resend_interval     = u16(b, offset + 1);
        offset += 3; break;
      }
      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;
      case 0x7e: {
        data.alarm_config = { alarm_interval: u16(b, offset + 1), alarm_counts: u16(b, offset + 3) };
        offset += 5; break;
      }
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break;
      case 0x91: data.magnet_throttle  = u32(b, offset + 1); offset += 5; break;
      case 0x96: {
        const d2dModeMap: Record<number, string> = { 1:'temperature_threshold_alarm',2:'temperature_threshold_alarm_release',3:'temperature_mutation_alarm',4:'humidity_threshold_alarm',5:'humidity_threshold_alarm_release',6:'humidity_mutation_alarm',7:'magnet_close',8:'magnet_open' };
        const mc = { mode: d2dModeMap[b[offset] & 0xff] ?? 'unknown', enable: b[offset + 1] === 1 ? 'enable' : 'disable', lora_uplink_enable: b[offset + 2] === 1 ? 'enable' : 'disable', d2d_cmd: ('0' + (b[offset + 4] & 0xff).toString(16)).slice(-2) + ('0' + (b[offset + 3] & 0xff).toString(16)).slice(-2) };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(mc); offset += 8; break;
      }
      case 0xbd: data.time_zone = tzName(i16(b, offset)); offset += 2; break;
      case 0xe9: data.time_display = b[offset] === 1 ? '24_hour' : '12_hour'; offset += 1; break;
      case 0xea: {
        const ctrl  = b[offset] & 0xff;
        const chIdx = ctrl & 0x07;
        const enBit = (ctrl >>> 7) & 1;
        const cal   = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: i16(b, offset + 1) / 10 };
        if (chIdx === 0) data.temperature_calibration_settings = cal;
        else if (chIdx === 2) data.humidity_calibration_settings = cal;
        offset += 3; break;
      }
      case 0xeb: data.temperature_unit_display = b[offset] === 1 ? 'fahrenheit' : 'celsius'; offset += 1; break;
      case 0xf5: data.alarm_release_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleDownlinkExt(code: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const QUERY_CONFIG_MAP: Record<number, string> = {
      1:'report_interval', 2:'ack_retry_times', 3:'temperature_unit_display',
      4:'button_lock_config', 5:'temperature_alarm_config', 6:'humidity_alarm_config',
      9:'temperature_mutation_alarm_config', 10:'humidity_mutation_alarm_config',
      13:'collection_interval', 14:'alarm_config', 15:'alarm_release_enable',
      16:'d2d_uplink_config', 17:'d2d_enable',
      18:'d2d_master_config_with_temperature_threshold_alarm',
      19:'d2d_master_config_with_temperature_threshold_alarm_release',
      20:'d2d_master_config_with_temperature_mutation_alarm',
      21:'d2d_master_config_with_humidity_threshold_alarm',
      22:'d2d_master_config_with_humidity_threshold_alarm_release',
      23:'d2d_master_config_with_humidity_mutation_alarm',
      24:'d2d_master_config_with_magnet_close_alarm',
      25:'d2d_master_config_with_magnet_open_alarm',
      34:'history_enable', 35:'retransmit_interval', 36:'magnet_delay_time',
      37:'resend_interval', 38:'temperature_calibration_settings',
      39:'humidity_calibration_settings', 42:'dst_config', 43:'time_display',
      44:'magnet_throttle', 45:'display_mode', 46:'retransmit_enable',
    };

    switch (ty) {
      case 0x31: {
        const sMap: Record<number, string> = { 0:'sensor_1', 2:'all' };
        data.fetch_sensor_id = sMap[b[offset] & 0xff] ?? 'unknown'; offset += 1; break;
      }
      case 0x32: data.ack_retry_times = b[offset + 2] & 0xff; offset += 3; break;
      case 0x63: {
        const sensorBits = u16(b, offset + 2);
        data.d2d_uplink_config = {
          d2d_uplink_enable:  b[offset]     === 1 ? 'enable' : 'disable',
          lora_uplink_enable: b[offset + 1] === 1 ? 'enable' : 'disable',
          sensor_data_config: { temperature: ((sensorBits >>> 0) & 1) === 1 ? 'enable' : 'disable', humidity: ((sensorBits >>> 1) & 1) === 1 ? 'enable' : 'disable' },
        };
        offset += 4; break;
      }
      case 0x66: data.d2d_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: {
        const v = b[offset] & 0xff;
        data.button_lock_config = { power_button: ((v >>> 0) & 1) === 1 ? 'enable' : 'disable', report_button: ((v >>> 1) & 1) === 1 ? 'enable' : 'disable' };
        offset += 1; break;
      }
      case 0x6f: {
        const id = b[offset] & 0xff; if (!data.query_config) data.query_config = {};
        const key = QUERY_CONFIG_MAP[id]; if (key) data.query_config[key] = 'yes';
        offset += 1; break;
      }
      case 0x70: data.shutdown = 'yes'; offset += 1; break;
      case 0x72: {
        const ctrl   = b[offset] & 0xff;
        const enBit  = (ctrl >>> 7) & 1;
        const offMin = ctrl & 0x7f;
        const startWeek = b[offset + 2] & 0xff;
        const endWeek   = b[offset + 6] & 0xff;
        data.dst_config = {
          enable:         enBit === 1 ? 'enable' : 'disable',
          offset:         offMin,
          start_month:    b[offset + 1] & 0xff,
          start_week_num: (startWeek >>> 4) & 0x0f,
          start_week_day: startWeek & 0x0f,
          start_time:     u16(b, offset + 3),
          end_month:      b[offset + 5] & 0xff,
          end_week_num:   (endWeek >>> 4) & 0x0f,
          end_week_day:   endWeek & 0x0f,
          end_time:       u16(b, offset + 7),
        };
        offset += 9; break;
      }
      case 0x9a: data.magnet_delay_time = u16(b, offset); offset += 2; break;
      default: offset += 1; break;
    }

    if (code === 0xf8) {
      const rv = b[offset] & 0xff; offset += 1;
      if (rv !== 0) {
        const resultMap: Record<number, string> = { 0:'success',1:'forbidden',2:'invalid parameter' };
        const req = { ...data }; Object.keys(data).forEach(k => delete data[k]);
        data.device_response_result = { channel_type: ty, result: resultMap[rv] ?? 'unknown', request: req };
      }
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];
    const condMap: Record<string, number> = { disable:0, below:1, above:2, between:3, outside:4 };

    switch (type) {
      case 'reboot':                  bytes = [0xff, 0x10, 0xff]; break;
      case 'shutdown':                bytes = [0xf9, 0x70, 0xff]; break;
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      case 'set_report_interval':     bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 10)]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;
      case 'set_time_zone':           bytes = [0xff, 0xbd, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_time_display':        bytes = [0xff, 0xe9, params.time_display === '24_hour' ? 1 : 0]; break;
      case 'set_temperature_unit_display': bytes = [0xff, 0xeb, params.temperature_unit_display === 'fahrenheit' ? 1 : 0]; break;
      case 'set_display_mode': {
        const modeMap: Record<string, number> = { disable:0, enable:1, auto:255 };
        bytes = [0xff, 0x2d, modeMap[params.display_mode ?? 'enable'] ?? 1]; break;
      }
      case 'set_d2d_key':             bytes = [0xff, 0x35, ...hexToBytes(params.d2d_key ?? '0000000000000000')]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_retransmit_enable':   bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_interval': bytes = [0xff, 0x6a, 0x00, ...wu16(params.retransmit_interval ?? 300)]; break;
      case 'set_resend_interval':     bytes = [0xff, 0x6a, 0x01, ...wu16(params.resend_interval ?? 300)]; break;
      case 'set_magnet_throttle':     bytes = [0xff, 0x91, 0x01, ...wu32(params.magnet_throttle ?? 0)]; break;
      case 'set_alarm_release_enable': bytes = [0xff, 0xf5, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_alarm_config':        bytes = [0xff, 0x7e, 0x00, ...wu16(params.alarm_interval ?? 10), ...wu16(params.alarm_counts ?? 1)]; break;

      case 'set_temperature_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xea, ((enBit << 7) | 0) & 0xff, ...wi16(Math.round((params.calibration_value ?? 0) * 10))]; break;
      }
      case 'set_humidity_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xea, ((enBit << 7) | 2) & 0xff, ...wi16(Math.round((params.calibration_value ?? 0) * 10))]; break;
      }

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = { temperature_threshold_alarm:1,temperature_threshold_alarm_release:2,temperature_mutation_alarm:3,humidity_threshold_alarm:4,humidity_threshold_alarm_release:5,humidity_mutation_alarm:6,magnet_close:7,magnet_open:8 };
        const cmd = params.d2d_cmd ?? '0000';
        bytes = [0xff, 0x96, modeMap[params.mode] ?? 1, params.enable === 'enable' ? 1 : 0, params.lora_uplink_enable === 'enable' ? 1 : 0, parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16), 0, 0, 0]; break;
      }

      // Alarm configs — 0xFF 0x06 with alarm_channel in bits[5:3]
      case 'set_temperature_alarm_config': {
        const condVal = condMap[params.condition ?? 'below'] ?? 1;
        const enBit   = params.enable === 'enable' ? 1 : 0;
        const ctrl    = condVal | (0 << 3) | (enBit << 6); // alarm_channel=0
        bytes = [0xff, 0x06, ctrl & 0xff, ...wi16(Math.round((params.threshold_min ?? 0) * 10)), ...wi16(Math.round((params.threshold_max ?? 0) * 10)), 0, 0, 0, 0]; break;
      }
      case 'set_temperature_mutation_alarm_config': {
        const enBit = params.enable === 'enable' ? 1 : 0;
        const ctrl  = 5 | (2 << 3) | (enBit << 6); // condition=5 mutation, alarm_channel=2
        bytes = [0xff, 0x06, ctrl & 0xff, 0, 0, ...wu16(Math.round((params.mutation ?? 0) * 10)), 0, 0, 0, 0]; break;
      }
      case 'set_humidity_alarm_config': {
        const condVal = condMap[params.condition ?? 'below'] ?? 1;
        const enBit   = params.enable === 'enable' ? 1 : 0;
        const ctrl    = condVal | (4 << 3) | (enBit << 6); // alarm_channel=4
        bytes = [0xff, 0x06, ctrl & 0xff, ...wu16(Math.round((params.threshold_min ?? 0) * 10)), ...wu16(Math.round((params.threshold_max ?? 0) * 10)), 0, 0, 0, 0]; break;
      }
      case 'set_humidity_mutation_alarm_config': {
        const enBit = params.enable === 'enable' ? 1 : 0;
        const ctrl  = 5 | (6 << 3) | (enBit << 6); // alarm_channel=6
        bytes = [0xff, 0x06, ctrl & 0xff, 0, 0, ...wu16(Math.round((params.mutation ?? 0) * 10)), 0, 0, 0, 0]; break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0; const end = params.end_time ?? 0;
        bytes = end === 0 ? [0xfd, 0x6b, ...wu32(start)] : [0xfd, 0x6c, ...wu32(start), ...wu32(end)]; break;
      }
      case 'fetch_history_by_time':       bytes = [0xfd, 0x6b, ...wu32(params.timestamp ?? 0)]; break;
      case 'stop_history_retrieval':      bytes = [0xfd, 0x6d, 0xff]; break;

      // 0xF9 commands
      case 'fetch_sensor_id': {
        const sMap: Record<string, number> = { sensor_1: 0, all: 2 };
        bytes = [0xf9, 0x31, sMap[params.fetch_sensor_id ?? 'all'] ?? 2]; break;
      }
      case 'set_ack_retry_times':         bytes = [0xf9, 0x32, 0x00, 0x00, params.ack_retry_times & 0xff]; break;
      case 'set_d2d_uplink_config': {
        let sb = 0;
        if (params.sensor_data_config?.temperature === 'enable') sb |= 1;
        if (params.sensor_data_config?.humidity    === 'enable') sb |= 2;
        bytes = [0xf9, 0x63, params.d2d_uplink_enable === 'enable' ? 1 : 0, params.lora_uplink_enable === 'enable' ? 1 : 0, ...wu16(sb)]; break;
      }
      case 'set_d2d_enable':              bytes = [0xf9, 0x66, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_button_lock_config': {
        let v = 0;
        if (params.power_button  === 'enable') v |= 1;
        if (params.report_button === 'enable') v |= 2;
        bytes = [0xf9, 0x69, v & 0xff]; break;
      }
      case 'set_dst_config': {
        const enBit    = params.enable === 'enable' ? 1 : 0;
        const ctrl     = ((enBit << 7) | (params.offset & 0x7f)) & 0xff;
        const startWeek = ((params.start_week_num & 0x0f) << 4) | (params.start_week_day & 0x0f);
        const endWeek   = ((params.end_week_num   & 0x0f) << 4) | (params.end_week_day   & 0x0f);
        bytes = [0xf9, 0x72, ctrl, params.start_month & 0xff, startWeek & 0xff, ...wu16(params.start_time ?? 0), params.end_month & 0xff, endWeek & 0xff, ...wu16(params.end_time ?? 0)]; break;
      }
      case 'set_magnet_delay_time':       bytes = [0xf9, 0x9a, ...wu16(params.magnet_delay_time ?? 0)]; break;
      case 'query_config': {
        const QMAP: Record<string, number> = { report_interval:1, ack_retry_times:2, temperature_unit_display:3, button_lock_config:4, temperature_alarm_config:5, humidity_alarm_config:6, temperature_mutation_alarm_config:9, humidity_mutation_alarm_config:10, collection_interval:13, alarm_config:14, alarm_release_enable:15, d2d_uplink_config:16, d2d_enable:17, history_enable:34, retransmit_interval:35, magnet_delay_time:36, resend_interval:37, temperature_calibration_settings:38, humidity_calibration_settings:39, dst_config:42, time_display:43, magnet_throttle:44, display_mode:45, retransmit_enable:46 };
        bytes = [];
        for (const [k, id] of Object.entries(QMAP)) { if (params[k] === 'yes') bytes.push(0xf9, 0x6f, id); }
        break;
      }

      default:
        throw new Error(`TS301-v2: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // v2 is uniquely identified by humidity channels (0x03/0x83/0x93/0xB3 0x9A)
  // or sensor type channel 0xFF 0xA0 with PT100/SHT4X/MAGNET types

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ty === 0x9a) return true;               // any 0x9A = humidity/humidity_alarm
      if (ch === 0xff && ty === 0xa0) return true; // sensor ID
    }
    return false;
  }
}