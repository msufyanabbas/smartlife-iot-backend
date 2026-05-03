// src/modules/devices/codecs/milesight/cth01.codec.ts
// Milesight CTH01 — LoRaWAN 3-Phase Energy Meter / Current & Voltage Analyzer
//
// ── Protocol family ───────────────────────────────────────────────────────────
// COMPLETELY DIFFERENT from WS/UC100 family:
//   - Single-byte command ID (not two-byte channel_id + channel_type)
//   - Variable-length telemetry with mask-based group encoding
//   - History wrapping: 0xED resets decoded, captures into history array
//   - Error sentinel values per measurement type (0xFF…→'error')
//
// ── Uplink telemetry channels ─────────────────────────────────────────────────
//   0x01 — temperature (int16 LE /100, °C)
//   0x02 — voltage_three_phase_imbalance (uint16 LE /100, %)
//   0x03 — thdi[12] (12× uint16 LE /100, %)
//   0x04 — thdv[3]  (3× uint16 LE /100, %)
//   0x05 — current[12] (12× uint24 LE /100, A)
//   0x06 — voltage[3]  (3× uint16 LE /100, V)
//   0x07 — power_factor (mask byte + up to 4 groups, uint8/100 per value)
//   0x08 — active_power1  (mask byte + up to 2 groups, int32 LE /1000, kW)
//   0x09 — active_power2  (same structure as 0x08)
//   0x0A — reactive_power1 (mask byte + up to 2 groups, int32 LE /1000, kvar)
//   0x0B — reactive_power2 (same structure as 0x0A)
//   0x0C — apparent_power1 (mask byte + up to 2 groups, int32 LE /1000, kVA)
//   0x0D — apparent_power2 (same structure as 0x0C)
//   0x0E — forward_active_energy1  (mask byte + up to 2 groups, uint32 LE /1000, kWh)
//   0x0F — forward_active_energy2  (same)
//   0x10 — reverse_active_energy1  (same)
//   0x11 — reverse_active_energy2  (same)
//   0x12 — forward_reactive_energy1 (same, kVArh)
//   0x13 — forward_reactive_energy2 (same)
//   0x14 — reverse_reactive_energy1 (same)
//   0x15 — reverse_reactive_energy2 (same)
//   0x16 — apparent_energy1 (same, kVAh)
//   0x17 — apparent_energy2 (same)
//   0x30 — temperature_alarm (type byte + optional int16 LE /100)
//   0x31 — current_alarm (channel + type + optional uint24 LE /100)
//   0x32 — voltage_alarm (channel + type + optional uint16 LE /100)
//   0x33 — thdi_alarm (channel + type + optional uint16 LE /100)
//   0x34 — thdv_alarm (channel + type + optional uint16 LE /100)
//   0x35 — voltage_unbalance_alarm (type + optional uint16 LE /100)
//   0x36 — power_loss_alarm (no data)
//   0x40 — history_type (type byte)
//   0xC8 — device_status (uint8)
//
// ── History mechanism (0xED) ──────────────────────────────────────────────────
//   0xED skips type byte, reads uint32 LE timestamp, then RESETS decoded.
//   All subsequent channels are parsed into the new decoded context until
//   the next 0xED or end-of-payload. Each 0xED frame is pushed into history[].
//
// ── Configuration responses ───────────────────────────────────────────────────
//   0xFF — check_sequence_number_reply (1B sequence)
//   0xFE — check_order_reply
//   0xEF — command response (result + length + command bytes)
//   0xEE — all_configurations_request_by_device
//   0xCF 0xD8 — lorawan_configuration_settings.version
//   0xDA — version (hardware 2B + firmware 6B)
//   0xDB — product_sn (8B hex)
//   0xDD — product_pn (32B string)
//   0xDE — product_name (32B string)
//   0xDF — tsl_version (2B)
//   0xD7 — device_info (72B)
//   0xD8 — product_frequency_band (16B string)
//   0xD9 — oem_id (2B hex)
//   0x60 — collection_interval (unit + u16)
//   0x61 — reporting_interval (unit + u16)
//   0x63 — temperature_unit
//   0x64 — bluetooth_name (length + string)
//   0x66 — voltage_interface
//   0x67-0x6A — current_interface1-4 (type + 3× config)
//   0x6B — temperature_calibration_settings
//   0x6C — report_enable (u16 bitmask)
//   0x6D — month_statistics_settings
//   0x76 — temperature_alarm_settings
//   0x77-0x7A — current/voltage/thdi/thdv alarm settings (per channel)
//   0x7B — voltage_unbalance_alarm_settings
//   0x7C — alarm_global_settings
//   0xB6 — reconnect
//   0xB7 — set_time
//   0xB8 — synchronize_time
//   0xB9 — query_device_status
//   0xBE — reboot
//   0xBF — reset
//   0xC5 — data_storage_settings (sub + value)
//   0xC6 — daylight_saving_time
//   0xC7 — time_zone (int16 LE, minutes, UTC+8=480)
//   0x5B — retrieve_historical_data_by_time
//   0x5C — retrieve_historical_data_by_time_range
//   0x5D — stop_historical_data_retrieval
//   0x5E — clear_data
//   0x5F — reset_energy
//   0x57 — query_history_set
//
// ── Error sentinels ───────────────────────────────────────────────────────────
//   current:    0xFFFFFF / 100 = 167772.15
//   voltage:    0xFFFF   / 100 = 655.35
//   energy:     0xFFFFFFFF / 1000
//   power_factor: 0xFF / 100 = 2.55
//   active/reactive/apparent_power: int32(-1)/1000 = -0.001
//   thdi/thdv/voltage_3ph: 0xFFFF / 100 = 655.35
//
// ── Mask-based group encoding (power, energy channels) ───────────────────────
//   mask byte bits[N]:
//     0 = single aggregate value (1 group value)
//     1 = three per-phase values (chan1, chan2, chan3)
//   For 0x07 (power_factor): 4 groups (mask1..mask4), values are uint8/100
//   For 0x08-0x17: 2 groups (mask1, mask2)
//     int32/uint32 values depending on channel type
//
// ── Timezone note ─────────────────────────────────────────────────────────────
//   CTH01 timezone (0xC7) uses WS50x-style minutes: UTC+8 = 480
//
// canDecode fingerprint: 0x05 at byte 0 (current, 37B) or 0x03 at byte 0 (thdi, 25B)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Error sentinel values ────────────────────────────────────────────────────
const ERR = {
  current:   0xFFFFFF / 100,
  voltage:   0xFFFF   / 100,
  energy:    (0xFFFFFFFF >>> 0) / 1000,
  pf:        0xFF     / 100,
  power:     -0.001,  // int32(-1)/1000
  thd:       0xFFFF   / 100,
  v3ph:      0xFFFF   / 100,
};

