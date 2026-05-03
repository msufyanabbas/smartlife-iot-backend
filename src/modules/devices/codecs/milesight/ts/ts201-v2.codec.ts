// src/modules/devices/codecs/milesight/ts201-v2.codec.ts
// Milesight TS201 v2 — Temperature & Humidity Sensor (DS18B20 / SHT4X probe)
//
// Superset of TS201 v1 — adds:
//   Humidity telemetry (SHT4X probe only):
//     0x04 0x68 — humidity (uint8 /2, %)
//     0x84 0x68 — humidity threshold alarm: humidity(1B) + alarm(1B) → event[]
//     0x94 0x68 — humidity mutation alarm:  humidity(1B) + mutation(1B /2) + alarm(1B) → event[]
//     0xB4 0x68 — humidity sensor status: status(1B) → event[]
//   Additional config commands:
//     0xF9 0x0B 0x03 — humidity threshold alarm config
//     0xF9 0x0C 0x04 — humidity mutation alarm config
//     0xF9 0x63       — d2d_uplink_config
//     0xF9 0x66       — d2d_enable
//     0xF9 0x69       — button_lock_config
//     0xF9 0x6A       — led_indicator_enable
//     0xF9 0x6F       — query_config (per-item ID)
//     0xFF 0x35       — d2d_key
//     0xFF 0x96       — d2d_master_config (mode+enable+lora_uplink+d2d_cmd)
//     0xFF 0xEB       — temperature_unit (0=celsius, 1=fahrenheit)
//   History is 9B (not 7B): ts(4)+sensor_type(1)+temperature(2)+humidity(1)+event(1)
//     event byte: bits[7:6]=temp_sensor_status, bits[5:4]=hum_sensor_status, bits[3:0]=event_type
//
// Scaling:
//   humidity: uint8 /2 = %RH  (e.g. 0x7B=123 → 61.5%)
//   humidity threshold: uint16 ×2 on wire (encoder), /2 on decode
//   humidity mutation: uint16 ×2 on wire, /2 on decode
//
// canDecode fingerprint: prefers 0x04 0x68 or 0x84 0x68 or 0x94 0x68 or 0xFF 0xEB
// (0x93 0x67 still present as in v1 but 0x04 0x68 uniquely identifies v2 vs v1)

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

