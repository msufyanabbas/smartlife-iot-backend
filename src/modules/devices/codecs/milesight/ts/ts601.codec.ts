// src/modules/devices/codecs/milesight/ts601.codec.ts
// Milesight TS601 — Cellular Temperature / Humidity / Tilt / Light Sensor
//
// Protocol: Single-byte command ID + variable-length data (NOT IPSO channel_id+type)
//
// Core telemetry channels:
//   0x01      — battery (1B uint8 %)
//   0x03      — sensor_id: type(1B) + id(8B hex)
//   0x04      — temperature (4B int32 LE /100, °C)
//   0x05      — humidity (2B uint16 LE /10, %RH)
//   0x06      — base_station_position: lat(4B int32/1e6) + lon(4B int32/1e6)
//   0x07      — airplane_mode_state (1B)
//   0x0C      — probe_connect_status (1B: 0=disconnect, 1=connect)
//   0x0D      — relative_surface_info: angle_x/y/z (3×2B int16/100)
//   0x0E      — report_package_type (1B)
//
// Alarm/event channels:
//   0x1A      — temperature_alarm_types (1B summary enum)
//   0x1B      — humidity_alarm_types (1B summary enum)
//   0x1C      — tilt_alarm_types (1B summary enum)
//   0x1D      — light_alarm_types (1B summary enum)
//   0x11      — battery_alarm: sub_type(1B) [0x10 → lower_battery_alarm.battery(1B)]
//   0x08      — temperature_alarm: type(1B) [+ 4B int32/100 for types ≥ 0x10]
//               type 0x20 (mutation): temperature(4B) + saltation(4B)
//   0x09      — humidity_alarm: type(1B) [+ 2B uint16/10 for types ≥ 0x10]
//               type 0x20 (mutation): humidity(2B) + saltation(2B)
//   0x0A      — tilt_alarm: type(1B)
//   0x0B      — light_alarm: type(1B)
//
// History:
//   0xED      — history frame: mode(1B, skip) + timestamp(4B uint32)
//               subsequent channels fill the record until next 0xED
//
// Metadata:
//   0xDA      — version: hardware(2B) + firmware(6B)
//   0xDB      — product_sn (8B hex)
//   0xDE      — product_name (32B string)
//   0xDD      — product_pn  (32B string)
//   0xDF      — tsl_version (2B)
//   0xD7      — device_info (9×8B strings)
//   0xD8      — product_frequency_band (16B string)
//   0xD9      — oem_id (2B hex)
//   0xC8      — device_status (1B: 0=off, 1=on)
//   0xC9      — random_key (1B)
//   0xBE      — cellular_status: sub(1B) + payload (variable)
//   0xEC      — ipso_device_upgrade_result.value (1B)
//
// Configuration channels (encode only, also decoded in responses):
//   0x60      — reporting_interval: unit(1B) + time(2B uint16)
//   0x61      — cumulative_times (1B)
//   0x62      — collection_interval: unit(1B) + time(2B uint16)
//   0x63      — alarm_reporting_times (2B uint16)
//   0x64      — light_collection_interval: unit(1B) + time(2B uint16)
//   0x65      — temperature_unit (1B)
//   0x71      — base_station_position_enable (1B)
//   0x73      — airplane_mode_time_period: sub(1B) + payload
//   0x75      — alarm_deactivation_enable (1B)
//   0x76      — button_lock: enable(1B) + bitfield(1B)
//   0x77      — temperature_alarm_settings: enable(1B) + cond(1B) + min(4B int32/100) + max(4B int32/100)
//   0x78      — temperature_mutation_alarm_settings: enable(1B) + mutation_max(4B int32/100)
//   0x79      — humidity_alarm_settings: enable(1B) + cond(1B) + min(2B uint16/10) + max(2B uint16/10)
//   0x7A      — humidity_mutation_alarm_settings: enable(1B) + mutation_max(2B uint16/10)
//   0x7B      — temperature_calibration_settings: enable(1B) + value(4B int32/100)
//   0x7C      — humidity_calibration_settings: enable(1B) + value(2B int16/10)
//   0x7D      — light_alarm_settings: enable(1B) + cond(1B) + max(2B uint16)
//   0x7E      — light_tolerance_value (1B)
//   0x7F      — tilt_alarm_settings: enable(1B) + cond(1B) + max(1B) + duration(1B)
//   0x80      — falling_alarm_settings: enable(1B)
//   0x81      — falling_threshold_alarm_settings: threshold_level(1B) + time_level(1B)
//   0x82      — probe_id_retransmit_count (1B)
//   0xC4      — auto_p_enable (1B)
//   0xC5      — data_storage_settings: sub(1B) + payload
//   0xC6      — daylight_saving_time: enable(1B) + offset(1B) + ...9B total
//   0xC7      — time_zone (2B int16 LE, minutes)
//   0xB7      — set_time: timestamp(4B uint32)
//   0xBA      — retrieve_historical_data_by_time: time(4B uint32)
//   0xBB      — retrieve_historical_data_by_time_range: start(4B) + end(4B)
//
// Service commands (no payload except the command byte):
//   0xBF      — reset
//   0xBE      — reboot (when sent as downlink; as uplink it's cellular_status)
//   0xBD      — clear_historical_data
//   0xBC      — stop_historical_data_retrieval
//   0xB9      — query_device_status
//   0xB8      — synchronize_time
//   0x50      — clear_alarm_item
//   0x53      — get_sensor_id
//   0xEE      — request_query_all_configurations
//
// canDecode fingerprint: TS601 is uniquely identified by:
//   0x0D — relative_surface_info (tilt angles) — unique to TS601
//   0x0C — probe_connect_status
//   0x0E — report_package_type
//   0x82 — probe_id_retransmit_count
//   Absence of IPSO marker (0xFF 0x01) combined with 0x04 temperature as int32

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u8(b: number[], i: number): number { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function i32(b: number[], i: number): number { const v = u32(b, i); return v > 0x7fffffff ? v - 0x100000000 : v; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function wi32(v: number): number[] { const u = v < 0 ? v + 0x100000000 : v; return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff]; }
function hexstr(b: number[], offset: number, len: number): string {
  return b.slice(offset, offset + len).map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join('');
}
function readstr(b: number[], offset: number, len: number): string {
  const bytes = b.slice(offset, offset + len);
  let s = '';
  for (let k = 0; k < bytes.length; k++) {
    const c = bytes[k];
    if (c === 0) break;
    if (c < 0x80) { s += String.fromCharCode(c); }
    else if (c < 0xe0 && k + 1 < bytes.length) { s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[++k] & 0x3f)); }
    else if (k + 2 < bytes.length) { s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[++k] & 0x3f) << 6) | (bytes[++k] & 0x3f)); }
  }
  return s;
}

