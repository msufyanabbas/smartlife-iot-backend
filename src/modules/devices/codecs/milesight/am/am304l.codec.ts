// src/modules/devices/codecs/milesight/am304l.codec.ts
/**
 * Milesight AM304L Codec
 * Ambience Monitoring Sensor — Temperature + Humidity + PIR + Illuminance
 *
 * Key differences from AM10x series:
 *   - COMPLETELY DIFFERENT protocol: command-dispatch architecture (not IPSO channel+type walk)
 *   - PIR: 0x05 0x9F — uint16 where bit15=pir_status, bits[0:14]=pir_count
 *   - PIR status change event: 0x05 0x00
 *   - Illuminance LEVEL: 0x06 0xCB (0–5 scale)
 *   - Illuminance VALUE: 0x06 0x9D (uint16 lx)
 *   - SN: 0xFF 0x16, 8 bytes
 *   - Reporting interval: 0xF9 0xBD (unit byte + uint16)
 *   - Alarm events: 0x83 0x67 (temp alarm), 0x86 0x9D (lux alarm)
 *   - Historical data: 0x20 0xCE (level mode), 0x21 0xCE (lux mode)
 *   - D2D master/sending configuration channels
 *
 * Telemetry fields:
 *   - battery / batteryLevel (%)
 *   - temperature (°C, int16/10)
 *   - humidity (%, uint8/2)
 *   - pir: { pir_status: 0|1, pir_count: uint15 }
 *   - pir_status_change: { status: 0|1 }
 *   - als_level (0–5 illuminance level)
 *   - lux (uint16 lx)
 *   - temperature_alarm: { temperature, alarm_type }
 *   - lux_alarm: { lux, alarm_type }
 *
 * Based on official Milesight AM304L decoder v1.0.0
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ───────────────────────────────────────────────────────────────

function u8(bytes: number[], i: number): number  { return bytes[i] & 0xff; }
function u16le(bytes: number[], i: number): number { return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff; }
function i16le(bytes: number[], i: number): number {
  const v = u16le(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}
function u32le(bytes: number[], i: number): number {
  return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
}
function hexStr(bytes: number[], i: number, len: number): string {
  return bytes.slice(i, i + len).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

export class MilesightAM304LCodec extends BaseDeviceCodec {
  readonly codecId: string = 'milesight-am304l';
  readonly manufacturer: string = 'Milesight';
  readonly supportedModels: string[] = ['AM304L', 'AM304'];
  readonly protocol: 'lorawan' = 'lorawan';
  readonly category: string = 'Ambience Monitoring';
  readonly modelFamily: string = 'AM304L';
  readonly imageUrl: string = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/am-series/am304l/am300l.png';

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];

      switch (ch) {

        // ── 0xFF — config / attribute / command-response ──────────────────
        case 0xff: {
          const ty = bytes[i++];
          switch (ty) {
            case 0x0b: decoded.device_status   = u8(bytes, i++) === 1 ? 'on' : 'off'; break;
            case 0x01: decoded.ipso_version     = u8(bytes, i++); break;
            case 0x16:
              decoded.sn = hexStr(bytes, i, 8);
              i += 8;
              break;
            case 0xff:
              decoded.tsl_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`;
              i += 2;
              break;
            case 0xfe: decoded.request_tsl_config = u8(bytes, i++); break;
            case 0x09:
              decoded.hardware_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`;
              i += 2;
              break;
            case 0x0a:
              decoded.firmware_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`;
              i += 2;
              break;
            case 0x0f: decoded.lorawan_class = u8(bytes, i++); break;

            case 0xf2: decoded.alarm_reporting_times      = u16le(bytes, i); i += 2; break;
            case 0xf5: decoded.alarm_deactivation_enable  = u8(bytes, i++); break;
            case 0x2e: decoded.led_mode                   = u8(bytes, i++); break;

            case 0x25: {
              const bits = u8(bytes, i++);
              decoded.button_lock = { power_off: bits & 0x01, power_on: (bits >> 1) & 0x01 };
              break;
            }

            case 0x06: {
              const bits = u8(bytes, i++);
              const condMap: Record<number, string> = { 1: 'x<A', 2: 'x>B', 3: 'A<x<B', 4: 'x<A or x>B' };
              decoded.temperature_alarm_rule = {
                enable:        (bits >> 6) & 0x01,
                condition:     condMap[bits & 0x07] ?? 'unknown',
                id:            (bits >> 3) & 0x07,
                threshold_max: i16le(bytes, i)     / 10,
                threshold_min: i16le(bytes, i + 2) / 10,
                threshold_lock_time:     u16le(bytes, i + 4),
                threshold_continue_time: u16le(bytes, i + 6),
              };
              i += 8;
              break;
            }

            case 0x18: {
              // Sensor enable — fixed_value tells which sensor
              const sensorId = u8(bytes, i++);
              const bits     = u8(bytes, i++);
              if (sensorId === 3) decoded.pir_enable                  = { enable: (bits >> 2) & 0x01 };
              if (sensorId === 4) decoded.illuminance_collecting_enable = { enable: (bits >> 3) & 0x01 };
              break;
            }

            case 0x95: decoded.pir_idle_interval = u16le(bytes, i); i += 2; break;

            case 0xea: {
              const bits = u8(bytes, i++);
              const id   = bits & 0x7f;
              const en   = (bits >> 7) & 0x01;
              if (id === 0) {
                decoded.temperature_calibration_settings = { enable: en, value: i16le(bytes, i) / 10 };
              } else if (id === 1) {
                decoded.humidity_calibration_settings = { enable: en, value: i16le(bytes, i) / 2 };
              }
              i += 2;
              break;
            }

            case 0x96: {
              const trigCond = u8(bytes, i++);
              const item: Record<string, any> = {
                trigger_condition:   trigCond,
                enable:              u8(bytes, i++),
                lora_uplink_enable:  u8(bytes, i++),
                control_command:     hexStr(bytes, i, 2),
                control_time_enable: u8(bytes, i + 2),
                control_time:        u16le(bytes, i + 3),
              };
              i += 5;
              if (!decoded.d2d_master_settings) decoded.d2d_master_settings = [];
              (decoded.d2d_master_settings as any[]).push(item);
              break;
            }

            case 0x68: decoded.data_storage_enable   = { enable: u8(bytes, i++) }; break;
            case 0x69: decoded.retransmission_enable  = { enable: u8(bytes, i++) }; break;

            case 0x6a: {
              const type = u8(bytes, i++);
              const val  = u16le(bytes, i); i += 2;
              if (type === 0) decoded.retransmission_interval = { interval: val };
              else            decoded.retrival_interval       = { interval: val };
              break;
            }

            case 0x27: decoded.clear_historical_data = u8(bytes, i++); break;
            case 0x10: decoded.reboot                = u8(bytes, i++); break;
            case 0x4a: decoded.synchronize_time      = u8(bytes, i++); break;

            default: i++; break; // unknown — skip 1 byte
          }
          break;
        }

        // ── 0x01 — battery ────────────────────────────────────────────────
        case 0x01: {
          const ty = bytes[i++];
          if (ty === 0x75) {
            decoded.battery      = u8(bytes, i++);
            decoded.batteryLevel = decoded.battery as number;
          }
          break;
        }

        // ── 0x03 — temperature ────────────────────────────────────────────
        case 0x03: {
          const ty = bytes[i++];
          if (ty === 0x67) { decoded.temperature = i16le(bytes, i) / 10; i += 2; }
          break;
        }

        // ── 0x04 — humidity ───────────────────────────────────────────────
        case 0x04: {
          const ty = bytes[i++];
          if (ty === 0x68) { decoded.humidity = u8(bytes, i++) / 2; }
          break;
        }

        // ── 0x05 — PIR ────────────────────────────────────────────────────
        case 0x05: {
          const ty = bytes[i++];
          if (ty === 0x9f) {
            const raw = u16le(bytes, i); i += 2;
            decoded.pir = {
              pir_status: (raw >> 15) & 0x01,        // bit 15
              pir_count:   raw & 0x7fff,              // bits [0:14]
            };
          } else if (ty === 0x00) {
            decoded.pir_status_change = { status: u8(bytes, i++) };
            // Mirror to pir.pir_status for convenience
            if (!decoded.pir) decoded.pir = { pir_status: 0, pir_count: 0 };
            (decoded.pir as any).pir_status = (decoded.pir_status_change as any).status;
          }
          break;
        }

        // ── 0x06 — illuminance ────────────────────────────────────────────
        case 0x06: {
          const ty = bytes[i++];
          if      (ty === 0xcb) { decoded.als_level = u8(bytes, i++); }
          else if (ty === 0x9d) { decoded.lux = u16le(bytes, i); i += 2; }
          break;
        }

        // ── Anomaly channels ──────────────────────────────────────────────
        case 0xb3: {
          const ty = bytes[i++];
          if (ty === 0x67) decoded.temperature_collection_anomaly = { type: u8(bytes, i++) };
          break;
        }
        case 0xb4: {
          const ty = bytes[i++];
          if (ty === 0x68) decoded.humidity_collection_anomaly = { type: u8(bytes, i++) };
          break;
        }
        case 0xb6: {
          const ty = bytes[i++];
          if      (ty === 0xcb) decoded.illuminace_collection_anomaly = { type: u8(bytes, i++) };
          else if (ty === 0x9d) decoded.lux_collection_anomaly        = { type: u8(bytes, i++) };
          break;
        }

        // ── Alarm events ──────────────────────────────────────────────────
        case 0x83: {
          const ty = bytes[i++];
          if (ty === 0x67) {
            const temp     = i16le(bytes, i) / 10;
            const alarmType = u8(bytes, i + 2);
            decoded.temperature_alarm = { temperature: temp, alarm_type: alarmType };
            decoded.temperature = temp; // also update main temperature field
            i += 3;
          }
          break;
        }
        case 0x86: {
          const ty = bytes[i++];
          if (ty === 0x9d) {
            const luxVal   = u16le(bytes, i);
            const alarmType = u8(bytes, i + 2);
            decoded.lux_alarm = { lux: luxVal, alarm_type: alarmType };
            decoded.lux = luxVal;
            i += 3;
          }
          break;
        }

        // ── Historical data (level mode) — 0x20 0xCE ─────────────────────
        case 0x20: {
          const ty = bytes[i++];
          if (ty === 0xce) {
            const rec: Record<string, any> = {
              timestamp:        u32le(bytes, i),
              temperature_type: u8(bytes, i + 4),
              temperature:      i16le(bytes, i + 5) / 10,
              humidity_type:    u8(bytes, i + 7),
              humidity:         u8(bytes, i + 8) / 2,
            };
            const pirBits    = u8(bytes, i + 9);
            rec.pir_type     = (pirBits >> 6) & 0x01;
            rec.pir_status   =  pirBits & 0x3f;
            rec.pir_count    = u16le(bytes, i + 10);
            rec.als_level_type = u8(bytes, i + 12);
            rec.als_level      = u16le(bytes, i + 13);
            i += 15;
            if (!decoded.historical_data) decoded.historical_data = [];
            (decoded.historical_data as any[]).push(rec);
          }
          break;
        }

        // ── Historical data (lux mode) — 0x21 0xCE ───────────────────────
        case 0x21: {
          const ty = bytes[i++];
          if (ty === 0xce) {
            const rec: Record<string, any> = {
              timestamp:        u32le(bytes, i),
              temperature_type: u8(bytes, i + 4),
              temperature:      i16le(bytes, i + 5) / 10,
              humidity_type:    u8(bytes, i + 7),
              humidity:         u8(bytes, i + 8) / 2,
            };
            const pirBits    = u8(bytes, i + 9);
            rec.pir_type     = (pirBits >> 6) & 0x01;
            rec.pir_status   =  pirBits & 0x3f;
            rec.pir_count    = u16le(bytes, i + 10);
            rec.lux_type     = u8(bytes, i + 12);
            rec.lux          = u16le(bytes, i + 13);
            i += 15;
            if (!decoded.historical_data_lux) decoded.historical_data_lux = [];
            (decoded.historical_data_lux as any[]).push(rec);
          }
          break;
        }

        // ── 0xF9 — config blocks ──────────────────────────────────────────
        case 0xf9: {
          const ty = bytes[i++];
          switch (ty) {
            case 0xbd:
              decoded.reporting_interval = { unit: u8(bytes, i++), interval: u16le(bytes, i) };
              i += 2;
              break;
            case 0xbe:
              decoded.collecting_interval = { id: u8(bytes, i++), unit: u8(bytes, i++), interval: u16le(bytes, i) };
              i += 2;
              break;
            case 0xc0: {
              const sensorId = u8(bytes, i++);
              const val      = u8(bytes, i++);
              if (sensorId === 0) decoded.temperature_unit = { unit: val };
              else                decoded.illuminance_mode = { mode: val };
              break;
            }
            case 0xbc: {
              const type = u8(bytes, i++);
              const en   = u8(bytes, i++);
              if (type === 0) decoded.pir_trigger_report = { enable: en };
              else            decoded.pir_idle_report    = { enable: en };
              break;
            }
            case 0xbf:
              decoded.illuminance_alarm_rule = {
                enable:       u8(bytes, i++),
                dim_value:    u16le(bytes, i),
                bright_value: u16le(bytes, i + 2),
              };
              i += 4;
              break;
            case 0x63: {
              const en    = u8(bytes, i++);
              const loraEn = u8(bytes, i++);
              const bits  = u16le(bytes, i); i += 2;
              decoded.d2d_sending = {
                enable:             en,
                lora_uplink_enable: loraEn,
                temperature_enable: bits & 0x01,
                humidity_enable:    (bits >> 1) & 0x01,
              };
              break;
            }
            case 0x66: decoded.d2d_master_enable = u8(bytes, i++); break;
            default: i++; break;
          }
          break;
        }

        // ── 0xFD — historical data retrieval commands ─────────────────────
        case 0xfd: {
          const ty = bytes[i++];
          if      (ty === 0x6b) { decoded.retrival_historical_data_by_time = { time: u32le(bytes, i) }; i += 4; }
          else if (ty === 0x6c) { decoded.retrival_historical_data_by_time_range = { start_time: u32le(bytes, i), end_time: u32le(bytes, i + 4) }; i += 8; }
          else if (ty === 0x6d) { decoded.stop_historical_data_retrival = u8(bytes, i++); }
          break;
        }

        default:
          // Unknown command byte — stop to avoid garbage
          i = bytes.length;
          break;
      }
    }

    return decoded;
  }

  
  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'AM304L',
    description:  'Ambience Monitoring Sensor — Temperature, Humidity, PIR, and Illuminance',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',             type: 'number' as const, unit: '%'  },
      { key: 'temperature', label: 'Temperature',         type: 'number' as const, unit: '°C' },
      { key: 'humidity',    label: 'Humidity',            type: 'number' as const, unit: '%'  },
      { key: 'als_level',   label: 'Illuminance Level',   type: 'number' as const             },
      { key: 'lux',         label: 'Illuminance',         type: 'number' as const, unit: 'lx' },
      // pir is an object: { pir_status, pir_count }
      { key: 'pir',         label: 'PIR',                 type: 'string' as const             },
    ],
    commands: [
      { type: 'reboot',                 label: 'Reboot Device',          params: [] },
      { type: 'clear_historical_data',  label: 'Clear Historical Data',  params: [] },
      { type: 'synchronize_time',       label: 'Synchronize Time',       params: [] },
      {
        type:   'set_reporting_interval',
        label:  'Set Reporting Interval',
        params: [{ key: 'interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 1440 }],
      },
      {
        type:   'set_collecting_interval',
        label:  'Set Collecting Interval',
        params: [{ key: 'interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 1440 }],
      },
      {
        type:   'set_led_mode',
        label:  'Set LED Mode',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_pir_enable',
        label:  'Set PIR Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_pir_idle_interval',
        label:  'Set PIR Idle Interval',
        params: [{ key: 'seconds', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 120, min: 60, max: 3600 }],
      },
      {
        type:   'set_pir_trigger_report',
        label:  'Set PIR Trigger Report',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_illuminance_collecting',
        label:  'Set Illuminance Collecting',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_illuminance_alarm',
        label:  'Set Illuminance Alarm',
        params: [
          { key: 'enable',       label: 'Enable',                  type: 'boolean' as const, required: true  },
          { key: 'dim_value',    label: 'Dim Threshold (lx)',       type: 'number'  as const, required: false, default: 300 },
          { key: 'bright_value', label: 'Bright Threshold (lx)',    type: 'number'  as const, required: false, default: 700 },
        ],
      },
      {
        type:   'set_temperature_alarm',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'enable',        label: 'Enable',              type: 'boolean' as const, required: true  },
          { key: 'condition',     label: 'Condition',           type: 'select'  as const, required: true,  options: [{ label: 'x<A', value: 'x<A' }, { label: 'x>B', value: 'x>B' }, { label: 'A<x<B', value: 'A<x<B' }, { label: 'x<A or x>B', value: 'x<A or x>B' }] },
          { key: 'threshold_min', label: 'Min Threshold (°C)',  type: 'number'  as const, required: false, default: 0  },
          { key: 'threshold_max', label: 'Max Threshold (°C)',  type: 'number'  as const, required: false, default: 40 },
        ],
      },
      {
        type:   'set_data_storage',
        label:  'Set Data Storage',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmission',
        label:  'Set Retransmission',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'fetch_history_by_time',
        label:  'Fetch History by Time',
        params: [{ key: 'time', label: 'Time (Unix)', type: 'number' as const, required: true }],
      },
      {
        type:   'fetch_history_by_range',
        label:  'Fetch History by Range',
        params: [
          { key: 'start_time', label: 'Start Time (Unix)', type: 'number' as const, required: true },
          { key: 'end_time',   label: 'End Time (Unix)',   type: 'number' as const, required: true },
        ],
      },
      {
        type:   'stop_history_retrival',
        label:  'Stop History Retrieval',
        params: [],
      },
    ],
    uiComponents: [
      { type: 'gauge' as const, label: 'Battery',           keys: ['battery'],     unit: '%'  },
      { type: 'value' as const, label: 'Temperature',       keys: ['temperature'], unit: '°C' },
      { type: 'value' as const, label: 'Humidity',          keys: ['humidity'],    unit: '%'  },
      { type: 'value' as const, label: 'Illuminance Level', keys: ['als_level']               },
      { type: 'value' as const, label: 'Illuminance',       keys: ['lux'],         unit: 'lx' },
      { type: 'value' as const, label: 'PIR',               keys: ['pir']                     },
    ],
  };
}

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    const p = command.params ?? {};

    switch (command.type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_reporting_interval': {
        // interval in minutes (unit=1), range 1–1440
        const v = p.interval ?? 10;
        if (v < 1 || v > 1440) throw new Error('reporting interval must be 1–1440 min');
        bytes = [0xf9, 0xbd, 0x01, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_collecting_interval': {
        const v = p.interval ?? 10;
        if (v < 1 || v > 1440) throw new Error('collecting interval must be 1–1440 min');
        // id=0 means temp/humidity collect interval, unit=1 (minutes)
        bytes = [0xf9, 0xbe, 0x00, 0x01, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_led_mode':
        bytes = [0xff, 0x2e, p.enable ? 2 : 0];
        break;

      case 'set_pir_enable':
        // sensor_id=3 for PIR, bit2 = enable
        bytes = [0xff, 0x18, 0x03, p.enable ? 0x04 : 0x00];
        break;

      case 'set_illuminance_collecting':
        // sensor_id=4 for illuminance, bit3 = enable
        bytes = [0xff, 0x18, 0x04, p.enable ? 0x08 : 0x00];
        break;

      case 'set_pir_idle_interval': {
        const v = p.seconds ?? 120;
        if (v < 60 || v > 3600) throw new Error('pir_idle_interval must be 60–3600 s');
        bytes = [0xff, 0x95, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_pir_trigger_report':
        bytes = [0xf9, 0xbc, 0x00, p.enable ? 1 : 0];
        break;

      case 'set_pir_idle_report':
        bytes = [0xf9, 0xbc, 0x01, p.enable ? 1 : 0];
        break;

      case 'set_temperature_alarm': {
        const condMap: Record<string, number> = { 'x<A': 1, 'x>B': 2, 'A<x<B': 3, 'x<A or x>B': 4 };
        const cond  = condMap[p.condition ?? 'x>B'] ?? 2;
        const bits  = (p.enable ? 1 : 0) << 6 | (1 << 3) | cond;
        const maxR  = Math.round((p.threshold_max ?? 40) * 10);
        const minR  = Math.round((p.threshold_min ?? 0) * 10);
        const maxLE = maxR < 0 ? maxR + 0x10000 : maxR;
        const minLE = minR < 0 ? minR + 0x10000 : minR;
        bytes = [0xff, 0x06, bits,
          maxLE & 0xff, (maxLE >> 8) & 0xff,
          minLE & 0xff, (minLE >> 8) & 0xff,
          0, 0, 0, 0];
        break;
      }

      case 'set_illuminance_alarm': {
        const dimV    = p.dim_value    ?? 300;
        const brightV = p.bright_value ?? 700;
        bytes = [0xf9, 0xbf, p.enable ? 1 : 0,
          dimV    & 0xff, (dimV    >> 8) & 0xff,
          brightV & 0xff, (brightV >> 8) & 0xff];
        break;
      }

      case 'set_alarm_reporting_times': {
        const v = p.times ?? 1;
        if (v < 1 || v > 1000) throw new Error('alarm_reporting_times must be 1–1000');
        bytes = [0xff, 0xf2, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_alarm_deactivation':
        bytes = [0xff, 0xf5, p.enable ? 1 : 0];
        break;

      case 'set_temperature_calibration': {
        const val = Math.round((p.value ?? 0) * 10);
        const valLE = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xea, (p.enable ? 1 << 7 : 0) | 0, valLE & 0xff, (valLE >> 8) & 0xff];
        break;
      }

      case 'set_humidity_calibration': {
        const val = Math.round((p.value ?? 0) * 2);
        const valLE = val < 0 ? val + 0x10000 : val;
        bytes = [0xff, 0xea, (p.enable ? 1 << 7 : 0) | 1, valLE & 0xff, (valLE >> 8) & 0xff];
        break;
      }

      case 'set_data_storage':
        bytes = [0xff, 0x68, p.enable ? 1 : 0];
        break;

      case 'set_retransmission':
        bytes = [0xff, 0x69, p.enable ? 1 : 0];
        break;

      case 'set_retransmission_interval': {
        const v = p.seconds ?? 600;
        if (v < 30 || v > 1200) throw new Error('retransmission_interval must be 30–1200 s');
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_retrival_interval': {
        const v = p.seconds ?? 60;
        if (v < 30 || v > 1200) throw new Error('retrival_interval must be 30–1200 s');
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'clear_historical_data':
        bytes = [0xff, 0x27, 0x01];
        break;

      case 'fetch_history_by_time': {
        const ts = p.time ?? 0;
        bytes = [0xfd, 0x6b, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff];
        break;
      }

      case 'fetch_history_by_range': {
        const s = p.start_time ?? 0;
        const e = p.end_time   ?? 0;
        bytes = [0xfd, 0x6c,
          s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, (s >> 24) & 0xff,
          e & 0xff, (e >> 8) & 0xff, (e >> 16) & 0xff, (e >> 24) & 0xff];
        break;
      }

      case 'stop_history_retrival':
        bytes = [0xfd, 0x6d, 0xff];
        break;

      case 'synchronize_time':
        bytes = [0xff, 0x4a, 0x00];
        break;

      default:
        throw new Error(`AM304L: unsupported command "${command.type}"`);
    }

    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // AM304L is uniquely identified by:
  //   - PIR channel with packed uint16: 0x05 0x9F
  //   - Illuminance LEVEL channel: 0x06 0xCB
  //   - Reporting interval channel: 0xF9 0xBD
  // None of these appear in AM10x series.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x05 && ty === 0x9f) return true; // PIR packed uint16 — AM304L unique
      if (ch === 0x06 && ty === 0xcb) return true; // ALS level — AM304L unique
      if (ch === 0xf9 && ty === 0xbd) return true; // Reporting interval with unit byte

      // Skip known single-byte channels to keep walking
      if (ch === 0x01 && ty === 0x75) { i += 3; continue; }
      if (ch === 0x03 && ty === 0x67) { i += 4; continue; }
      if (ch === 0x04 && ty === 0x68) { i += 3; continue; }
      if (ch === 0xff && ty === 0x0b) { i += 3; continue; }
      if (ch === 0xff && ty === 0x01) { i += 3; continue; }

      break;
    }

    return false;
  }
}