function chk(value: number, sentinel: number): number | string {
  return Math.abs(value - sentinel) < 0.0001 ? 'error' : value;
}

// ── Low-level readers ─────────────────────────────────────────────────────────
function u8 (b: number[], i: number): number { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i+1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u24(b: number[], i: number): number { return ((b[i+2] << 16) | (b[i+1] << 8) | b[i]) & 0xffffff; }
function u32(b: number[], i: number): number { return (((b[i+3]<<24)|(b[i+2]<<16)|(b[i+1]<<8)|b[i]) >>> 0); }
function i32(b: number[], i: number): number { const v = u32(b, i); return v > 0x7fffffff ? v - 0x100000000 : v; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function wi32(v: number): number[] { const u = v < 0 ? v + 0x100000000 : v; return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff]; }

function readString(b: number[], offset: number, len: number): string {
  let s = '';
  for (let j = 0; j < len && (offset + j) < b.length; j++) {
    if (b[offset + j] === 0) break;
    s += String.fromCharCode(b[offset + j]);
  }
  return s.replace(/\0+$/, '');
}
function hexStr(b: number[], offset: number, len: number): string {
  return b.slice(offset, offset + len).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ── Mask-based group decoder ──────────────────────────────────────────────────
// Used by 0x08-0x17 (2 groups, int32 or uint32 /1000)
function readMaskedGroups2(
  b: number[], offset: number,
  prefix: string,
  readFn: (b: number[], i: number) => number,
  divisor: number,
  sentinel: number,
  decoded: Record<string, any>
): number {
  const mask = u8(b, offset++);
  const mask1 = (mask >> 0) & 1;
  const mask2 = (mask >> 1) & 1;

  decoded[`${prefix}.mask1`] = mask1;
  decoded[`${prefix}.mask2`] = mask2;

  if (mask1 === 0) {
    decoded[`${prefix}.group1_value`] = chk(readFn(b, offset) / divisor, sentinel); offset += 4;
  } else {
    decoded[`${prefix}.group1`] = {
      chan1: chk(readFn(b, offset) / divisor, sentinel),
      chan2: chk(readFn(b, offset + 4) / divisor, sentinel),
      chan3: chk(readFn(b, offset + 8) / divisor, sentinel),
    };
    offset += 12;
  }
  if (mask2 === 0) {
    decoded[`${prefix}.group2_value`] = chk(readFn(b, offset) / divisor, sentinel); offset += 4;
  } else {
    decoded[`${prefix}.group2`] = {
      chan1: chk(readFn(b, offset) / divisor, sentinel),
      chan2: chk(readFn(b, offset + 4) / divisor, sentinel),
      chan3: chk(readFn(b, offset + 8) / divisor, sentinel),
    };
    offset += 12;
  }
  return offset;
}

// Used by 0x07 (power_factor, 4 groups, uint8/100)
function readMaskedGroups4PF(b: number[], offset: number, decoded: Record<string, any>): number {
  const mask = u8(b, offset++);
  const masks = [mask & 1, (mask >> 1) & 1, (mask >> 2) & 1, (mask >> 3) & 1];
  decoded['power_factor.mask1'] = masks[0];
  decoded['power_factor.mask2'] = masks[1];
  decoded['power_factor.mask3'] = masks[2];
  decoded['power_factor.mask4'] = masks[3];

  for (let g = 1; g <= 4; g++) {
    if (masks[g - 1] === 0) {
      decoded[`power_factor.group${g}_value`] = chk(u8(b, offset++) / 100, ERR.pf);
    } else {
      decoded[`power_factor.group${g}`] = {
        chan1: chk(u8(b, offset++) / 100, ERR.pf),
        chan2: chk(u8(b, offset++) / 100, ERR.pf),
        chan3: chk(u8(b, offset++) / 100, ERR.pf),
      };
    }
  }
  return offset;
}

export class MilesightCTH01Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-cth01';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['CTH01'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Current Monitoring';
  readonly modelFamily     = 'CTH01';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/cth-series/cth01/CTH01.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'CTH01',
    description:  '3-Phase Energy Meter — voltage, current, power, energy, THD, and power factor analysis',
    telemetryKeys: [
      { key: 'temperature',                label: 'Temperature',                  type: 'number' as const, unit: '°C'   },
      { key: 'voltage',                    label: 'Voltage (3-phase)',            type: 'number' as const, unit: 'V'    },
      { key: 'current',                    label: 'Current (12-channel)',         type: 'number' as const, unit: 'A'    },
      { key: 'power_factor',               label: 'Power Factor',                 type: 'number' as const, unit: '%'    },
      { key: 'active_power1',              label: 'Active Power 1',               type: 'number' as const, unit: 'kW'   },
      { key: 'active_power2',              label: 'Active Power 2',               type: 'number' as const, unit: 'kW'   },
      { key: 'reactive_power1',            label: 'Reactive Power 1',             type: 'number' as const, unit: 'kvar' },
      { key: 'reactive_power2',            label: 'Reactive Power 2',             type: 'number' as const, unit: 'kvar' },
      { key: 'apparent_power1',            label: 'Apparent Power 1',             type: 'number' as const, unit: 'kVA'  },
      { key: 'apparent_power2',            label: 'Apparent Power 2',             type: 'number' as const, unit: 'kVA'  },
      { key: 'forward_active_energy1',     label: 'Forward Active Energy 1',      type: 'number' as const, unit: 'kWh'  },
      { key: 'forward_active_energy2',     label: 'Forward Active Energy 2',      type: 'number' as const, unit: 'kWh'  },
      { key: 'reverse_active_energy1',     label: 'Reverse Active Energy 1',      type: 'number' as const, unit: 'kWh'  },
      { key: 'reverse_active_energy2',     label: 'Reverse Active Energy 2',      type: 'number' as const, unit: 'kWh'  },
      { key: 'forward_reactive_energy1',   label: 'Forward Reactive Energy 1',    type: 'number' as const, unit: 'kVArh'},
      { key: 'forward_reactive_energy2',   label: 'Forward Reactive Energy 2',    type: 'number' as const, unit: 'kVArh'},
      { key: 'reverse_reactive_energy1',   label: 'Reverse Reactive Energy 1',    type: 'number' as const, unit: 'kVArh'},
      { key: 'reverse_reactive_energy2',   label: 'Reverse Reactive Energy 2',    type: 'number' as const, unit: 'kVArh'},
      { key: 'apparent_energy1',           label: 'Apparent Energy 1',            type: 'number' as const, unit: 'kVAh' },
      { key: 'apparent_energy2',           label: 'Apparent Energy 2',            type: 'number' as const, unit: 'kVAh' },
      { key: 'thdi',                       label: 'THD Current (12-channel)',      type: 'number' as const, unit: '%'   },
      { key: 'thdv',                       label: 'THD Voltage (3-phase)',         type: 'number' as const, unit: '%'   },
      { key: 'voltage_three_phase_imbalcance', label: 'Voltage 3-Phase Imbalance', type: 'number' as const, unit: '%'  },
    ],
    commands: [
      { type: 'reboot',               label: 'Reboot Device',       params: [] },
      { type: 'reset',                label: 'Reset Device',        params: [] },
      { type: 'query_device_status',  label: 'Query Device Status', params: [] },
      { type: 'synchronize_time',     label: 'Synchronize Time',    params: [] },
      { type: 'reconnect',            label: 'Reconnect',           params: [] },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Offset (minutes, e.g. UTC+8=480)', type: 'number' as const, required: true, default: 480 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [
          { key: 'unit',            label: 'Unit',  type: 'select' as const, required: true, options: [{ label: 'Seconds', value: 0 }, { label: 'Minutes', value: 1 }] },
          { key: 'seconds_of_time', label: 'Value', type: 'number' as const, required: false, default: 30 },
        ],
      },
      {
        type:   'set_reporting_interval',
        label:  'Set Reporting Interval',
        params: [
          { key: 'unit',            label: 'Unit',  type: 'select' as const, required: true, options: [{ label: 'Seconds', value: 0 }, { label: 'Minutes', value: 1 }] },
          { key: 'minutes_of_time', label: 'Value', type: 'number' as const, required: false, default: 10 },
        ],
      },
      {
        type:   'set_temperature_alarm_settings',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'enable',               label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'threshold_condition',  label: 'Condition', type: 'number'  as const, required: false, default: 2 },
          { key: 'threshold_min',        label: 'Min (°C)',  type: 'number'  as const, required: false, default: 0  },
          { key: 'threshold_max',        label: 'Max (°C)',  type: 'number'  as const, required: false, default: 60 },
        ],
      },
      {
        type:   'set_alarm_global_settings',
        label:  'Set Alarm Global Settings',
        params: [
          { key: 'interval',       label: 'Interval (minutes)', type: 'number'  as const, required: false, default: 5 },
          { key: 'times',          label: 'Times',              type: 'number'  as const, required: false, default: 3 },
          { key: 'release_enable', label: 'Release Enable',     type: 'boolean' as const, required: false },
        ],
      },
      {
        type:   'set_data_storage',
        label:  'Set Data Storage',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
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
      {
        type:   'stop_historical_data_retrieval',
        label:  'Stop History Retrieval',
        params: [],
      },
      {
        type:   'reset_energy',
        label:  'Reset Energy',
        params: [{ key: 'channel', label: 'Channel', type: 'number' as const, required: true, default: 0 }],
      },
      {
        type:   'clear_data',
        label:  'Clear Data',
        params: [{ key: 'type', label: 'Type', type: 'number' as const, required: true, default: 0 }],
      },
    ],
    uiComponents: [
      { type: 'value' as const, label: 'Temperature',             keys: ['temperature'],                     unit: '°C'   },
      { type: 'value' as const, label: 'Voltage',                 keys: ['voltage']                                        },
      { type: 'value' as const, label: 'Current',                 keys: ['current']                                        },
      { type: 'value' as const, label: 'Power Factor',            keys: ['power_factor']                                   },
      { type: 'value' as const, label: 'Active Power 1',          keys: ['active_power1'],                   unit: 'kW'   },
      { type: 'value' as const, label: 'Forward Active Energy 1', keys: ['forward_active_energy1'],          unit: 'kWh'  },
      { type: 'value' as const, label: '3-Phase Imbalance',       keys: ['voltage_three_phase_imbalcance'],  unit: '%'    },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    let decoded: Record<string, any> = {};
    const result: Record<string, any>  = {};
    const history: Record<string, any>[] = [];
    let i = 0;

    while (i < bytes.length) {
      const cmd = bytes[i++];

      switch (cmd) {

        // ── System / meta ───────────────────────────────────────────────────

        case 0xff: // sequence number reply
          decoded.check_sequence_number_reply = { sequence_number: u8(bytes, i++) };
          break;

        case 0xfe: // order reply
          i++; decoded.check_order_reply = 1;
          break;

        case 0xef: { // command response
          const bitOpts = u8(bytes, i++);
          const result_code = (bitOpts >> 4) & 0x0f;
          const length      = bitOpts & 0x0f;
          const cmd_bytes   = hexStr(bytes, i, length); i += length;
          if (!decoded.ans) decoded.ans = [];
          decoded.ans.push({ result: result_code, length, id: cmd_bytes });
          break;
        }

        case 0xee: // request push all configurations
          decoded.all_configurations_request_by_device = 1;
          break;

        case 0xed: { // ── HISTORY frame: save current, reset decoded ─────────
          if (Object.keys(history).length === 0) {
            Object.assign(result, decoded);
          }
          i++; // skip type byte
          const ts = u32(bytes, i); i += 4;
          decoded = {};
          decoded.timestamp = ts;
          history.push(decoded);
          break;
        }

        case 0xcf: { // lorawan config
          const sub = u8(bytes, i++);
          if (sub === 0xd8) {
            if (!decoded.lorawan_configuration_settings) decoded.lorawan_configuration_settings = {};
            decoded.lorawan_configuration_settings.version = u8(bytes, i++);
          }
          break;
        }

        case 0xdf: // tsl_version
          decoded.tsl_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`; i += 2;
          break;

        case 0xde: // product_name (32B)
          decoded.product_name = readString(bytes, i, 32); i += 32;
          break;

        case 0xdd: // product_pn (32B)
          decoded.product_pn = readString(bytes, i, 32); i += 32;
          break;

        case 0xdb: // product_sn (8B hex)
          decoded.product_sn = hexStr(bytes, i, 8); i += 8;
          break;

        case 0xda: { // version: hardware(2B) + firmware(6B)
          const hw = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`;
          const fw_major = u8(bytes, i + 2);
          const fw_minor = u8(bytes, i + 3);
          let fw = `v${fw_major}.${fw_minor}`;
          const rel = u8(bytes, i + 4); if (rel) fw += `-r${rel}`;
          const alpha = u8(bytes, i + 5); if (alpha) fw += `-a${alpha}`;
          const ut = u8(bytes, i + 6); if (ut) fw += `-u${ut}`;
          const test = u8(bytes, i + 7); if (test) fw += `-t${test}`;
          if (!decoded.version) decoded.version = {};
          decoded.version.hardware_version = hw;
          decoded.version.firmware_version = fw;
          i += 8;
          break;
        }

        case 0xd9: // oem_id (2B)
          decoded.oem_id = hexStr(bytes, i, 2); i += 2;
          break;

        case 0xd8: // product_frequency_band (16B)
          decoded.product_frequency_band = readString(bytes, i, 16); i += 16;
          break;

        case 0xd7: // device_info (72B)
          i += 72;
          decoded.device_info = 1;
          break;

        // ── Telemetry ────────────────────────────────────────────────────────

        case 0x01: // temperature: int16LE /100
          decoded.temperature = i16(bytes, i) / 100; i += 2;
          break;

        case 0x02: // voltage_three_phase_imbalance: uint16LE /100
          decoded.voltage_three_phase_imbalcance = chk(u16(bytes, i) / 100, ERR.v3ph); i += 2;
          break;

        case 0x03: // thdi: 12× uint16LE /100
          decoded.thdi = [];
          for (let k = 0; k < 12; k++) {
            decoded.thdi.push({ value: chk(u16(bytes, i) / 100, ERR.thd) }); i += 2;
          }
          break;

        case 0x04: // thdv: 3× uint16LE /100
          decoded.thdv = [];
          for (let k = 0; k < 3; k++) {
            decoded.thdv.push({ value: chk(u16(bytes, i) / 100, ERR.thd) }); i += 2;
          }
          break;

        case 0x05: // current: 12× uint24LE /100
          decoded.current = [];
          for (let k = 0; k < 12; k++) {
            decoded.current.push({ value: chk(u24(bytes, i) / 100, ERR.current) }); i += 3;
          }
          break;

        case 0x06: // voltage: 3× uint16LE /100
          decoded.voltage = [];
          for (let k = 0; k < 3; k++) {
            decoded.voltage.push({ value: chk(u16(bytes, i) / 100, ERR.voltage) }); i += 2;
          }
          break;

        case 0x07: // power_factor: mask(4 groups) + uint8/100 per value
          i = readMaskedGroups4PF(bytes, i, decoded);
          break;

        case 0x08: i = readMaskedGroups2(bytes, i, 'active_power1',          i32, 1000, ERR.power,  decoded); break;
        case 0x09: i = readMaskedGroups2(bytes, i, 'active_power2',          i32, 1000, ERR.power,  decoded); break;
        case 0x0a: i = readMaskedGroups2(bytes, i, 'reactive_power1',        i32, 1000, ERR.power,  decoded); break;
        case 0x0b: i = readMaskedGroups2(bytes, i, 'reactive_power2',        i32, 1000, ERR.power,  decoded); break;
        case 0x0c: i = readMaskedGroups2(bytes, i, 'apparent_power1',        i32, 1000, ERR.power,  decoded); break;
        case 0x0d: i = readMaskedGroups2(bytes, i, 'apparent_power2',        i32, 1000, ERR.power,  decoded); break;
        case 0x0e: i = readMaskedGroups2(bytes, i, 'forward_active_energy1', u32, 1000, ERR.energy, decoded); break;
        case 0x0f: i = readMaskedGroups2(bytes, i, 'forward_active_energy2', u32, 1000, ERR.energy, decoded); break;
        case 0x10: i = readMaskedGroups2(bytes, i, 'reverse_active_energy1', u32, 1000, ERR.energy, decoded); break;
        case 0x11: i = readMaskedGroups2(bytes, i, 'reverse_active_energy2', u32, 1000, ERR.energy, decoded); break;
        case 0x12: i = readMaskedGroups2(bytes, i, 'forward_reactive_energy1', u32, 1000, ERR.energy, decoded); break;
        case 0x13: i = readMaskedGroups2(bytes, i, 'forward_reactive_energy2', u32, 1000, ERR.energy, decoded); break;
        case 0x14: i = readMaskedGroups2(bytes, i, 'reverse_reactive_energy1', u32, 1000, ERR.energy, decoded); break;
        case 0x15: i = readMaskedGroups2(bytes, i, 'reverse_reactive_energy2', u32, 1000, ERR.energy, decoded); break;
        case 0x16: i = readMaskedGroups2(bytes, i, 'apparent_energy1',        u32, 1000, ERR.energy, decoded); break;
        case 0x17: i = readMaskedGroups2(bytes, i, 'apparent_energy2',        u32, 1000, ERR.energy, decoded); break;

        case 0x40: // history_type
          if (!decoded.history_type) decoded.history_type = {};
          decoded.history_type.type = u8(bytes, i++);
          break;

        case 0xc8: // device_status
          decoded.device_status = u8(bytes, i++);
          break;

        // ── Alarm events ─────────────────────────────────────────────────────

        case 0x30: { // temperature_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          const atype = u8(bytes, i++);
          alarm.type = atype;
          const tMap: Record<number, string> = {
            0x00:'collection_error', 0x01:'lower_range_error', 0x02:'over_range_error',
            0x03:'no_data', 0x10:'lower_range_alarm_deactivation', 0x11:'lower_range_alarm_trigger',
            0x12:'over_range_alarm_deactivation', 0x13:'over_range_alarm_trigger',
            0x14:'within_range_alarm_deactivation', 0x15:'within_range_alarm_trigger',
            0x16:'exceed_range_alarm_deactivation', 0x17:'exceed_range_alarm_trigger',
          };
          if (atype >= 0x10) {
            const key = tMap[atype] ?? `type_${atype.toString(16)}`;
            alarm[key] = { temperature: i16(bytes, i) / 100 }; i += 2;
          }
          decoded.temperature_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x31: { // current_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          alarm.channel = u8(bytes, i++);
          alarm.info = {};
          const atype = u8(bytes, i++);
          alarm.info.type = atype;
          const withVal = [0x01,0x02,0x04,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17];
          const cMap: Record<number, string> = {
            0x01:'lower_range_error', 0x02:'over_range_error', 0x04:'over_range_release',
            0x10:'lower_range_alarm_deactivation', 0x11:'lower_range_alarm_trigger',
            0x12:'over_range_alarm_deactivation', 0x13:'over_range_alarm_trigger',
            0x14:'within_range_alarm_deactivation', 0x15:'within_range_alarm_trigger',
            0x16:'exceed_range_alarm_deactivation', 0x17:'exceed_range_alarm_trigger',
          };
          if (withVal.includes(atype)) {
            const key = cMap[atype] ?? `type_${atype.toString(16)}`;
            alarm.info[key] = { current: chk(u24(bytes, i) / 100, ERR.current) }; i += 3;
          }
          decoded.current_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x32: { // voltage_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          alarm.channel = u8(bytes, i++);
          alarm.info = {};
          const atype = u8(bytes, i++);
          alarm.info.type = atype;
          const withVal = [0x01,0x02,0x04,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17];
          const vMap: Record<number, string> = {
            0x01:'lower_range_error', 0x02:'over_range_error', 0x04:'over_range_release',
            0x10:'lower_range_alarm_deactivation', 0x11:'lower_range_alarm_trigger',
            0x12:'over_range_alarm_deactivation', 0x13:'over_range_alarm_trigger',
            0x14:'within_range_alarm_deactivation', 0x15:'within_range_alarm_trigger',
            0x16:'exceed_range_alarm_deactivation', 0x17:'exceed_range_alarm_trigger',
          };
          if (withVal.includes(atype)) {
            const key = vMap[atype] ?? `type_${atype.toString(16)}`;
            alarm.info[key] = { voltage: chk(u16(bytes, i) / 100, ERR.voltage) }; i += 2;
          }
          decoded.voltage_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x33: { // thdi_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          alarm.channel = u8(bytes, i++);
          alarm.info = {};
          const atype = u8(bytes, i++);
          alarm.info.type = atype;
          if (atype === 0x12) { alarm.info.over_range_alarm_deactivation = { thdi: chk(u16(bytes, i) / 100, ERR.thd) }; i += 2; }
          if (atype === 0x13) { alarm.info.over_range_alarm_trigger       = { thdi: chk(u16(bytes, i) / 100, ERR.thd) }; i += 2; }
          decoded.thdi_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x34: { // thdv_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          alarm.channel = u8(bytes, i++);
          alarm.info = {};
          const atype = u8(bytes, i++);
          alarm.info.type = atype;
          if (atype === 0x12) { alarm.info.over_range_alarm_deactivation = { thdv: chk(u16(bytes, i) / 100, ERR.thd) }; i += 2; }
          if (atype === 0x13) { alarm.info.over_range_alarm_trigger       = { thdv: chk(u16(bytes, i) / 100, ERR.thd) }; i += 2; }
          decoded.thdv_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x35: { // voltage_unbalance_alarm
          if (!decoded.event) decoded.event = [];
          const alarm: Record<string, any> = {};
          const atype = u8(bytes, i++);
          alarm.type = atype;
          if (atype === 0x12) { alarm.over_range_alarm_deactivation = { voltage_unbalance: chk(u16(bytes, i) / 100, ERR.v3ph) }; i += 2; }
          if (atype === 0x13) { alarm.over_range_alarm_trigger       = { voltage_unbalance: chk(u16(bytes, i) / 100, ERR.v3ph) }; i += 2; }
          decoded.voltage_unbalance_alarm = alarm;
          decoded.event.push(alarm);
          break;
        }

        case 0x36: // power_loss_alarm
          decoded.power_loss_alarm = 1;
          break;

        // ── Configuration channels ────────────────────────────────────────────

        case 0x60: { // collection_interval
          const unit = u8(bytes, i++);
          if (!decoded.collection_interval) decoded.collection_interval = {};
          decoded.collection_interval.unit = unit;
          if (unit === 0) decoded.collection_interval.seconds_of_time = u16(bytes, i);
          else            decoded.collection_interval.minutes_of_time  = u16(bytes, i);
          i += 2;
          break;
        }

        case 0x61: { // reporting_interval
          const unit = u8(bytes, i++);
          if (!decoded.reporting_interval) decoded.reporting_interval = {};
          decoded.reporting_interval.unit = unit;
          if (unit === 0) decoded.reporting_interval.seconds_of_time = u16(bytes, i);
          else            decoded.reporting_interval.minutes_of_time  = u16(bytes, i);
          i += 2;
          break;
        }

        case 0x63: decoded.temperature_unit = u8(bytes, i++); break;

        case 0x64: { // bluetooth_name
          if (!decoded.bluetooth_name) decoded.bluetooth_name = {};
          decoded.bluetooth_name.length = u8(bytes, i++);
          decoded.bluetooth_name.content = readString(bytes, i, decoded.bluetooth_name.length);
          i += decoded.bluetooth_name.length;
          break;
        }

        case 0x66: decoded.voltage_interface = u8(bytes, i++); break;

        case 0x67: case 0x68: case 0x69: case 0x6a: {
          const ifKey = `current_interface${cmd - 0x66}`;
          if (!decoded[ifKey]) decoded[ifKey] = {};
          decoded[ifKey].type = u8(bytes, i++);
          decoded[ifKey].config = [];
          for (let c = 0; c < 3; c++) {
            decoded[ifKey].config.push({ direction: u8(bytes, i++), range: u16(bytes, i) });
            i += 2;
          }
          break;
        }

        case 0x6b: { // temperature_calibration_settings
          if (!decoded.temperature_calibration_settings) decoded.temperature_calibration_settings = {};
          decoded.temperature_calibration_settings.enable = u8(bytes, i++);
          decoded.temperature_calibration_settings.calibration_value = i16(bytes, i) / 100; i += 2;
          break;
        }

        case 0x6c: { // report_enable bitmask (u16LE)
          const bits = u16(bytes, i); i += 2;
          decoded.report_enable = {
            temperature:              (bits >> 0)  & 1,
            current:                  (bits >> 1)  & 1,
            voltage:                  (bits >> 2)  & 1,
            power_factor:             (bits >> 3)  & 1,
            active_power:             (bits >> 4)  & 1,
            reactive_power:           (bits >> 5)  & 1,
            apparent_power:           (bits >> 6)  & 1,
            forward_active_energy:    (bits >> 7)  & 1,
            reverse_active_energy:    (bits >> 8)  & 1,
            forward_reactive_energy:  (bits >> 9)  & 1,
            reverse_reactive_energy:  (bits >> 10) & 1,
            apparent_energy:          (bits >> 11) & 1,
            thdi:                     (bits >> 12) & 1,
            thdv:                     (bits >> 13) & 1,
            voltage_unbalance:        (bits >> 14) & 1,
          };
          break;
        }

        case 0x6d: { // month_statistics_settings
          if (!decoded.month_statistics_settings) decoded.month_statistics_settings = {};
          decoded.month_statistics_settings.day    = u8(bytes, i++);
          decoded.month_statistics_settings.hour   = u8(bytes, i++);
          decoded.month_statistics_settings.minute = u8(bytes, i++);
          break;
        }

        case 0x76: { // temperature_alarm_settings
          if (!decoded.temperature_alarm_settings) decoded.temperature_alarm_settings = {};
          decoded.temperature_alarm_settings.enable              = u8(bytes, i++);
          decoded.temperature_alarm_settings.threshold_condition = u8(bytes, i++);
          decoded.temperature_alarm_settings.threshold_min       = i16(bytes, i) / 100; i += 2;
          decoded.temperature_alarm_settings.threshold_max       = i16(bytes, i) / 100; i += 2;
          break;
        }

        case 0x77: case 0x78: case 0x79: case 0x7a: { // current/voltage/thdi/thdv alarm settings
          const keyMap: Record<number, string> = { 0x77:'current_alarm_settings', 0x78:'voltage_alarm_settings', 0x79:'thdi_alarm_settings', 0x7a:'thdv_alarm_settings' };
          const key = keyMap[cmd];
          if (!decoded[key]) decoded[key] = [];
          const ch = u8(bytes, i++);
          const item: Record<string, any> = { channel: ch };
          item.enable              = u8(bytes, i++);
          item.threshold_condition = u8(bytes, i++);
          item.threshold_min       = i16(bytes, i); i += 2;
          item.threshold_max       = i16(bytes, i); i += 2;
          (decoded[key] as any[]).push(item);
          break;
        }

        case 0x7b: { // voltage_unbalance_alarm_settings
          if (!decoded.voltage_unbalance_alarm_settings) decoded.voltage_unbalance_alarm_settings = {};
          decoded.voltage_unbalance_alarm_settings.enable              = u8(bytes, i++);
          decoded.voltage_unbalance_alarm_settings.threshold_condition = u8(bytes, i++);
          decoded.voltage_unbalance_alarm_settings.threshold_min       = i16(bytes, i); i += 2;
          decoded.voltage_unbalance_alarm_settings.threshold_max       = i16(bytes, i); i += 2;
          break;
        }

        case 0x7c: { // alarm_global_settings
          if (!decoded.alarm_global_settings) decoded.alarm_global_settings = {};
          decoded.alarm_global_settings.interval       = u16(bytes, i); i += 2;
          decoded.alarm_global_settings.times          = u16(bytes, i); i += 2;
          decoded.alarm_global_settings.release_enable = u8(bytes, i++);
          break;
        }

        case 0xb6: decoded.reconnect = 1; break;
        case 0xb7: { if (!decoded.set_time) decoded.set_time = {}; decoded.set_time.timestamp = u32(bytes, i); i += 4; break; }
        case 0xb8: decoded.synchronize_time = 1; break;
        case 0xb9: decoded.query_device_status = 1; break;
        case 0xbe: decoded.reboot = 1; break;
        case 0xbf: decoded.reset  = 1; break;

        case 0xc5: { // data_storage_settings
          if (!decoded.data_storage_settings) decoded.data_storage_settings = {};
          const sub = u8(bytes, i++);
          if (sub === 0x00) decoded.data_storage_settings.enable                  = u8(bytes, i++);
          else if (sub === 0x01) decoded.data_storage_settings.retransmission_enable  = u8(bytes, i++);
          else if (sub === 0x02) { decoded.data_storage_settings.retransmission_interval = u16(bytes, i); i += 2; }
          else if (sub === 0x03) { decoded.data_storage_settings.retrieval_interval      = u16(bytes, i); i += 2; }
          break;
        }

        case 0xc6: { // daylight_saving_time
          if (!decoded.daylight_saving_time) decoded.daylight_saving_time = {};
          const dst = decoded.daylight_saving_time;
          dst.enable                       = u8(bytes, i++);
          dst.daylight_saving_time_offset  = u8(bytes, i++);
          dst.start_month                  = u8(bytes, i++);
          const sb = u8(bytes, i++);
          dst.start_week_num = sb >> 4;
          dst.start_week_day = sb & 0x0f;
          dst.start_hour_min = u16(bytes, i); i += 2;
          dst.end_month      = u8(bytes, i++);
          const eb = u8(bytes, i++);
          dst.end_week_num   = eb >> 4;
          dst.end_week_day   = eb & 0x0f;
          dst.end_hour_min   = u16(bytes, i); i += 2;
          break;
        }

        case 0xc7: // time_zone: int16LE minutes (UTC+8=480)
          decoded.time_zone = i16(bytes, i); i += 2;
          break;

        case 0x5b: { // retrieve_historical_data_by_time
          if (!decoded.retrieve_historical_data_by_time) decoded.retrieve_historical_data_by_time = {};
          decoded.retrieve_historical_data_by_time.type = u8(bytes, i++);
          decoded.retrieve_historical_data_by_time.time = u32(bytes, i); i += 4;
          break;
        }

        case 0x5c: { // retrieve_historical_data_by_time_range
          if (!decoded.retrieve_historical_data_by_time_range) decoded.retrieve_historical_data_by_time_range = {};
          decoded.retrieve_historical_data_by_time_range.type       = u8(bytes, i++);
          decoded.retrieve_historical_data_by_time_range.start_time = u32(bytes, i); i += 4;
          decoded.retrieve_historical_data_by_time_range.end_time   = u32(bytes, i); i += 4;
          break;
        }

        case 0x5d: { // stop_historical_data_retrieval
          if (!decoded.stop_historical_data_retrieval) decoded.stop_historical_data_retrieval = {};
          decoded.stop_historical_data_retrieval.type = u8(bytes, i++);
          break;
        }

        case 0x5e: { // clear_data
          if (!decoded.clear_data) decoded.clear_data = {};
          decoded.clear_data.type = u8(bytes, i++);
          break;
        }

        case 0x5f: { // reset_energy
          if (!decoded.reset_energy) decoded.reset_energy = {};
          decoded.reset_energy.channel = u8(bytes, i++);
          break;
        }

        case 0x57: decoded.query_history_set = 1; break;

        default:
          // Unknown command — stop parsing
          i = bytes.length;
          break;
      }
    }

    // Merge final decoded into result
    if (history.length > 0) {
      result.history = history;
    } else {
      Object.assign(result, decoded);
    }

    return result as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':              bytes = [0xbe]; break;
      case 'reset':               bytes = [0xbf]; break;
      case 'query_device_status': bytes = [0xb9]; break;
      case 'synchronize_time':    bytes = [0xb8]; break;
      case 'reconnect':           bytes = [0xb6]; break;
      case 'query_history_set':   bytes = [0x57]; break;
      case 'request_query_all_configurations': bytes = [0xee]; break;

      case 'set_time':
        bytes = [0xb7, ...wu32(params.timestamp ?? 0)]; break;

      case 'set_time_zone': {
        // CTH01 uses minutes: UTC+8 = 480
        const tz = params.time_zone ?? 0;
        bytes = [0xc7, ...wi16(tz)]; break;
      }

      case 'set_collection_interval': {
        const unit = params.unit ?? 1;
        const val  = unit === 0 ? (params.seconds_of_time ?? 30) : (params.minutes_of_time ?? 1);
        bytes = [0x60, unit & 0xff, ...wu16(val)]; break;
      }

      case 'set_reporting_interval': {
        const unit = params.unit ?? 1;
        const val  = unit === 0 ? (params.seconds_of_time ?? 600) : (params.minutes_of_time ?? 10);
        bytes = [0x61, unit & 0xff, ...wu16(val)]; break;
      }

      case 'set_temperature_unit':
        bytes = [0x63, params.unit ?? 0]; break;

      case 'set_voltage_interface':
        bytes = [0x66, params.interface ?? 0]; break;

      case 'set_device_status':
        bytes = [0xc8, params.status ?? 1]; break;

      case 'set_temperature_calibration': {
        const val = Math.round((params.calibration_value ?? 0) * 100);
        bytes = [0x6b, params.enable ?? 0, ...wi16(val)]; break;
      }

      case 'set_temperature_alarm_settings': {
        const min = Math.round((params.threshold_min ?? 0) * 100);
        const max = Math.round((params.threshold_max ?? 0) * 100);
        bytes = [0x76, params.enable ?? 0, params.threshold_condition ?? 2, ...wi16(min), ...wi16(max)]; break;
      }

      case 'set_current_alarm_settings': {
        bytes = [
          0x77, params.channel ?? 0, params.enable ?? 0, params.threshold_condition ?? 2,
          ...wi16(params.threshold_min ?? 0), ...wi16(params.threshold_max ?? 0),
        ]; break;
      }

      case 'set_voltage_alarm_settings': {
        bytes = [
          0x78, params.channel ?? 0, params.enable ?? 0, params.threshold_condition ?? 2,
          ...wi16(params.threshold_min ?? 0), ...wi16(params.threshold_max ?? 0),
        ]; break;
      }

      case 'set_thdi_alarm_settings': {
        bytes = [
          0x79, params.channel ?? 0, params.enable ?? 0, params.threshold_condition ?? 2,
          ...wi16(params.threshold_min ?? 0), ...wi16(params.threshold_max ?? 8),
        ]; break;
      }

      case 'set_thdv_alarm_settings': {
        bytes = [
          0x7a, params.channel ?? 0, params.enable ?? 0, params.threshold_condition ?? 2,
          ...wi16(params.threshold_min ?? 0), ...wi16(params.threshold_max ?? 5),
        ]; break;
      }

      case 'set_voltage_unbalance_alarm_settings': {
        bytes = [
          0x7b, params.enable ?? 0, params.threshold_condition ?? 2,
          ...wi16(params.threshold_min ?? 1), ...wi16(params.threshold_max ?? 3),
        ]; break;
      }

      case 'set_alarm_global_settings': {
        bytes = [0x7c, ...wu16(params.interval ?? 5), ...wu16(params.times ?? 3), params.release_enable ?? 0]; break;
      }

      case 'set_month_statistics_settings': {
        bytes = [0x6d, params.day ?? 1, params.hour ?? 0, params.minute ?? 0]; break;
      }

      case 'set_report_enable': {
        const p = params;
        let bits = 0;
        bits |= ((p.temperature              ?? 1) & 1) << 0;
        bits |= ((p.current                  ?? 0) & 1) << 1;
        bits |= ((p.voltage                  ?? 0) & 1) << 2;
        bits |= ((p.power_factor             ?? 1) & 1) << 3;
        bits |= ((p.active_power             ?? 1) & 1) << 4;
        bits |= ((p.reactive_power           ?? 0) & 1) << 5;
        bits |= ((p.apparent_power           ?? 0) & 1) << 6;
        bits |= ((p.forward_active_energy    ?? 1) & 1) << 7;
        bits |= ((p.reverse_active_energy    ?? 0) & 1) << 8;
        bits |= ((p.forward_reactive_energy  ?? 0) & 1) << 9;
        bits |= ((p.reverse_reactive_energy  ?? 0) & 1) << 10;
        bits |= ((p.apparent_energy          ?? 0) & 1) << 11;
        bits |= ((p.thdi                     ?? 0) & 1) << 12;
        bits |= ((p.thdv                     ?? 0) & 1) << 13;
        bits |= ((p.voltage_unbalance        ?? 0) & 1) << 14;
        bytes = [0x6c, ...wu16(bits)]; break;
      }

      case 'set_data_storage': {
        if ('enable' in params)
          bytes = [0xc5, 0x00, params.enable & 0xff];
        else if ('retransmission_enable' in params)
          bytes = [0xc5, 0x01, params.retransmission_enable & 0xff];
        else if ('retransmission_interval' in params)
          bytes = [0xc5, 0x02, ...wu16(params.retransmission_interval)];
        else if ('retrieval_interval' in params)
          bytes = [0xc5, 0x03, ...wu16(params.retrieval_interval)];
        else throw new Error('set_data_storage: unknown sub-command');
        break;
      }

      case 'set_daylight_saving_time': {
        const d = params;
        const sb = (((d.start_week_num ?? 1) & 0x0f) << 4) | ((d.start_week_day ?? 1) & 0x0f);
        const eb = (((d.end_week_num   ?? 1) & 0x0f) << 4) | ((d.end_week_day   ?? 1) & 0x0f);
        bytes = [
          0xc6, d.enable ?? 0, d.daylight_saving_time_offset ?? 60,
          d.start_month ?? 3, sb, ...wu16(d.start_hour_min ?? 120),
          d.end_month ?? 10,   eb, ...wu16(d.end_hour_min ?? 180),
        ]; break;
      }

      case 'retrieve_historical_data_by_time':
        bytes = [0x5b, params.type ?? 1, ...wu32(params.time ?? 0)]; break;

      case 'retrieve_historical_data_by_time_range':
        bytes = [0x5c, params.type ?? 1, ...wu32(params.start_time ?? 0), ...wu32(params.end_time ?? 0)]; break;

      case 'stop_historical_data_retrieval':
        bytes = [0x5d, params.type ?? 1]; break;

      case 'clear_data':
        bytes = [0x5e, params.type ?? 0]; break;

      case 'reset_energy':
        bytes = [0x5f, params.channel ?? 0]; break;

      case 'set_bluetooth_name': {
        const name = (params.content ?? '').slice(0, 13);
        const nameBytes = Array.from(name as string).map((c: string) => c.charCodeAt(0));
        bytes = [0x64, nameBytes.length, ...nameBytes]; break;
      }

      case 'set_current_interface': {
        const ifCmd = 0x66 + (params.interface ?? 1); // 1-4
        const configBytes: number[] = [];
        for (const cfg of (params.config ?? [])) {
          configBytes.push(cfg.direction ?? 0, ...wu16(cfg.range ?? 0));
        }
        bytes = [ifCmd, params.type ?? 0, ...configBytes]; break;
      }

      case 'set_lorawan_version':
        bytes = [0xcf, 0xd8, params.version ?? 2]; break;

      case 'request_check_sequence_number':
        bytes = [0xff, params.sequence_number ?? 0]; break;

      case 'request_check_order':
        bytes = [0xfe, params.order ?? 0]; break;

      default:
        throw new Error(`CTH01: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // CTH01 uses single-byte command IDs, not two-byte channel_id+type.
  // Strong fingerprints: 0x03 (THDi, 25B) or 0x05 (current, 37B) at byte 0.
  // Also: 0x08-0x0F energy channels are exclusive to CTH01.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;
    const first = bytes[0];
    // CTH01-exclusive channel IDs at position 0
    if (first === 0x03 || first === 0x05 || first === 0x40) return true;
    // Energy/power channels are exclusive to CTH01
    if (first >= 0x08 && first <= 0x17) return true;
    // Alarm channels exclusive to CTH01
    if (first >= 0x30 && first <= 0x36) return true;
    return false;
  }
}