// ── Temperature alarm type map ────────────────────────────────────────────────
const TEMP_ALARM_TYPE: Record<number, string> = {
  0x00:'collection_error', 0x01:'lower_range_error', 0x02:'over_range_error', 0x03:'no_data',
  0x10:'lower_range_alarm_deactivation', 0x11:'lower_range_alarm_trigger',
  0x12:'over_range_alarm_deactivation',  0x13:'over_range_alarm_trigger',
  0x14:'within_range_alarm_deactivation',0x15:'within_range_alarm_trigger',
  0x16:'exceed_range_alarm_deactivation',0x17:'exceed_range_alarm_trigger',
  0x20:'mutation_alarm_trigger',         0x30:'mutation_alarm_trigger_no_mutation',
};
// Types that carry a 4B temperature value
const TEMP_ALARM_HAS_VALUE = new Set([0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x20,0x30]);
// Type 0x20 carries an additional 4B saltation value

// ── Humidity alarm type map ───────────────────────────────────────────────────
const HUM_ALARM_TYPE: Record<number, string> = {
  0x00:'collection_error', 0x01:'lower_range_error', 0x02:'over_range_error', 0x03:'no_data',
  0x10:'lower_range_alarm_deactivation', 0x11:'lower_range_alarm_trigger',
  0x12:'over_range_alarm_deactivation',  0x13:'over_range_alarm_trigger',
  0x14:'within_range_alarm_deactivation',0x15:'within_range_alarm_trigger',
  0x16:'exceed_range_alarm_deactivation',0x17:'exceed_range_alarm_trigger',
  0x20:'mutation_alarm_trigger',         0x30:'mutation_alarm_trigger_no_mutation',
};
const HUM_ALARM_HAS_VALUE = new Set([0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x20,0x30]);