export class MilesightTS201V2Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ts201-v2';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS201-v2', 'TS201v2'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Temperature & Humidity Sensor';
  readonly modelFamily     = 'TS201';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ts-series/ts201-v2/ts201-v2.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'TS201-v2',
    description:  'Temperature & Humidity Sensor — DS18B20/SHT4X probe with threshold, mutation, and D2D alarms',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'  },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C' },
      { key: 'humidity',    label: 'Humidity',    type: 'number' as const, unit: '%'  },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'report_status', label: 'Report Status', params: [] },
      { type: 'sync_time',     label: 'Sync Time',     params: [] },
      { type: 'clear_history', label: 'Clear History', params: [] },
      { type: 'stop_transmit', label: 'Stop Transmit', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 1440 }],
      },
      {
        type:   'set_temperature_unit',
        label:  'Set Temperature Unit',
        params: [{ key: 'temperature_unit', label: 'Unit', type: 'select' as const, required: true, options: [{ label: 'Celsius', value: 'celsius' }, { label: 'Fahrenheit', value: 'fahrenheit' }] }],
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
          { key: 'enable',        label: 'Enable',         type: 'boolean' as const, required: true  },
          { key: 'condition',     label: 'Condition',      type: 'select'  as const, required: true,  options: [{ label: 'Below', value: 'below' }, { label: 'Above', value: 'above' }, { label: 'Between', value: 'between' }, { label: 'Outside', value: 'outside' }] },
          { key: 'threshold_min', label: 'Min (%)' ,       type: 'number'  as const, required: false, default: 0   },
          { key: 'threshold_max', label: 'Max (%)',         type: 'number'  as const, required: false, default: 100 },
        ],
      },
      {
        type:   'set_temperature_mutation_alarm_config',
        label:  'Set Temperature Mutation Alarm',
        params: [
          { key: 'enable',    label: 'Enable',       type: 'boolean' as const, required: true  },
          { key: 'threshold', label: 'Mutation (°C)', type: 'number'  as const, required: false, default: 5 },
        ],
      },
      {
        type:   'set_humidity_mutation_alarm_config',
        label:  'Set Humidity Mutation Alarm',
        params: [
          { key: 'enable',    label: 'Enable',      type: 'boolean' as const, required: true  },
          { key: 'threshold', label: 'Mutation (%)', type: 'number'  as const, required: false, default: 10 },
        ],
      },
      {
        type:   'set_alarm_release_enable',
        label:  'Set Alarm Release Enable',
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
      { type: 'gauge' as const, label: 'Battery',     keys: ['battery'],     unit: '%'  },
      { type: 'value' as const, label: 'Temperature', keys: ['temperature'], unit: '°C' },
      { type: 'value' as const, label: 'Humidity',    keys: ['humidity'],    unit: '%'  },
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
        const data   = bytes[i] & 0xff;
        const chIdx  = (data >>> 4) & 0x0f;
        const stype  = data & 0x0f;
        const stypeMap: Record<number, string> = { 1:'DS18B20', 2:'SHT4X' };
        decoded[`sensor_${chIdx}_type`] = stypeMap[stype] ?? 'unknown';
        decoded[`sensor_${chIdx}_sn`]   = bytes.slice(i + 1, i + 9).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 9;
      }

      // ── Temperature unit (0xFF 0xEB) ─────────────────────────────────────────
      else if (ch === 0xff && ty === 0xeb) {
        decoded.temperature_unit = bytes[i] === 1 ? 'fahrenheit' : 'celsius'; i += 1;
      }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Temperature (0x03 0x67) ───────────────────────────────────────────────
      else if (ch === 0x03 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10; i += 2;
      }

      // ── Humidity (0x04 0x68) — uint8 /2 ─────────────────────────────────────
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2; i += 1;
      }

      // ── Temperature threshold alarm (0x83 0x67) ──────────────────────────────
      else if (ch === 0x83 && ty === 0x67) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = { temperature: i16(bytes, i) / 10, temperature_alarm: alarmMap[bytes[i + 2] & 0xff] ?? 'unknown' };
        decoded.temperature = entry.temperature;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry); i += 3;
      }

      // ── Humidity threshold alarm (0x84 0x68) — humidity(1B) + alarm(1B) ──────
      else if (ch === 0x84 && ty === 0x68) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = { humidity: (bytes[i] & 0xff) / 2, humidity_alarm: alarmMap[bytes[i + 1] & 0xff] ?? 'unknown' };
        decoded.humidity = entry.humidity;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry); i += 2;
      }

      // ── Temperature mutation alarm (0x93 0x67) ────────────────────────────────
      else if (ch === 0x93 && ty === 0x67) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = {
          temperature:          i16(bytes, i) / 10,
          temperature_mutation: i16(bytes, i + 2) / 10,
          temperature_alarm:    alarmMap[bytes[i + 4] & 0xff] ?? 'unknown',
        };
        decoded.temperature = entry.temperature;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry); i += 5;
      }

      // ── Humidity mutation alarm (0x94 0x68) — humidity(1B) + mutation(1B /2) + alarm(1B) ─
      else if (ch === 0x94 && ty === 0x68) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = {
          humidity:          (bytes[i]     & 0xff) / 2,
          humidity_mutation: (bytes[i + 1] & 0xff) / 2,
          humidity_alarm:    alarmMap[bytes[i + 2] & 0xff] ?? 'unknown',
        };
        decoded.humidity = entry.humidity;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry); i += 3;
      }

      // ── Temperature sensor status (0xB3 0x67) ────────────────────────────────
      else if (ch === 0xb3 && ty === 0x67) {
        const statusMap: Record<number, string> = { 0:'read error',1:'out of range' };
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ temperature_sensor_status: statusMap[bytes[i] & 0xff] ?? 'unknown' }); i += 1;
      }

      // ── Humidity sensor status (0xB4 0x68) ───────────────────────────────────
      else if (ch === 0xb4 && ty === 0x68) {
        const statusMap: Record<number, string> = { 0:'read error',1:'out of range' };
        if (!decoded.event) decoded.event = [];
        decoded.event.push({ humidity_sensor_status: statusMap[bytes[i] & 0xff] ?? 'unknown' }); i += 1;
      }

      // ── History (0x20 0xCE) — 9B ─────────────────────────────────────────────
      // ts(4) + sensor_type(1) + temperature(2) + humidity(1) + event(1)
      // event byte: [7:6]=temp_sensor_status, [5:4]=hum_sensor_status, [3:0]=event_type
      else if (ch === 0x20 && ty === 0xce) {
        const sType    = bytes[i + 4] & 0xff;
        const evByte   = bytes[i + 8] & 0xff;
        const evType   = evByte & 0x0f;
        const humSt    = (evByte >>> 4) & 0x03;
        const tempSt   = (evByte >>> 6) & 0x03;
        const stMap: Record<number, string> = { 0:'normal',1:'read error',2:'out of range' };
        const etMap: Record<number, string> = { 1:'periodic',2:'temperature alarm (threshold or mutation)',3:'temperature alarm release',4:'humidity alarm (threshold or mutation)',5:'humidity alarm release',6:'immediate' };
        const stypeMap: Record<number, string> = { 1:'DS18B20', 2:'SHT4X' };
        const entry: Record<string, any> = {
          timestamp:   u32(bytes, i),
          sensor_type: stypeMap[sType] ?? 'unknown',
          temperature: i16(bytes, i + 5) / 10,
          event: {
            event_type:               etMap[evType]  ?? 'unknown',
            temperature_sensor_status: stMap[tempSt] ?? 'unknown',
            ...(sType === 2 ? { humidity_sensor_status: stMap[humSt] ?? 'unknown' } : {}),
          },
        };
        if (sType === 2) entry.humidity = (bytes[i + 7] & 0xff) / 2;
        i += 9;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

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
    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x35: data.d2d_key       = b.slice(offset, offset + 8).map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join(''); offset += 8; break;
      case 0x4a: data.sync_time     = 'yes'; offset += 1; break;
      case 0x68: data.history_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break;
      case 0x96: {
        const evMap: Record<number, string> = { 1:'temperature threshold alarm',2:'temperature threshold alarm release',3:'temperature mutation alarm',4:'humidity threshold alarm',5:'humidity threshold alarm release',6:'humidity mutation alarm' };
        const mc = {
          mode:               evMap[b[offset] & 0xff] ?? 'unknown',
          enable:             b[offset + 1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: b[offset + 2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            ('0' + (b[offset + 4] & 0xff).toString(16)).slice(-2) + ('0' + (b[offset + 3] & 0xff).toString(16)).slice(-2),
        };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(mc); offset += 8; break;
      }
      case 0xea: {
        const ctrl  = b[offset] & 0xff;
        const type  = ctrl & 0x01;
        const enBit = (ctrl >>> 7) & 1;
        const raw   = i16(b, offset + 1);
        if (type === 0) data.temperature_calibration_settings = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: raw / 10 };
        else            data.humidity_calibration_settings    = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: raw / 2 };
        offset += 3; break;
      }
      case 0xeb: data.temperature_unit   = b[offset] === 1 ? 'fahrenheit' : 'celsius'; offset += 1; break;
      case 0xf2: data.alarm_report_counts = u16(b, offset); offset += 2; break;
      case 0xf5: data.alarm_release_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleDownlinkExt(code: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const condMap: Record<number, string> = { 0:'disable',1:'below',2:'above',3:'between',4:'outside' };
    const QUERY_CONFIG_MAP: Record<number, string> = {
      1:'temperature_unit', 2:'button_lock_config', 3:'d2d_uplink_config',
      4:'d2d_enable', 5:'d2d_master_config_with_temperature_threshold_alarm',
      6:'d2d_master_config_with_temperature_threshold_alarm_release',
      7:'d2d_master_config_with_temperature_mutation_alarm',
      8:'d2d_master_config_with_humidity_threshold_alarm',
      9:'d2d_master_config_with_humidity_threshold_alarm_release',
      10:'d2d_master_config_with_humidity_mutation_alarm',
      11:'temperature_calibration_settings', 12:'humidity_calibration_settings',
      13:'temperature_alarm_config', 14:'temperature_mutation_alarm_config',
      15:'humidity_alarm_config', 16:'humidity_mutation_alarm_config',
      17:'led_indicator_enable', 18:'collection_interval', 19:'report_interval',
      20:'alarm_release_enable', 21:'alarm_report_counts', 22:'retransmit_config',
      23:'history_enable', 24:'history_resend_config', 25:'ack_retry_times',
    };

    switch (ty) {
      case 0x0b: {
        const dtype = b[offset] & 0xff;
        if (dtype === 0x01) {
          data.temperature_alarm_config = { condition: condMap[b[offset + 1] & 0xff] ?? 'unknown', threshold_max: i16(b, offset + 2) / 10, threshold_min: i16(b, offset + 4) / 10, enable: b[offset + 6] === 1 ? 'enable' : 'disable' };
        } else if (dtype === 0x03) {
          data.humidity_alarm_config = { condition: condMap[b[offset + 1] & 0xff] ?? 'unknown', threshold_max: u16(b, offset + 2) / 2, threshold_min: u16(b, offset + 4) / 2, enable: b[offset + 6] === 1 ? 'enable' : 'disable' };
        }
        offset += 7; break;
      }
      case 0x0c: {
        const dtype = b[offset] & 0xff;
        if (dtype === 0x02) {
          data.temperature_mutation_alarm_config = { mutation: u16(b, offset + 1) / 10, enable: b[offset + 3] === 1 ? 'enable' : 'disable' };
        } else if (dtype === 0x04) {
          data.humidity_mutation_alarm_config = { mutation: u16(b, offset + 1) / 2, enable: b[offset + 3] === 1 ? 'enable' : 'disable' };
        }
        offset += 4; break;
      }
      case 0x0d: data.retransmit_config = { enable: b[offset] === 1 ? 'enable' : 'disable', interval: u16(b, offset + 1) }; offset += 3; break;
      case 0x0e: data.resend_interval   = u16(b, offset); offset += 2; break;
      case 0x31: data.fetch_sensor_id   = b[offset] & 0xff; offset += 1; break;
      case 0x32: data.ack_retry_times   = b[offset + 2] & 0xff; offset += 3; break;
      case 0x63: {
        const sensorBits = u16(b, offset + 2);
        data.d2d_uplink_config = {
          d2d_uplink_enable:  b[offset]     === 1 ? 'enable' : 'disable',
          lora_uplink_enable: b[offset + 1] === 1 ? 'enable' : 'disable',
          sensor_data_config: {
            temperature: ((sensorBits >>> 0) & 1) === 1 ? 'enable' : 'disable',
            humidity:    ((sensorBits >>> 1) & 1) === 1 ? 'enable' : 'disable',
          },
        };
        offset += 4; break;
      }
      case 0x66: data.d2d_enable         = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: {
        const v = b[offset] & 0xff;
        data.button_lock_config = { power_button: ((v >>> 0) & 1) === 1 ? 'enable' : 'disable', report_button: ((v >>> 1) & 1) === 1 ? 'enable' : 'disable' };
        offset += 1; break;
      }
      case 0x6a: data.led_indicator_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6f: {
        const id = b[offset] & 0xff;
        if (!data.query_config) data.query_config = {};
        const key = QUERY_CONFIG_MAP[id];
        if (key) data.query_config[key] = 'yes';
        offset += 1; break;
      }
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
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      case 'set_report_interval':     bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 10)]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_alarm_release_enable': bytes = [0xff, 0xf5, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_alarm_report_counts': bytes = [0xff, 0xf2, ...wu16(params.alarm_report_counts ?? 1)]; break;
      case 'set_d2d_key':             bytes = [0xff, 0x35, ...hexToBytes(params.d2d_key ?? '0000000000000000')]; break;
      case 'set_temperature_unit':    bytes = [0xff, 0xeb, params.temperature_unit === 'fahrenheit' ? 1 : 0]; break;

      case 'set_temperature_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xea, (enBit << 7) & 0xff, ...wi16(Math.round((params.calibration_value ?? 0) * 10))]; break;
      }
      case 'set_humidity_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xea, ((enBit << 7) | 1) & 0xff, ...wi16(Math.round((params.calibration_value ?? 0) * 2))]; break;
      }
      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = { 'temperature threshold alarm':1,'temperature threshold alarm release':2,'temperature mutation alarm':3,'humidity threshold alarm':4,'humidity threshold alarm release':5,'humidity mutation alarm':6 };
        const cmd = params.d2d_cmd ?? '0000';
        bytes = [0xff, 0x96, modeMap[params.mode] ?? 1, params.enable === 'enable' ? 1 : 0, params.lora_uplink_enable === 'enable' ? 1 : 0,
          parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16), 0, 0, 0]; break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0; const end = params.end_time ?? 0;
        bytes = end === 0 ? [0xfd, 0x6b, ...wu32(start)] : [0xfd, 0x6c, ...wu32(start), ...wu32(end)]; break;
      }

      // 0xF9 commands
      case 'set_temperature_alarm_config': {
        const maxRaw = Math.round((params.threshold_max ?? 0) * 10);
        const minRaw = Math.round((params.threshold_min ?? 0) * 10);
        bytes = [0xf9, 0x0b, 0x01, condMap[params.condition ?? 'below'] ?? 1, ...wu16(maxRaw), ...wu16(minRaw), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_humidity_alarm_config': {
        const maxRaw = Math.round((params.threshold_max ?? 0) * 2);
        const minRaw = Math.round((params.threshold_min ?? 0) * 2);
        bytes = [0xf9, 0x0b, 0x03, condMap[params.condition ?? 'below'] ?? 1, ...wu16(maxRaw), ...wu16(minRaw), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_temperature_mutation_alarm_config': {
        bytes = [0xf9, 0x0c, 0x02, ...wu16(Math.round((params.threshold ?? 0) * 10)), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_humidity_mutation_alarm_config': {
        bytes = [0xf9, 0x0c, 0x04, ...wu16(Math.round((params.threshold ?? 0) * 2)), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_retransmit_config': bytes = [0xf9, 0x0d, params.enable === 'enable' ? 1 : 0, ...wu16(params.interval ?? 60)]; break;
      case 'set_resend_interval':   bytes = [0xf9, 0x0e, ...wu16(params.resend_interval ?? 60)]; break;
      case 'fetch_sensor_id':       bytes = [0xf9, 0x31, params.fetch_sensor_id ?? 0]; break;
      case 'set_ack_retry_times':   bytes = [0xf9, 0x32, 0x00, 0x00, params.ack_retry_times & 0xff]; break;
      case 'set_d2d_enable':        bytes = [0xf9, 0x66, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_d2d_uplink_config': {
        let sensorBits = 0;
        if (params.sensor_data_config?.temperature === 'enable') sensorBits |= 1;
        if (params.sensor_data_config?.humidity    === 'enable') sensorBits |= 2;
        bytes = [0xf9, 0x63, params.d2d_uplink_enable === 'enable' ? 1 : 0, params.lora_uplink_enable === 'enable' ? 1 : 0, ...wu16(sensorBits)]; break;
      }
      case 'set_button_lock_config': {
        let v = 0;
        if (params.power_button  === 'enable') v |= 1;
        if (params.report_button === 'enable') v |= 2;
        bytes = [0xf9, 0x69, v & 0xff]; break;
      }
      case 'set_led_indicator_enable': bytes = [0xf9, 0x6a, params.enable === 'enable' ? 1 : 0]; break;
      case 'query_config': {
        const QUERY_CONFIG_MAP: Record<string, number> = {
          temperature_unit:1, button_lock_config:2, d2d_uplink_config:3,
          d2d_enable:4, d2d_master_config_with_temperature_threshold_alarm:5,
          d2d_master_config_with_temperature_threshold_alarm_release:6,
          d2d_master_config_with_temperature_mutation_alarm:7,
          d2d_master_config_with_humidity_threshold_alarm:8,
          d2d_master_config_with_humidity_threshold_alarm_release:9,
          d2d_master_config_with_humidity_mutation_alarm:10,
          temperature_calibration_settings:11, humidity_calibration_settings:12,
          temperature_alarm_config:13, temperature_mutation_alarm_config:14,
          humidity_alarm_config:15, humidity_mutation_alarm_config:16,
          led_indicator_enable:17, collection_interval:18, report_interval:19,
          alarm_release_enable:20, alarm_report_counts:21, retransmit_config:22,
          history_enable:23, history_resend_config:24, ack_retry_times:25,
        };
        bytes = [];
        for (const [k, id] of Object.entries(QUERY_CONFIG_MAP)) {
          if (params[k] === 'yes') bytes.push(0xf9, 0x6f, id);
        }
        break;
      }

      default:
        throw new Error(`TS201-v2: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // v2 is uniquely identified by humidity channels or temperature_unit channel;
  // prefers those over the shared 0x03/0x83/0x93 0x67 channels.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x04 && ty === 0x68) return true; // humidity
      if (ch === 0x84 && ty === 0x68) return true; // humidity alarm
      if (ch === 0x94 && ty === 0x68) return true; // humidity mutation alarm
      if (ch === 0xb4 && ty === 0x68) return true; // humidity sensor status
      if (ch === 0xff && ty === 0xeb) return true; // temperature_unit
    }
    return false;
  }
}