export class MilesightTS601Codec extends BaseDeviceCodec {
  readonly codecId: string        = 'milesight-ts601';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS601'];
  readonly protocol        = 'cellular' as const;
  readonly category        = 'Temperature & Humidity Sensor';
  readonly modelFamily: string    = 'TS601';
  readonly imageUrl: string        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ts-series/ts601/ts601.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'TS601',
    description:  'Cellular Temperature & Humidity Sensor — probe with tilt detection and light sensing',
    telemetryKeys: [
      { key: 'battery',               label: 'Battery',           type: 'number' as const, unit: '%'  },
      { key: 'temperature',           label: 'Temperature',       type: 'number' as const, unit: '°C' },
      { key: 'humidity',              label: 'Humidity',          type: 'number' as const, unit: '%'  },
      { key: 'relative_surface_info', label: 'Tilt Angles',       type: 'string' as const              },
      { key: 'probe_connect_status',  label: 'Probe Status',      type: 'string' as const, enum: ['connect', 'disconnect'] },
    ],
    commands: [
      { type: 'reboot',                         label: 'Reboot Device',         params: [] },
      { type: 'reset',                          label: 'Reset Device',          params: [] },
      { type: 'query_device_status',            label: 'Query Device Status',   params: [] },
      { type: 'synchronize_time',               label: 'Synchronize Time',      params: [] },
      { type: 'clear_historical_data',          label: 'Clear Historical Data', params: [] },
      { type: 'stop_historical_data_retrieval', label: 'Stop History Retrieval', params: [] },
      {
        type:   'set_reporting_interval',
        label:  'Set Reporting Interval',
        params: [
          { key: 'unit',            label: 'Unit',  type: 'select' as const, required: true, options: [{ label: 'Seconds', value: 'second' }, { label: 'Minutes', value: 'min' }] },
          { key: 'minutes_of_time', label: 'Value', type: 'number' as const, required: false, default: 30 },
        ],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [
          { key: 'unit',            label: 'Unit',  type: 'select' as const, required: true, options: [{ label: 'Seconds', value: 'second' }, { label: 'Minutes', value: 'min' }] },
          { key: 'minutes_of_time', label: 'Value', type: 'number' as const, required: false, default: 15 },
        ],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Offset (minutes)', type: 'number' as const, required: true, default: 480 }],
      },
      {
        type:   'set_temperature_alarm_settings',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'enable',              label: 'Enable',      type: 'boolean' as const, required: true  },
          { key: 'threshold_condition', label: 'Condition',   type: 'string'  as const, required: false },
          { key: 'threshold_min',       label: 'Min (°C)',    type: 'number'  as const, required: false, default: 0  },
          { key: 'threshold_max',       label: 'Max (°C)',    type: 'number'  as const, required: false, default: 60 },
        ],
      },
      {
        type:   'set_humidity_alarm_settings',
        label:  'Set Humidity Alarm',
        params: [
          { key: 'enable',              label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'threshold_condition', label: 'Condition', type: 'string'  as const, required: false },
          { key: 'threshold_min',       label: 'Min (%)',   type: 'number'  as const, required: false, default: 0   },
          { key: 'threshold_max',       label: 'Max (%)',   type: 'number'  as const, required: false, default: 100 },
        ],
      },
      {
        type:   'set_tilt_alarm_settings',
        label:  'Set Tilt Alarm',
        params: [
          { key: 'enable',              label: 'Enable',        type: 'boolean' as const, required: true  },
          { key: 'threshold_condition', label: 'Condition',     type: 'number'  as const, required: false, default: 0  },
          { key: 'threshold_max',       label: 'Max Angle (°)', type: 'number'  as const, required: false, default: 20 },
          { key: 'duration',            label: 'Duration',      type: 'number'  as const, required: false, default: 10 },
        ],
      },
      {
        type:   'retrieve_historical_data_by_time',
        label:  'Fetch History by Time',
        params: [{ key: 'time', label: 'Unix Timestamp', type: 'number' as const, required: true }],
      },
      {
        type:   'retrieve_historical_data_by_time_range',
        label:  'Fetch History by Range',
        params: [
          { key: 'start_time', label: 'Start (Unix)', type: 'number' as const, required: true },
          { key: 'end_time',   label: 'End (Unix)',   type: 'number' as const, required: true },
        ],
      },
    ],
    uiComponents: [
      { type: 'gauge' as const, label: 'Battery',      keys: ['battery'],              unit: '%'  },
      { type: 'value' as const, label: 'Temperature',  keys: ['temperature'],          unit: '°C' },
      { type: 'value' as const, label: 'Humidity',     keys: ['humidity'],             unit: '%'  },
      { type: 'value' as const, label: 'Probe Status', keys: ['probe_connect_status']             },
      { type: 'value' as const, label: 'Tilt Angles',  keys: ['relative_surface_info']            },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const result: any = {};
    const history: any[] = [];
    let current: any = result; // pointer — switches to history entries at 0xED
    let i = 0;

    while (i < bytes.length) {
      const cmd = bytes[i++];
      switch (cmd) {

        // ── Metadata ───────────────────────────────────────────────────────────
        case 0xfe: {
          result.check_order_reply = { order: u8(bytes, i) }; i += 1; break;
        }
        case 0xef: {
          if (!result.ans) result.ans = [];
          const bitOpts = u8(bytes, i++);
          const ans: any = { result: (bitOpts >>> 4) & 0x0f, length: bitOpts & 0x0f };
          const cmdBytes = bytes.slice(i, i + ans.length);
          ans.id = cmdBytes.map((b: number) => ('0' + b.toString(16)).slice(-2)).join('');
          i += ans.length;
          result.ans.push(ans); break;
        }
        case 0xee: { result.all_configurations_request_by_device = 1; break; }
        case 0xdf: {
          const major = u8(bytes, i); const minor = u8(bytes, i + 1);
          current.tsl_version = `v${major}.${minor}`; i += 2; break;
        }
        case 0xde: { current.product_name = readstr(bytes, i, 32); i += 32; break; }
        case 0xdd: { current.product_pn   = readstr(bytes, i, 32); i += 32; break; }
        case 0xdb: { current.product_sn   = hexstr(bytes, i, 8);   i += 8;  break; }
        case 0xda: {
          const hw = `v${u8(bytes,i)}.${u8(bytes,i+1)}`;
          const fw = `v${u8(bytes,i+2)}.${u8(bytes,i+3)}` + (u8(bytes,i+4) ? `-r${u8(bytes,i+4)}` : '') + (u8(bytes,i+5) ? `-a${u8(bytes,i+5)}` : '') + (u8(bytes,i+6) ? `-u${u8(bytes,i+6)}` : '') + (u8(bytes,i+7) ? `-t${u8(bytes,i+7)}` : '');
          current.version = { hardware_version: hw, firmware_version: fw }; i += 8; break;
        }
        case 0xd9: { current.oem_id = hexstr(bytes, i, 2); i += 2; break; }
        case 0xc9: { current.random_key   = u8(bytes, i++); break; }
        case 0xc8: { current.device_status = u8(bytes, i++) === 1 ? 'on' : 'off'; break; }
        case 0xd8: { current.product_frequency_band = readstr(bytes, i, 16); i += 16; break; }
        case 0xd7: {
          current.device_info = {
            model:     readstr(bytes, i,      8),
            submodel_1:readstr(bytes, i+8,    8),
            submodel_2:readstr(bytes, i+16,   8),
            submodel_3:readstr(bytes, i+24,   8),
            submodel_4:readstr(bytes, i+32,   8),
            pn_1:      readstr(bytes, i+40,   8),
            pn_2:      readstr(bytes, i+48,   8),
            pn_3:      readstr(bytes, i+56,   8),
            pn_4:      readstr(bytes, i+64,   8),
          }; i += 72; break;
        }
        case 0xec: {
          const upgradeMap: Record<number,string> = { 0:'Upgrade Successfully',1:'URL Error',2:'Download Failed',3:'Packet Too Big',4:'Version Error',5:'Device Error',6:'Patch Format Error',7:'CRC Check Failed',8:'Product Error',9:'Patch Upgrade Failed',255:'Upgrade Pending' };
          current.ipso_device_upgrade_result = { value: upgradeMap[u8(bytes, i)] ?? 'unknown' };
          i += 1; break;
        }
        case 0xeb: {
          const len = u16(bytes, i); i += 2;
          current.debugging_commands = { length: len, content: readstr(bytes, i, len) }; i += len; break;
        }

        // ── History frame boundary ─────────────────────────────────────────────
        case 0xed: {
          i += 1; // skip mode byte
          const ts = u32(bytes, i); i += 4;
          const entry: any = { timestamp: ts };
          history.push(entry);
          current = entry; break;
        }

        // ── Telemetry ──────────────────────────────────────────────────────────
        case 0x01: { current.battery = u8(bytes, i++); if (current === result) result.batteryLevel = result.battery; break; }
        case 0x03: {
          const stypeMap: Record<number,string> = { 0:'none',1:'PT100',2:'SHT41',3:'DS18B20' };
          current.sensor_id = { type: stypeMap[u8(bytes,i)] ?? 'unknown', id: hexstr(bytes, i+1, 8) }; i += 9; break;
        }
        case 0x04: { current.temperature = i32(bytes, i) / 100; i += 4; break; }
        case 0x05: { current.humidity = u16(bytes, i) / 10; i += 2; break; }
        case 0x06: {
          current.base_station_position = { latitude: i32(bytes, i) / 1000000, longitude: i32(bytes, i+4) / 1000000 };
          i += 8; break;
        }
        case 0x07: { current.airplane_mode_state = u8(bytes,i++) === 0 ? 'enter airplane mode' : 'exit airplane mode'; break; }
        case 0x0c: { current.probe_connect_status = u8(bytes,i++) === 1 ? 'connect' : 'disconnect'; break; }
        case 0x0d: {
          current.relative_surface_info = { angle_x: i16(bytes,i)/100, angle_y: i16(bytes,i+2)/100, angle_z: i16(bytes,i+4)/100 };
          i += 6; break;
        }
        case 0x0e: { current.report_package_type = u8(bytes,i++) === 0 ? 'Normal cycle package' : 'Key cycle package'; break; }

        // ── Alarm type summaries ───────────────────────────────────────────────
        case 0x1a: { current.temperature_alarm_types = u8(bytes, i++); break; }
        case 0x1b: { current.humidity_alarm_types    = u8(bytes, i++); break; }
        case 0x1c: { current.tilt_alarm_types        = u8(bytes, i++); break; }
        case 0x1d: { current.light_alarm_types       = u8(bytes, i++); break; }

        // ── Battery alarm ──────────────────────────────────────────────────────
        case 0x11: {
          const subType = u8(bytes, i++);
          if (subType === 0x10) {
            current.battery_alarm = { lower_battery_alarm: { battery: u8(bytes, i++) } };
          } break;
        }

        // ── Temperature alarm ──────────────────────────────────────────────────
        case 0x08: {
          const atype = u8(bytes, i++);
          const aname = TEMP_ALARM_TYPE[atype] ?? 'unknown';
          if (!current.temperature_alarm) current.temperature_alarm = {};
          current.temperature_alarm.type = atype;
          current.temperature_alarm_types = atype;
          if (TEMP_ALARM_HAS_VALUE.has(atype)) {
            const tempVal = i32(bytes, i) / 100; i += 4;
            current.temperature_alarm[aname] = { temperature: tempVal };
            current.temperature = tempVal;
            if (atype === 0x20) {
              const saltation = i32(bytes, i) / 100; i += 4;
              current.temperature_alarm[aname].saltation = saltation;
            }
          } else {
            current.temperature_alarm[aname] = {};
          } break;
        }

        // ── Humidity alarm ─────────────────────────────────────────────────────
        case 0x09: {
          const atype = u8(bytes, i++);
          const aname = HUM_ALARM_TYPE[atype] ?? 'unknown';
          if (!current.humidity_alarm) current.humidity_alarm = {};
          current.humidity_alarm.type = atype;
          current.humidity_alarm_types = atype;
          if (HUM_ALARM_HAS_VALUE.has(atype)) {
            const humVal = u16(bytes, i) / 10; i += 2;
            current.humidity_alarm[aname] = { humidity: humVal };
            current.humidity = humVal;
            if (atype === 0x20) {
              const saltation = u16(bytes, i) / 10; i += 2;
              current.humidity_alarm[aname].saltation = saltation;
            }
          } else {
            current.humidity_alarm[aname] = {};
          } break;
        }

        // ── Tilt alarm ─────────────────────────────────────────────────────────
        case 0x0a: {
          const atype = u8(bytes, i++);
          const tiltMap: Record<number,string> = { 0x00:'collection_error',0x01:'lower_range_error',0x02:'over_range_error',0x03:'no_data',0x10:'threshold_alarm_deactivation',0x11:'threshold_alarm_trigger',0x21:'falling_alarm_trigger' };
          if (!current.tilt_alarm) current.tilt_alarm = {};
          current.tilt_alarm.type = atype;
          current.tilt_alarm_types = atype;
          current.tilt_alarm[tiltMap[atype] ?? 'unknown'] = {}; break;
        }

        // ── Light alarm ────────────────────────────────────────────────────────
        case 0x0b: {
          const atype = u8(bytes, i++);
          const lightMap: Record<number,string> = { 0x00:'collection_error',0x01:'lower_range_error',0x02:'over_range_error',0x03:'no_data',0x10:'threshold_alarm_deactivation',0x11:'threshold_alarm_trigger' };
          if (!current.light_alarm) current.light_alarm = {};
          current.light_alarm.type = atype;
          current.light_alarm_types = atype;
          current.light_alarm[lightMap[atype] ?? 'unknown'] = {}; break;
        }

        // ── Configuration responses ────────────────────────────────────────────
        case 0x60: {
          const unit = u8(bytes, i++);
          const val  = u16(bytes, i); i += 2;
          current.reporting_interval = unit === 0 ? { unit: 'second', seconds_of_time: val } : { unit: 'min', minutes_of_time: val }; break;
        }
        case 0x61: { current.cumulative_times = u8(bytes, i++); break; }
        case 0x62: {
          const unit = u8(bytes, i++);
          const val  = u16(bytes, i); i += 2;
          current.collection_interval = unit === 0 ? { unit: 'second', seconds_of_time: val } : { unit: 'min', minutes_of_time: val }; break;
        }
        case 0x63: { current.alarm_reporting_times = u16(bytes, i); i += 2; break; }
        case 0x64: {
          const unit = u8(bytes, i++);
          const val  = u16(bytes, i); i += 2;
          current.light_collection_interval = unit === 0 ? { unit: 'second', seconds_of_time: val } : { unit: 'min', minutes_of_time: val }; break;
        }
        case 0x65: { current.temperature_unit = u8(bytes, i++) === 0 ? '℃' : '℉'; break; }
        case 0x71: { current.base_station_position_enable = u8(bytes, i++) === 1 ? 'enable' : 'disable'; break; }
        case 0x72: { current.base_station_position_auth_token = readstr(bytes, i, 16); i += 16; break; }
        case 0x73: {
          const sub = u8(bytes, i++);
          if (!current.airplane_mode_time_period_settings) current.airplane_mode_time_period_settings = {};
          if (sub === 0x00) { current.airplane_mode_time_period_settings.enable = u8(bytes, i++) === 1 ? 'enable' : 'disable'; }
          else if (sub === 0x01) {
            current.airplane_mode_time_period_settings.start_timestamp = { year:u8(bytes,i),month:u8(bytes,i+1),day:u8(bytes,i+2),hour:u8(bytes,i+3),minute:u8(bytes,i+4),second:u8(bytes,i+5) }; i += 6;
          } else if (sub === 0x02) {
            current.airplane_mode_time_period_settings.end_timestamp = { year:u8(bytes,i),month:u8(bytes,i+1),day:u8(bytes,i+2),hour:u8(bytes,i+3),minute:u8(bytes,i+4),second:u8(bytes,i+5) }; i += 6;
          } break;
        }
        case 0x75: { current.alarm_deactivation_enable = u8(bytes, i++) === 1 ? 'enable' : 'disable'; break; }
        case 0x76: {
          const en = u8(bytes, i++); const bits = u8(bytes, i++);
          current.button_lock = { enable: en === 1 ? 'enable' : 'disable', power_off_enable: (bits >>> 0) & 1, collect_report_enable: (bits >>> 1) & 1, reserve: (bits >>> 2) & 0x3f }; break;
        }
        case 0x77: {
          const condMap: Record<number,string> = { 0:'disable',1:'condition: x<A',2:'condition: x>B',3:'condition: A<x<B',4:'condition: x<A or x>B' };
          current.temperature_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', threshold_condition: condMap[u8(bytes,i+1)] ?? 'unknown', threshold_min: i32(bytes,i+2)/100, threshold_max: i32(bytes,i+6)/100 }; i += 10; break;
        }
        case 0x78: { current.temperature_mutation_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', mutation_max: i32(bytes,i+1)/100 }; i += 5; break; }
        case 0x79: {
          const condMap: Record<number,string> = { 0:'disable',1:'condition: x<A',2:'condition: x>B',3:'condition: A<x<B',4:'condition: x<A or x>B' };
          current.humidity_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', threshold_condition: condMap[u8(bytes,i+1)] ?? 'unknown', threshold_min: u16(bytes,i+2)/10, threshold_max: u16(bytes,i+4)/10 }; i += 6; break;
        }
        case 0x7a: { current.humidity_mutation_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', mutation_max: u16(bytes,i+1)/10 }; i += 3; break; }
        case 0x7b: { current.temperature_calibration_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', calibration_value: i32(bytes,i+1)/100 }; i += 5; break; }
        case 0x7c: { current.humidity_calibration_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', calibration_value: i16(bytes,i+1)/10 }; i += 3; break; }
        case 0x7d: { current.light_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', threshold_condition: u8(bytes,i+1), threshold_max: u16(bytes,i+2) }; i += 4; break; }
        case 0x7e: { current.light_tolerance_value = u8(bytes, i++); break; }
        case 0x7f: { current.tilt_alarm_settings = { enable: u8(bytes,i) === 1 ? 'enable' : 'disable', threshold_condition: u8(bytes,i+1), threshold_max: u8(bytes,i+2), duration: u8(bytes,i+3) }; i += 4; break; }
        case 0x80: { current.falling_alarm_settings = { enable: u8(bytes,i++) === 1 ? 'enable' : 'disable' }; break; }
        case 0x81: { current.falling_threshold_alarm_settings = { threshold_level: u8(bytes,i), time_level: u8(bytes,i+1) }; i += 2; break; }
        case 0x82: { current.probe_id_retransmit_count = u8(bytes, i++); break; }
        case 0xc4: { current.auto_p_enable = u8(bytes, i++) === 1 ? 'enable' : 'disable'; break; }
        case 0xc5: {
          const sub = u8(bytes, i++);
          if (!current.data_storage_settings) current.data_storage_settings = {};
          if (sub === 0x00) current.data_storage_settings.enable = u8(bytes,i++) === 1 ? 'enable' : 'disable';
          else if (sub === 0x01) current.data_storage_settings.retransmission_enable = u8(bytes,i++) === 1 ? 'enable' : 'disable';
          else if (sub === 0x02) { current.data_storage_settings.retransmission_interval = u16(bytes,i); i += 2; }
          else if (sub === 0x03) { current.data_storage_settings.retrieval_interval = u16(bytes,i); i += 2; }
          break;
        }
        case 0xc6: {
          const en = u8(bytes, i++); const offs = u8(bytes, i++);
          const sm = u8(bytes, i++); const sw = u8(bytes, i++);
          const st = u16(bytes, i); i += 2;
          const em = u8(bytes, i++); const ew = u8(bytes, i++);
          const et = u16(bytes, i); i += 2;
          current.daylight_saving_time = {
            enable: en === 1 ? 'enable' : 'disable',
            daylight_saving_time_offset: offs,
            start_month: sm, start_week_num: (sw >>> 4) & 0x0f, start_week_day: sw & 0x0f, start_hour_min: st,
            end_month: em, end_week_num: (ew >>> 4) & 0x0f, end_week_day: ew & 0x0f, end_hour_min: et,
          }; break;
        }
        case 0xc7: { current.time_zone = i16(bytes, i); i += 2; break; }

        // ── Cellular status ────────────────────────────────────────────────────
        case 0xbe: {
          if (!current.cellular_status) current.cellular_status = {};
          const sub = u8(bytes, i++);
          if (sub === 0x00) current.cellular_status.register_status = u8(bytes,i++) === 1 ? 'Register Success' : 'Register Failed';
          else if (sub === 0x01) current.cellular_status.sim_status = u8(bytes, i++);
          else if (sub === 0x02) { current.cellular_status.imei  = readstr(bytes, i, 15); i += 15; }
          else if (sub === 0x03) { current.cellular_status.imsi  = readstr(bytes, i, 15); i += 15; }
          else if (sub === 0x04) { current.cellular_status.iccid = readstr(bytes, i, 20); i += 20; }
          else if (sub === 0x05) { current.cellular_status.csq   = i16(bytes, i); i += 2; }
          else if (sub === 0x06) current.cellular_status.connected_status = u8(bytes,i++) === 1 ? 'Connect Success' : 'Connect Failed';
          else if (sub === 0x11) current.cellular_status.milesight_mqtt_status = u8(bytes,i++) === 1 ? 'Connect Success' : 'Connect Failed';
          else if (sub === 0x15) current.cellular_status.milesight_dtls_status = u8(bytes,i++) === 1 ? 'Connect Success' : 'Connect Failed';
          break;
        }

        // ── Service command echoes ─────────────────────────────────────────────
        case 0xbf: { current.reset              = 1; break; }
        case 0xbd: { current.clear_historical_data = 1; break; }
        case 0xbc: { current.stop_historical_data_retrieval = 1; break; }
        case 0xba: { current.retrieve_historical_data_by_time  = { time: u32(bytes, i) }; i += 4; break; }
        case 0xbb: { current.retrieve_historical_data_by_time_range = { start_time: u32(bytes,i), end_time: u32(bytes,i+4) }; i += 8; break; }
        case 0xb9: { current.query_device_status = 1; break; }
        case 0xb8: { current.synchronize_time    = 1; break; }
        case 0xb7: { current.set_time = { timestamp: u32(bytes, i) }; i += 4; break; }
        case 0x50: { current.clear_alarm_item    = 1; break; }
        case 0x51: { current.set_zero_calibration = { operation: u8(bytes,i++) === 0 ? 'Clear zero calibration' : 'Start zero calibration' }; break; }
        case 0x52: { current.set_retrieval_initial_surface = { operation: u8(bytes,i++) }; break; }
        case 0x53: { current.get_sensor_id = 1; break; }

        default: i += 1; break; // unknown, skip 1 byte
      }
    }

    if (history.length > 0) result.history = history;
    return result as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':                        bytes = [0xbe]; break;
      case 'reset':                         bytes = [0xbf]; break;
      case 'clear_historical_data':         bytes = [0xbd]; break;
      case 'stop_historical_data_retrieval': bytes = [0xbc]; break;
      case 'query_device_status':           bytes = [0xb9]; break;
      case 'synchronize_time':              bytes = [0xb8]; break;
      case 'clear_alarm_item':              bytes = [0x50]; break;
      case 'get_sensor_id':                 bytes = [0x53]; break;
      case 'request_query_all_configurations': bytes = [0xee]; break;

      case 'set_time':
        bytes = [0xb7, ...wu32(params.timestamp ?? 0)]; break;
      case 'retrieve_historical_data_by_time':
        bytes = [0xba, ...wu32(params.time ?? 0)]; break;
      case 'retrieve_historical_data_by_time_range':
        bytes = [0xbb, ...wu32(params.start_time ?? 0), ...wu32(params.end_time ?? 0)]; break;

      case 'set_device_status':
        bytes = [0xc8, params.device_status === 'on' ? 1 : 0]; break;

      case 'set_reporting_interval': {
        const unit = params.unit === 'second' ? 0 : 1;
        const val  = unit === 0 ? (params.seconds_of_time ?? 1800) : (params.minutes_of_time ?? 30);
        bytes = [0x60, unit, ...wu16(val)]; break;
      }
      case 'set_cumulative_times':
        bytes = [0x61, params.cumulative_times ?? 8]; break;
      case 'set_collection_interval': {
        const unit = params.unit === 'second' ? 0 : 1;
        const val  = unit === 0 ? (params.seconds_of_time ?? 900) : (params.minutes_of_time ?? 15);
        bytes = [0x62, unit, ...wu16(val)]; break;
      }
      case 'set_alarm_reporting_times':
        bytes = [0x63, ...wu16(params.alarm_reporting_times ?? 1)]; break;
      case 'set_light_collection_interval': {
        const unit = params.unit === 'second' ? 0 : 1;
        const val  = unit === 0 ? (params.seconds_of_time ?? 60) : (params.minutes_of_time ?? 1);
        bytes = [0x64, unit, ...wu16(val)]; break;
      }
      case 'set_temperature_unit':
        bytes = [0x65, params.temperature_unit === '℉' ? 1 : 0]; break;
      case 'set_auto_p_enable':
        bytes = [0xc4, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_base_station_position_enable':
        bytes = [0x71, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_alarm_deactivation_enable':
        bytes = [0x75, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_button_lock': {
        let bits = 0;
        if (params.power_off_enable)       bits |= 1;
        if (params.collect_report_enable)  bits |= 2;
        bytes = [0x76, params.enable === 'enable' ? 1 : 0, bits & 0xff]; break;
      }

      case 'set_temperature_alarm_settings': {
        const condMap: Record<string,number> = { disable:0, 'condition: x<A':1, 'condition: x>B':2, 'condition: A<x<B':3, 'condition: x<A or x>B':4 };
        bytes = [0x77, params.enable === 'enable' ? 1 : 0, condMap[params.threshold_condition ?? 'disable'] ?? 0, ...wi32(Math.round((params.threshold_min ?? 0) * 100)), ...wi32(Math.round((params.threshold_max ?? 0) * 100))]; break;
      }
      case 'set_temperature_mutation_alarm_settings':
        bytes = [0x78, params.enable === 'enable' ? 1 : 0, ...wi32(Math.round((params.mutation_max ?? 0) * 100))]; break;
      case 'set_humidity_alarm_settings': {
        const condMap: Record<string,number> = { disable:0, 'condition: x<A':1, 'condition: x>B':2, 'condition: A<x<B':3, 'condition: x<A or x>B':4 };
        bytes = [0x79, params.enable === 'enable' ? 1 : 0, condMap[params.threshold_condition ?? 'disable'] ?? 0, ...wu16(Math.round((params.threshold_min ?? 0) * 10)), ...wu16(Math.round((params.threshold_max ?? 0) * 10))]; break;
      }
      case 'set_humidity_mutation_alarm_settings':
        bytes = [0x7a, params.enable === 'enable' ? 1 : 0, ...wu16(Math.round((params.mutation_max ?? 0) * 10))]; break;
      case 'set_temperature_calibration_settings':
        bytes = [0x7b, params.enable === 'enable' ? 1 : 0, ...wi32(Math.round((params.calibration_value ?? 0) * 100))]; break;
      case 'set_humidity_calibration_settings':
        bytes = [0x7c, params.enable === 'enable' ? 1 : 0, ...wi16(Math.round((params.calibration_value ?? 0) * 10))]; break;
      case 'set_light_alarm_settings':
        bytes = [0x7d, params.enable === 'enable' ? 1 : 0, params.threshold_condition ?? 0, ...wu16(params.threshold_max ?? 0)]; break;
      case 'set_light_tolerance_value':
        bytes = [0x7e, params.light_tolerance_value ?? 5]; break;
      case 'set_tilt_alarm_settings':
        bytes = [0x7f, params.enable === 'enable' ? 1 : 0, params.threshold_condition ?? 0, params.threshold_max ?? 20, params.duration ?? 10]; break;
      case 'set_falling_alarm_settings':
        bytes = [0x80, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_falling_threshold_alarm_settings':
        bytes = [0x81, params.threshold_level ?? 7, params.time_level ?? 32]; break;
      case 'set_probe_id_retransmit_count':
        bytes = [0x82, params.probe_id_retransmit_count ?? 1]; break;

      case 'set_time_zone':
        bytes = [0xc7, ...wi16(params.time_zone ?? 0)]; break;
      case 'set_daylight_saving_time': {
        const en = params.enable === 'enable' ? 1 : 0;
        const startWeek = (((params.start_week_num ?? 1) & 0x0f) << 4) | ((params.start_week_day ?? 7) & 0x0f);
        const endWeek   = (((params.end_week_num   ?? 1) & 0x0f) << 4) | ((params.end_week_day   ?? 7) & 0x0f);
        bytes = [0xc6, en, params.daylight_saving_time_offset ?? 60, params.start_month ?? 1, startWeek, ...wu16(params.start_hour_min ?? 0), params.end_month ?? 1, endWeek, ...wu16(params.end_hour_min ?? 0)]; break;
      }
      case 'set_data_storage_enable':
        bytes = [0xc5, 0x00, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_data_retransmission_enable':
        bytes = [0xc5, 0x01, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_data_retransmission_interval':
        bytes = [0xc5, 0x02, ...wu16(params.retransmission_interval ?? 600)]; break;
      case 'set_data_retrieval_interval':
        bytes = [0xc5, 0x03, ...wu16(params.retrieval_interval ?? 60)]; break;

      case 'set_airplane_mode_time_period_enable':
        bytes = [0x73, 0x00, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_airplane_mode_start_time': {
        const ts = params.start_timestamp ?? {};
        bytes = [0x73, 0x01, ts.year??0, ts.month??1, ts.day??1, ts.hour??0, ts.minute??0, ts.second??0]; break;
      }
      case 'set_airplane_mode_end_time': {
        const ts = params.end_timestamp ?? {};
        bytes = [0x73, 0x02, ts.year??0, ts.month??1, ts.day??1, ts.hour??0, ts.minute??0, ts.second??0]; break;
      }

      case 'set_zero_calibration':
        bytes = [0x51, params.operation === 'Start zero calibration' ? 1 : 0]; break;
      case 'set_retrieval_initial_surface':
        bytes = [0x52, params.operation ?? 0]; break;

      default:
        throw new Error(`TS601: unsupported command "${type}"`);
    }

    return { fPort: 0, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // TS601 uses single-byte command IDs unique to this product family:
  //   0x0D — relative_surface_info (tilt angles, TS601-exclusive)
  //   0x0C — probe_connect_status
  //   0x0E — report_package_type
  //   0x82 — probe_id_retransmit_count
  // Also: 0x04 temperature is int32 (5B total) — in IPSO devices 0x04 is never used for temp

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x0d || b === 0x82) return true; // tilt angles or probe retransmit — TS601 exclusive
      if (b === 0x0c && i + 1 < bytes.length) return true; // probe connect status
    }
    return false;
  }
}