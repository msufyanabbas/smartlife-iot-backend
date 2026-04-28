// src/modules/devices/codecs/milesight/wt/wt303.codec.ts
// Milesight WT303 — Smart Thermostat (Fan Coil with Humidity)
//
// Wire protocol: FLAT COMMAND-ID
//   [cmd_id:1B][data:NB] ...  (multiple commands concatenated per frame)
//
// Temperature encoding: int16 LE / 100 = °C  (e.g. 2800 → 28.00°C)
// Humidity encoding:    uint16 LE / 10 = %rH (e.g. 650 → 65.0%)
//
// The decoder mirrors the reference decoder exactly, including:
//   - All nested sub-command fields (0x8c, 0x7b, 0x87, 0x89, 0x8b, etc.)
//   - Array-typed fields with pick/insert semantics
//   - processTemperature: adds celsius_* and fahrenheit_* aliases on all
//     temperature leaf fields before returning decoded result

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Low-level read helpers (offset-based, matching project convention) ────────

function readUInt8(bytes: number[], i: number): number {
  return bytes[i] & 0xff;
}

function readInt8(bytes: number[], i: number): number {
  const v = readUInt8(bytes, i);
  return v > 0x7f ? v - 0x100 : v;
}

function readUInt16LE(bytes: number[], i: number): number {
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

function readInt16LE(bytes: number[], i: number): number {
  const v = readUInt16LE(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function readUInt32LE(bytes: number[], i: number): number {
  return (
    ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0
  );
}

function readHexString(bytes: number[], i: number, len: number): string {
  return bytes
    .slice(i, i + len)
    .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

function readString(bytes: number[], i: number, len: number): string {
  const chunk = bytes.slice(i, i + len);
  let str = '';
  let j = 0;
  while (j < chunk.length) {
    const b1 = chunk[j++];
    if (b1 === 0) break;
    if (b1 <= 0x7f) {
      str += String.fromCharCode(b1);
    } else if (b1 <= 0xdf) {
      str += String.fromCharCode(((b1 & 0x1f) << 6) | (chunk[j++] & 0x3f));
    } else if (b1 <= 0xef) {
      const b2 = chunk[j++]; const b3 = chunk[j++];
      str += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = chunk[j++]; const b3 = chunk[j++]; const b4 = chunk[j++];
      const cp = (((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)) - 0x10000;
      str += String.fromCharCode((cp >> 10) + 0xd800);
      str += String.fromCharCode((cp & 0x3ff) + 0xdc00);
    }
  }
  return str.replace(/\u0000+$/, '');
}

function extractBits(value: number, startBit: number, endBit: number): number {
  const width = endBit - startBit;
  const mask = (1 << width) - 1;
  return (value >>> startBit) & mask;
}

// ── Array item helpers (match reference pick/insert semantics) ────────────────

function pickArrayItem(array: any[], id: number, idName: string): any {
  for (const item of array) {
    if (item[idName] === id) return item;
  }
  return {};
}

function insertArrayItem(array: any[], item: any, idName: string): void {
  for (let i = 0; i < array.length; i++) {
    if (array[i][idName] === item[idName]) {
      array[i] = item;
      return;
    }
  }
  array.push(item);
}

// ── processTemperature: adds celsius_* and fahrenheit_* aliases ───────────────
// Mirrors the reference decoder's processTemperature exactly.
// For every known temperature leaf path in the decoded object, adds:
//   fahrenheit_<field> = value * 1.8 + 32  (precision 2)
//   celsius_<field>    = value              (precision 2)

const TEMPERATURE_PATHS = new Set([
  'temperature',
  'target_temperature',
  'temperature_alarm.lower_range_alarm_deactivation.temperature',
  'temperature_alarm.lower_range_alarm_trigger.temperature',
  'temperature_alarm.over_range_alarm_deactivation.temperature',
  'temperature_alarm.over_range_alarm_trigger.temperature',
  'temperature_alarm.within_range_alarm_deactivation.temperature',
  'temperature_alarm.within_range_alarm_trigger.temperature',
  'temperature_alarm.exceed_range_alarm_deactivation.temperature',
  'temperature_alarm.exceed_range_alarm_trigger.temperature',
  'temperature_alarm.persistent_low_temperature_alarm_deactivation.temperature',
  'temperature_alarm.persistent_low_temperature_alarm_trigger.temperature',
  'temperature_alarm.persistent_high_alarm_deactivation.temperature',
  'temperature_alarm.persistent_high_alarm_trigger.temperature',
  'temperature_alarm.anti_freeze_protection_deactivation.temperature',
  'temperature_alarm.anti_freeze_protection_trigger.temperature',
  'temperature_alarm.window_status_detection_deactivation.temperature',
  'temperature_alarm.window_status_detection_trigger.temperature',
  'heating_target_temperature',
  'cooling_target_temperature',
  'target_temperature_tolerance',
  'heating_target_temperature_range.min',
  'heating_target_temperature_range.max',
  'cooling_target_temperature_range.min',
  'cooling_target_temperature_range.max',
  'temperature_control_dehumidification.temperature_tolerance',
  'fan_auto_mode_temperature_range.speed_range_1',
  'fan_auto_mode_temperature_range.speed_range_2',
  'temperature_calibration_settings.calibration_value',
  'temperature_alarm_settings.threshold_min',
  'temperature_alarm_settings.threshold_max',
  'high_temperature_alarm_settings.difference_in_temperature',
  'low_temperature_alarm_settings.difference_in_temperature',
  'schedule_settings._item.content.heat_target_temperature',
  'schedule_settings._item.content.cool_target_temperature',
  'schedule_settings._item.content.temperature_tolerance',
  'window_opening_detection_settings.temperature_detection.difference_in_temperature',
  'freeze_protection_settings.target_temperature',
  'send_temperature.temperature',
]);

function getAllLeafPaths(obj: any, prefix = ''): string[] {
  const paths: string[] = [];
  function recurse(current: any, path: string) {
    if (Array.isArray(current)) {
      current.forEach((item, idx) => recurse(item, path ? `${path}.${idx}` : String(idx)));
    } else if (current !== null && typeof current === 'object') {
      for (const key of Object.keys(current)) {
        recurse(current[key], path ? `${path}.${key}` : key);
      }
    } else {
      paths.push(path);
    }
  }
  recurse(obj, prefix);
  return paths;
}

function getPath(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return null;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function normalizePath(path: string): string {
  // Replace numeric array indices with _item for lookup
  return path.split('.').map((p) => (/^\d+$/.test(p) ? '_item' : p)).join('.');
}

function processTemperature(decoded: any): void {
  const leafPaths = getAllLeafPaths(decoded);
  for (const propertyId of leafPaths) {
    const normalizedId = normalizePath(propertyId);
    if (!TEMPERATURE_PATHS.has(normalizedId)) continue;

    const value = getPath(decoded, propertyId);
    if (value == null || typeof value !== 'number') continue;

    // Derive the parent path and field name to build celsius_/fahrenheit_ siblings
    const parts = propertyId.split('.');
    const fieldName = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('.');

    const celsiusField   = parentPath ? `${parentPath}.celsius_${fieldName}`   : `celsius_${fieldName}`;
    const fahrenheitField = parentPath ? `${parentPath}.fahrenheit_${fieldName}` : `fahrenheit_${fieldName}`;

    setPath(decoded, celsiusField,    Number(value.toFixed(2)));
    setPath(decoded, fahrenheitField, Number((value * 1.8 + 32).toFixed(2)));
  }
}

// ── Version helpers ───────────────────────────────────────────────────────────

function readProtocolVersion(b0: number, b1: number): string {
  return `v${b0 & 0xff}.${b1 & 0xff}`;
}

function readHardwareVersion(b0: number, b1: number): string {
  return `v${b0 & 0xff}.${b1 & 0xff}`;
}

function readFirmwareVersion(bytes: number[], i: number): string {
  const major     = bytes[i]     & 0xff;
  const minor     = bytes[i + 1] & 0xff;
  const release   = bytes[i + 2] & 0xff;
  const alpha     = bytes[i + 3] & 0xff;
  const unit_test = bytes[i + 4] & 0xff;
  const test      = bytes[i + 5] & 0xff;
  let v = `v${major}.${minor}`;
  if (release   !== 0) v += `-r${release}`;
  if (alpha     !== 0) v += `-a${alpha}`;
  if (unit_test !== 0) v += `-u${unit_test}`;
  if (test      !== 0) v += `-t${test}`;
  return v;
}

// ── Encode helpers ────────────────────────────────────────────────────────────

function writeInt16LE(v: number): number[] {
  const u = v < 0 ? v + 0x10000 : v;
  return [u & 0xff, (u >> 8) & 0xff];
}

function writeUInt16LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}

function writeUInt32LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function hexToBytes(hex: string, len: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  while (bytes.length < len) bytes.push(0);
  return bytes.slice(0, len);
}

function stringToBytes(str: string, len: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  while (bytes.length < len) bytes.push(0);
  return bytes.slice(0, len);
}

// ── Main codec class ──────────────────────────────────────────────────────────

export class MilesightWT303Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-wt303';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WT303'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const cmd = bytes[i++];

      switch (cmd) {

        // ── 0xFE: check order reply ──────────────────────────────────────────
        case 0xfe:
          decoded.check_order_reply = decoded.check_order_reply ?? {};
          decoded.check_order_reply.order = readUInt8(bytes, i++);
          break;

        // ── 0xF4: full inspection reply ──────────────────────────────────────
        case 0xf4: {
          decoded.full_inspection_reply = decoded.full_inspection_reply ?? {};
          const sub = bytes[i++];
          if (sub === 0x00) {
            decoded.full_inspection_reply.start_inspection = { result: readUInt8(bytes, i++) };
          } else if (sub === 0x01) {
            decoded.full_inspection_reply.control = { result: readUInt8(bytes, i++) };
          } else if (sub === 0x02) {
            const len = readUInt16LE(bytes, i); i += 2;
            decoded.full_inspection_reply.reading = { length: len, data: bytes.slice(i, i + len) };
            i += len;
          } else if (sub === 0x03) {
            decoded.full_inspection_reply.end_inspection = { result: readUInt8(bytes, i++) };
          }
          break;
        }

        // ── 0xEF: command response ───────────────────────────────────────────
        case 0xef: {
          decoded.ans = decoded.ans ?? [];
          const bits   = readUInt8(bytes, i++);
          const result = extractBits(bits, 4, 8);
          const length = extractBits(bits, 0, 4);
          const idBytes = bytes.slice(i, i + length); i += length;
          const idHex   = idBytes.map((b) => ('0' + b.toString(16)).slice(-2)).join('');
          decoded.ans.push({ result, length, id: idHex });
          break;
        }

        // ── 0xEE: all configurations request by device ───────────────────────
        case 0xee:
          decoded.all_configurations_request_by_device = 1;
          break;

        // ── 0xCF: LoRaWAN configuration settings ─────────────────────────────
        case 0xcf: {
          decoded.lorawan_configuration_settings = decoded.lorawan_configuration_settings ?? {};
          const sub = bytes[i++];
          if (sub === 0x00) {
            decoded.lorawan_configuration_settings.mode = readUInt8(bytes, i++);
          }
          break;
        }

        // ── 0xDF: TSL version ────────────────────────────────────────────────
        case 0xdf:
          decoded.tsl_version = readProtocolVersion(bytes[i], bytes[i + 1]);
          i += 2;
          break;

        // ── 0xDB: product SN ─────────────────────────────────────────────────
        case 0xdb:
          decoded.product_sn = readHexString(bytes, i, 8);
          i += 8;
          break;

        // ── 0xDA: hardware + firmware version ────────────────────────────────
        case 0xda:
          decoded.version = {
            hardware_version: readHardwareVersion(bytes[i], bytes[i + 1]),
            firmware_version: readFirmwareVersion(bytes, i + 2),
          };
          i += 8; // 2B hw + 6B fw
          break;

        // ── 0xD9: OEM ID ─────────────────────────────────────────────────────
        case 0xd9:
          decoded.oem_id = readHexString(bytes, i, 2);
          i += 2;
          break;

        // ── 0x04: data source ────────────────────────────────────────────────
        case 0x04:
          decoded.data_source = readUInt8(bytes, i++);
          break;

        // ── 0x01: temperature ────────────────────────────────────────────────
        case 0x01:
          decoded.temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x02: humidity ───────────────────────────────────────────────────
        case 0x02:
          decoded.humidity = readUInt16LE(bytes, i) / 10;
          i += 2;
          break;

        // ── 0x03: target temperature ─────────────────────────────────────────
        case 0x03:
          decoded.target_temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x05: temperature control info ───────────────────────────────────
        case 0x05: {
          const bits = readUInt8(bytes, i++);
          decoded.temperature_control_info = {
            mode:   extractBits(bits, 4, 8), // 0=Ventilation, 1=Heat, 2=Cool
            status: extractBits(bits, 0, 4), // 0=Standby, 1=Heat, 2=Cool
          };
          break;
        }

        // ── 0x06: temperature control valve status ────────────────────────────
        case 0x06:
          decoded.temperature_control_valve_status = readUInt8(bytes, i++); // 0=Close, 100=Open
          break;

        // ── 0x07: fan control info ───────────────────────────────────────────
        case 0x07: {
          const bits = readUInt8(bytes, i++);
          decoded.fan_control_info = {
            mode:   extractBits(bits, 4, 8), // 0=Auto, 1=Low, 2=Med, 3=High
            status: extractBits(bits, 0, 4), // 0=Off,  1=Low, 2=Med, 3=High
          };
          break;
        }

        // ── 0x08: execution plan id ──────────────────────────────────────────
        case 0x08:
          decoded.execution_plan_id = readUInt8(bytes, i++);
          break;

        // ── 0x09: temperature alarm ──────────────────────────────────────────
        case 0x09: {
          decoded.temperature_alarm = decoded.temperature_alarm ?? {};
          const type = readUInt8(bytes, i++);
          decoded.temperature_alarm.type = type;
          const alarmTypeMap: Record<number, string> = {
            0x00: 'collection_error',     0x01: 'lower_range_error',
            0x02: 'over_range_error',     0x03: 'no_data',
            0x10: 'lower_range_alarm_deactivation',  0x11: 'lower_range_alarm_trigger',
            0x12: 'over_range_alarm_deactivation',   0x13: 'over_range_alarm_trigger',
            0x14: 'within_range_alarm_deactivation', 0x15: 'within_range_alarm_trigger',
            0x16: 'exceed_range_alarm_deactivation', 0x17: 'exceed_range_alarm_trigger',
            0x20: 'persistent_low_temperature_alarm_deactivation',
            0x21: 'persistent_low_temperature_alarm_trigger',
            0x22: 'persistent_high_alarm_deactivation',
            0x23: 'persistent_high_alarm_trigger',
            0x30: 'anti_freeze_protection_deactivation',
            0x31: 'anti_freeze_protection_trigger',
            0x32: 'window_status_detection_deactivation',
            0x33: 'window_status_detection_trigger',
          };
          const key = alarmTypeMap[type];
          if (key) {
            // Types 0x00–0x03: no payload, just a marker object
            if (type <= 0x03) {
              decoded.temperature_alarm[key] = {};
            } else {
              // Types 0x10–0x33: carry a temperature value
              const temp = readInt16LE(bytes, i) / 100; i += 2;
              decoded.temperature_alarm[key] = { temperature: temp };
              decoded.temperature = temp; // mirror to top-level temperature
            }
          }
          break;
        }

        // ── 0x0A: humidity alarm ─────────────────────────────────────────────
        case 0x0a: {
          decoded.humidity_alarm = decoded.humidity_alarm ?? {};
          const type = readUInt8(bytes, i++);
          decoded.humidity_alarm.type = type;
          const keyMap: Record<number, string> = {
            0x00: 'collection_error', 0x01: 'lower_range_error',
            0x02: 'over_range_error', 0x03: 'no_data',
          };
          if (keyMap[type]) decoded.humidity_alarm[keyMap[type]] = {};
          break;
        }

        // ── 0x0B: target temperature alarm ───────────────────────────────────
        case 0x0b: {
          decoded.target_temperature_alarm = decoded.target_temperature_alarm ?? {};
          const type = readUInt8(bytes, i++);
          decoded.target_temperature_alarm.type = type;
          if (type === 0x03) decoded.target_temperature_alarm.no_data = {};
          break;
        }

        // ── 0x10: relay status ───────────────────────────────────────────────
        case 0x10: {
          const bits = readUInt32LE(bytes, i); i += 4;
          decoded.relay_status = {
            low_status:    extractBits(bits, 0, 1),
            mid_status:    extractBits(bits, 1, 2),
            high_status:   extractBits(bits, 2, 3),
            valve_1_status: extractBits(bits, 3, 4),
            valve_2_status: extractBits(bits, 4, 5),
            reserved:       extractBits(bits, 5, 32),
          };
          break;
        }

        // ── 0xC8: device status ──────────────────────────────────────────────
        case 0xc8:
          decoded.device_status = readUInt8(bytes, i++);
          break;

        // ── 0x60: collection interval ────────────────────────────────────────
        case 0x60: {
          decoded.collection_interval = decoded.collection_interval ?? {};
          const unit = readUInt8(bytes, i++);
          decoded.collection_interval.unit = unit;
          if (unit === 0x00) {
            decoded.collection_interval.seconds_of_time = readUInt16LE(bytes, i); i += 2;
          } else {
            decoded.collection_interval.minutes_of_time = readUInt16LE(bytes, i); i += 2;
          }
          break;
        }

        // ── 0x62: reporting interval ─────────────────────────────────────────
        case 0x62: {
          decoded.reporting_interval = decoded.reporting_interval ?? {};
          const unit = readUInt8(bytes, i++);
          decoded.reporting_interval.unit = unit;
          if (unit === 0x00) {
            decoded.reporting_interval.seconds_of_time = readUInt16LE(bytes, i); i += 2;
          } else {
            decoded.reporting_interval.minutes_of_time = readUInt16LE(bytes, i); i += 2;
          }
          break;
        }

        // ── 0xC4: auto-P enable ──────────────────────────────────────────────
        case 0xc4:
          decoded.auto_p_enable = readUInt8(bytes, i++);
          break;

        // ── 0x90: relay changes report enable ────────────────────────────────
        case 0x90:
          decoded.relay_changes_report_enable = readUInt8(bytes, i++);
          break;

        // ── 0x63: temperature unit ───────────────────────────────────────────
        case 0x63:
          decoded.temperature_unit = readUInt8(bytes, i++);
          break;

        // ── 0x85: temperature source ─────────────────────────────────────────
        case 0x85: {
          decoded.temperature_source = decoded.temperature_source ?? {};
          const type = readUInt8(bytes, i++);
          decoded.temperature_source.type = type;
          if (type === 0x02) {
            decoded.temperature_source.lorawan_reception = {
              timeout:          readUInt8(bytes, i++),
              timeout_response: readUInt8(bytes, i++),
            };
          } else if (type === 0x03) {
            decoded.temperature_source.d2d_reception = {
              timeout:          readUInt8(bytes, i++),
              timeout_response: readUInt8(bytes, i++),
            };
          }
          break;
        }

        // ── 0x67: system status ──────────────────────────────────────────────
        case 0x67:
          decoded.system_status = readUInt8(bytes, i++);
          break;

        // ── 0x64: mode enable ────────────────────────────────────────────────
        case 0x64:
          decoded.mode_enable = readUInt8(bytes, i++);
          break;

        // ── 0x68: temperature control mode ───────────────────────────────────
        case 0x68:
          decoded.temperature_control_mode = readUInt8(bytes, i++);
          break;

        // ── 0x69: target temperature resolution ──────────────────────────────
        case 0x69:
          decoded.target_temperature_resolution = readUInt8(bytes, i++);
          break;

        // ── 0x6B: heating target temperature ─────────────────────────────────
        case 0x6b:
          decoded.heating_target_temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x6C: cooling target temperature ─────────────────────────────────
        case 0x6c:
          decoded.cooling_target_temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x6A: target temperature tolerance ───────────────────────────────
        case 0x6a:
          decoded.target_temperature_tolerance = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x6D: heating target temperature range ────────────────────────────
        case 0x6d:
          decoded.heating_target_temperature_range = {
            min: readInt16LE(bytes, i) / 100,
            max: readInt16LE(bytes, i + 2) / 100,
          };
          i += 4;
          break;

        // ── 0x6E: cooling target temperature range ────────────────────────────
        case 0x6e:
          decoded.cooling_target_temperature_range = {
            min: readInt16LE(bytes, i) / 100,
            max: readInt16LE(bytes, i + 2) / 100,
          };
          i += 4;
          break;

        // ── 0x70: target humidity range ───────────────────────────────────────
        case 0x70:
          decoded.target_humidity_range = {
            min: readUInt16LE(bytes, i) / 10,
            max: readUInt16LE(bytes, i + 2) / 10,
          };
          i += 4;
          break;

        // ── 0x6F: temperature control dehumidification ────────────────────────
        case 0x6f:
          decoded.temperature_control_dehumidification = {
            enable:               readUInt8(bytes, i++),
            temperature_tolerance: readInt16LE(bytes, i) / 100,
          };
          i += 2;
          break;

        // ── 0x72: fan control mode ───────────────────────────────────────────
        case 0x72:
          decoded.fan_control_mode = readUInt8(bytes, i++);
          break;

        // ── 0x74: fan delay close ────────────────────────────────────────────
        case 0x74:
          decoded.fan_delay_close = {
            enable: readUInt8(bytes, i++),
            time:   readUInt16LE(bytes, i),
          };
          i += 2;
          break;

        // ── 0x73: fan auto mode temperature range ─────────────────────────────
        case 0x73:
          decoded.fan_auto_mode_temperature_range = {
            speed_range_1: readInt16LE(bytes, i) / 100,
            speed_range_2: readInt16LE(bytes, i + 2) / 100,
          };
          i += 4;
          break;

        // ── 0x8C: timed system control ───────────────────────────────────────
        case 0x8c: {
          decoded.timed_system_control = decoded.timed_system_control ?? {};
          const sub = bytes[i++];
          if (sub === 0x00) {
            decoded.timed_system_control.enable = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            decoded.timed_system_control.start_cycle_settings = decoded.timed_system_control.start_cycle_settings ?? [];
            const id = readUInt8(bytes, i++);
            const item = pickArrayItem(decoded.timed_system_control.start_cycle_settings, id, 'id');
            item.id     = id;
            item.enable = readUInt8(bytes, i++);
            item.execution_time_point = readUInt16LE(bytes, i); i += 2;
            const bits = readUInt8(bytes, i++);
            item.execution_day_sun  = extractBits(bits, 0, 1);
            item.execution_day_mon  = extractBits(bits, 1, 2);
            item.execution_day_tues = extractBits(bits, 2, 3);
            item.execution_day_wed  = extractBits(bits, 3, 4);
            item.execution_day_thu  = extractBits(bits, 4, 5);
            item.execution_day_fri  = extractBits(bits, 5, 6);
            item.execution_day_sat  = extractBits(bits, 6, 7);
            item.reserved           = extractBits(bits, 7, 8);
            insertArrayItem(decoded.timed_system_control.start_cycle_settings, item, 'id');
          } else if (sub === 0x02) {
            decoded.timed_system_control.end_cycle_settings = decoded.timed_system_control.end_cycle_settings ?? [];
            const id = readUInt8(bytes, i++);
            const item = pickArrayItem(decoded.timed_system_control.end_cycle_settings, id, 'id');
            item.id     = id;
            item.enable = readUInt8(bytes, i++);
            item.execution_time_point = readUInt16LE(bytes, i); i += 2;
            const bits = readUInt8(bytes, i++);
            item.execution_day_sun  = extractBits(bits, 0, 1);
            item.execution_day_mon  = extractBits(bits, 1, 2);
            item.execution_day_tues = extractBits(bits, 2, 3);
            item.execution_day_wed  = extractBits(bits, 3, 4);
            item.execution_day_thu  = extractBits(bits, 4, 5);
            item.execution_day_fri  = extractBits(bits, 5, 6);
            item.execution_day_sat  = extractBits(bits, 6, 7);
            item.reserved           = extractBits(bits, 7, 8);
            insertArrayItem(decoded.timed_system_control.end_cycle_settings, item, 'id');
          }
          break;
        }

        // ── 0x65: intelligent display enable ─────────────────────────────────
        case 0x65:
          decoded.intelligent_display_enable = readUInt8(bytes, i++);
          break;

        // ── 0x66: screen object settings ─────────────────────────────────────
        case 0x66: {
          const enable = readUInt8(bytes, i++);
          const bits   = readUInt8(bytes, i++);
          decoded.screen_object_settings = {
            enable,
            environmental_temperature: extractBits(bits, 0, 1),
            environmental_humidity:    extractBits(bits, 1, 2),
            target_temperature:        extractBits(bits, 2, 3),
            schedule_name:             extractBits(bits, 3, 4),
            reserved:                  extractBits(bits, 4, 8),
          };
          break;
        }

        // ── 0x75: child lock ─────────────────────────────────────────────────
        case 0x75: {
          const enable = readUInt8(bytes, i++);
          const bits   = readUInt8(bytes, i++);
          decoded.child_lock = {
            enable,
            system_button:             extractBits(bits, 0, 1),
            temperature_button:        extractBits(bits, 1, 2),
            fan_button:                extractBits(bits, 2, 3),
            temperature_control_button: extractBits(bits, 3, 4),
            reboot_reset_button:       extractBits(bits, 4, 5),
            reserved:                  extractBits(bits, 5, 8),
          };
          break;
        }

        // ── 0x8D: temporary unlock settings ──────────────────────────────────
        case 0x8d: {
          const enable = readUInt8(bytes, i++);
          const bits   = readUInt8(bytes, i++);
          decoded.temporary_unlock_settings = {
            enable,
            system:              extractBits(bits, 0, 1),
            temperature_up:      extractBits(bits, 1, 2),
            temperature_down:    extractBits(bits, 2, 3),
            fan:                 extractBits(bits, 3, 4),
            temperature_control: extractBits(bits, 4, 5),
            reserved:            extractBits(bits, 5, 8),
            unlocking_duration:  readUInt16LE(bytes, i),
          };
          i += 2;
          break;
        }

        // ── 0xC7: time zone ──────────────────────────────────────────────────
        case 0xc7:
          decoded.time_zone = readInt16LE(bytes, i);
          i += 2;
          break;

        // ── 0xC6: daylight saving time ────────────────────────────────────────
        case 0xc6: {
          const enable  = readUInt8(bytes, i++);
          const offset  = readUInt8(bytes, i++);
          const startMo = readUInt8(bytes, i++);
          const startWB = readUInt8(bytes, i++);
          const startHM = readUInt16LE(bytes, i); i += 2;
          const endMo   = readUInt8(bytes, i++);
          const endWB   = readUInt8(bytes, i++);
          const endHM   = readUInt16LE(bytes, i); i += 2;
          decoded.daylight_saving_time = {
            enable,
            daylight_saving_time_offset: offset,
            start_month:    startMo,
            start_week_num: extractBits(startWB, 4, 8),
            start_week_day: extractBits(startWB, 0, 4),
            start_hour_min: startHM,
            end_month:      endMo,
            end_week_num:   extractBits(endWB, 4, 8),
            end_week_day:   extractBits(endWB, 0, 4),
            end_hour_min:   endHM,
          };
          break;
        }

        // ── 0xC5: data storage settings ───────────────────────────────────────
        case 0xc5: {
          decoded.data_storage_settings = decoded.data_storage_settings ?? {};
          const sub = bytes[i++];
          if (sub === 0x00) {
            decoded.data_storage_settings.enable = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            decoded.data_storage_settings.retransmission_enable = readUInt8(bytes, i++);
          } else if (sub === 0x02) {
            decoded.data_storage_settings.retransmission_interval = readUInt16LE(bytes, i); i += 2;
          } else if (sub === 0x03) {
            decoded.data_storage_settings.retrieval_interval = readUInt16LE(bytes, i); i += 2;
          }
          break;
        }

        // ── 0x79: temperature calibration settings ────────────────────────────
        case 0x79:
          decoded.temperature_calibration_settings = {
            enable:            readUInt8(bytes, i++),
            calibration_value: readInt16LE(bytes, i) / 100,
          };
          i += 2;
          break;

        // ── 0x7A: humidity calibration settings ───────────────────────────────
        case 0x7a:
          decoded.humidity_calibration_settings = {
            enable:            readUInt8(bytes, i++),
            calibration_value: readInt16LE(bytes, i) / 10,
          };
          i += 2;
          break;

        // ── 0x76: temperature alarm settings ─────────────────────────────────
        case 0x76:
          decoded.temperature_alarm_settings = {
            enable:              readUInt8(bytes, i++),
            threshold_condition: readUInt8(bytes, i++),
            threshold_min:       readInt16LE(bytes, i) / 100,
            threshold_max:       readInt16LE(bytes, i + 2) / 100,
          };
          i += 4;
          break;

        // ── 0x77: high temperature alarm settings ─────────────────────────────
        case 0x77:
          decoded.high_temperature_alarm_settings = {
            enable:                   readUInt8(bytes, i++),
            difference_in_temperature: readInt16LE(bytes, i) / 100,
            duration:                  readUInt8(bytes, i + 2),
          };
          i += 3;
          break;

        // ── 0x78: low temperature alarm settings ──────────────────────────────
        case 0x78:
          decoded.low_temperature_alarm_settings = {
            enable:                   readUInt8(bytes, i++),
            difference_in_temperature: readInt16LE(bytes, i) / 100,
            duration:                  readUInt8(bytes, i + 2),
          };
          i += 3;
          break;

        // ── 0x7B: schedule settings ───────────────────────────────────────────
        case 0x7b: {
          decoded.schedule_settings = decoded.schedule_settings ?? [];
          const schedId = readUInt8(bytes, i++);
          const schedItem = pickArrayItem(decoded.schedule_settings, schedId, 'id');
          schedItem.id = schedId;
          const sub = readUInt8(bytes, i++);
          if (sub === 0x00) {
            schedItem.enable = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            schedItem.name_first = readString(bytes, i, 6); i += 6;
          } else if (sub === 0x02) {
            schedItem.name_last = readString(bytes, i, 4); i += 4;
          } else if (sub === 0x03) {
            schedItem.content = schedItem.content ?? {};
            schedItem.content.fan_mode = readUInt8(bytes, i++);
            const heatBits = readUInt16LE(bytes, i); i += 2;
            schedItem.content.heat_target_temperature_enable = extractBits(heatBits, 0, 1);
            schedItem.content.heat_target_temperature        = extractBits(heatBits, 1, 16) / 100;
            const coolBits = readUInt16LE(bytes, i); i += 2;
            schedItem.content.cool_target_temperature_enable = extractBits(coolBits, 0, 1);
            schedItem.content.cool_target_temperature        = extractBits(coolBits, 1, 16) / 100;
            const tolBits = readUInt16LE(bytes, i); i += 2;
            schedItem.content.temperature_tolerance_enable = extractBits(tolBits, 0, 1);
            schedItem.content.temperature_tolerance        = extractBits(tolBits, 1, 16) / 100;
          } else if (sub === 0x04) {
            schedItem.cycle_settings = schedItem.cycle_settings ?? [];
            const cycleId   = readUInt8(bytes, i++);
            const cycleItem = pickArrayItem(schedItem.cycle_settings, cycleId, 'id');
            cycleItem.id     = cycleId;
            cycleItem.enable = readUInt8(bytes, i++);
            cycleItem.execution_time_point = readUInt16LE(bytes, i); i += 2;
            const bits = readUInt8(bytes, i++);
            cycleItem.execution_day_sun  = extractBits(bits, 0, 1);
            cycleItem.execution_day_mon  = extractBits(bits, 1, 2);
            cycleItem.execution_day_tues = extractBits(bits, 2, 3);
            cycleItem.execution_day_wed  = extractBits(bits, 3, 4);
            cycleItem.execution_day_thu  = extractBits(bits, 4, 5);
            cycleItem.execution_day_fri  = extractBits(bits, 5, 6);
            cycleItem.execution_day_sat  = extractBits(bits, 6, 7);
            cycleItem.reserved           = extractBits(bits, 7, 8);
            insertArrayItem(schedItem.cycle_settings, cycleItem, 'id');
          }
          insertArrayItem(decoded.schedule_settings, schedItem, 'id');
          break;
        }

        // ── 0x7C: interface settings ─────────────────────────────────────────
        case 0x7c: {
          decoded.interface_settings = decoded.interface_settings ?? {};
          const obj = readUInt8(bytes, i++);
          decoded.interface_settings.object = obj;
          if (obj === 0x00) {
            decoded.interface_settings.valve_4_pipe_2_wire = {
              cooling: readUInt8(bytes, i++),
              heating: readUInt8(bytes, i++),
            };
          } else if (obj === 0x01) {
            decoded.interface_settings.valve_2_pipe_2_wire = {
              control: readUInt8(bytes, i++),
            };
          } else if (obj === 0x02) {
            decoded.interface_settings.valve_2_pipe_3_wire = {
              no: readUInt8(bytes, i++),
              nc: readUInt8(bytes, i++),
            };
          }
          break;
        }

        // ── 0x8E: fan stop enable ────────────────────────────────────────────
        case 0x8e:
          decoded.fan_stop_enable = readUInt8(bytes, i++);
          break;

        // ── 0x80: DI enable ──────────────────────────────────────────────────
        case 0x80:
          decoded.di_enable = readUInt8(bytes, i++);
          break;

        // ── 0x81: DI settings ────────────────────────────────────────────────
        case 0x81: {
          decoded.di_settings = decoded.di_settings ?? {};
          const obj = readUInt8(bytes, i++);
          decoded.di_settings.object = obj;
          if (obj === 0x00) {
            decoded.di_settings.card_control = decoded.di_settings.card_control ?? {};
            const type = readUInt8(bytes, i++);
            decoded.di_settings.card_control.type = type;
            if (type === 0x00) {
              decoded.di_settings.card_control.system_control = {
                trigger_by_insertion: readUInt8(bytes, i++),
              };
            } else if (type === 0x01) {
              decoded.di_settings.card_control.insertion_plan = {
                trigger_by_insertion: readUInt8(bytes, i++),
                trigger_by_extraction: readUInt8(bytes, i++),
              };
            }
          } else if (obj === 0x01) {
            decoded.di_settings.magnet_detection = {
              magnet_type: readUInt8(bytes, i++),
            };
          }
          break;
        }

        // ── 0x82: window opening detection enable ─────────────────────────────
        case 0x82:
          decoded.window_opening_detection_enable = readUInt8(bytes, i++);
          break;

        // ── 0x83: window opening detection settings ───────────────────────────
        case 0x83: {
          decoded.window_opening_detection_settings = decoded.window_opening_detection_settings ?? {};
          const type = readUInt8(bytes, i++);
          decoded.window_opening_detection_settings.type = type;
          if (type === 0x00) {
            decoded.window_opening_detection_settings.temperature_detection = {
              difference_in_temperature: readInt16LE(bytes, i) / 100,
              stop_time:                 readUInt8(bytes, i + 2),
            };
            i += 3;
          } else if (type === 0x01) {
            decoded.window_opening_detection_settings.magnet_detection = {
              duration: readUInt8(bytes, i++),
            };
          }
          break;
        }

        // ── 0x84: freeze protection settings ─────────────────────────────────
        case 0x84:
          decoded.freeze_protection_settings = {
            enable:             readUInt8(bytes, i++),
            target_temperature: readInt16LE(bytes, i) / 100,
          };
          i += 2;
          break;

        // ── 0x86: D2D pairing enable ─────────────────────────────────────────
        case 0x86:
          decoded.d2d_pairing_enable = readUInt8(bytes, i++);
          break;

        // ── 0x87: D2D pairing settings ────────────────────────────────────────
        case 0x87: {
          decoded.d2d_pairing_settings = decoded.d2d_pairing_settings ?? [];
          const idx  = readUInt8(bytes, i++);
          const item = pickArrayItem(decoded.d2d_pairing_settings, idx, 'index');
          item.index = idx;
          const sub = readUInt8(bytes, i++);
          if (sub === 0x00) {
            item.enable = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            item.deveui = readHexString(bytes, i, 8); i += 8;
          } else if (sub === 0x02) {
            item.name_first = readString(bytes, i, 8); i += 8;
          } else if (sub === 0x03) {
            item.name_last = readString(bytes, i, 8); i += 8;
          }
          insertArrayItem(decoded.d2d_pairing_settings, item, 'index');
          break;
        }

        // ── 0x88: D2D master enable ───────────────────────────────────────────
        case 0x88:
          decoded.d2d_master_enable = readUInt8(bytes, i++);
          break;

        // ── 0x89: D2D master settings ─────────────────────────────────────────
        case 0x89: {
          decoded.d2d_master_settings = decoded.d2d_master_settings ?? [];
          const trigger = readUInt8(bytes, i++);
          const item    = pickArrayItem(decoded.d2d_master_settings, trigger, 'trigger_condition');
          item.trigger_condition  = trigger;
          item.enable             = readUInt8(bytes, i++);
          item.command            = readHexString(bytes, i, 2); i += 2;
          item.uplink             = readUInt8(bytes, i++);
          item.control_time_enable = readUInt8(bytes, i++);
          item.control_time       = readUInt16LE(bytes, i); i += 2;
          insertArrayItem(decoded.d2d_master_settings, item, 'trigger_condition');
          break;
        }

        // ── 0x8A: D2D slave enable ────────────────────────────────────────────
        case 0x8a:
          decoded.d2d_slave_enable = readUInt8(bytes, i++);
          break;

        // ── 0x8B: D2D slave settings ──────────────────────────────────────────
        case 0x8b: {
          decoded.d2d_slave_settings = decoded.d2d_slave_settings ?? [];
          const idx  = readUInt8(bytes, i++);
          const item = pickArrayItem(decoded.d2d_slave_settings, idx, 'index');
          item.index   = idx;
          item.enable  = readUInt8(bytes, i++);
          item.command = readHexString(bytes, i, 2); i += 2;
          item.value   = readUInt8(bytes, i++);
          insertArrayItem(decoded.d2d_slave_settings, item, 'index');
          break;
        }

        // ── Service / downlink-trigger commands (uplink echo) ─────────────────
        case 0xb9: decoded.query_device_status          = 1; break;
        case 0xb8: decoded.synchronize_time             = 1; break;
        case 0xbd: decoded.clear_historical_data        = 1; break;
        case 0xbc: decoded.stop_historical_data_retrieval = 1; break;

        case 0xbb:
          decoded.retrieve_historical_data_by_time_range = {
            start_time: readUInt32LE(bytes, i),
            end_time:   readUInt32LE(bytes, i + 4),
          };
          i += 8;
          break;

        case 0xba:
          decoded.retrieve_historical_data_by_time = {
            time: readUInt32LE(bytes, i),
          };
          i += 4;
          break;

        case 0xb6: decoded.reconnect = 1; break;

        case 0x5b:
          decoded.send_temperature = {
            temperature: readInt16LE(bytes, i) / 100,
          };
          i += 2;
          break;

        case 0x5c:
          decoded.send_humidity = {
            humidity: readUInt16LE(bytes, i) / 10,
          };
          i += 2;
          break;

        case 0x5d:
          decoded.update_open_windows_state = { type: readUInt8(bytes, i++) };
          break;

        case 0x5e:
          decoded.insert_schedule = { type: readUInt8(bytes, i++) };
          break;

        case 0x5f:
          decoded.delete_schedule = { type: readUInt8(bytes, i++) };
          break;

        case 0xbf: decoded.reset  = 1; break;
        case 0xbe: decoded.reboot = 1; break;

        default:
          decoded.raw_command_id = `0x${cmd.toString(16).padStart(2, '0')}`;
          // Stop processing to avoid garbage reads on unknown command
          i = bytes.length;
          break;
      }
    }

    // Apply celsius_* / fahrenheit_* aliases to all temperature leaf fields
    processTemperature(decoded);

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      // ── System / utility ──────────────────────────────────────────────────

      case 'reboot':
        bytes = [0xbe];
        break;

      case 'reset':
        bytes = [0xbf];
        break;

      case 'query_device_status':
        bytes = [0xb9];
        break;

      case 'synchronize_time':
        bytes = [0xb8];
        break;

      case 'reconnect':
        bytes = [0xb6];
        break;

      case 'clear_historical_data':
        bytes = [0xbd];
        break;

      case 'stop_historical_data_retrieval':
        bytes = [0xbc];
        break;

      case 'retrieve_historical_data_by_time_range': {
        const start = params.start_time ?? 0;
        const end   = params.end_time   ?? 0;
        bytes = [0xbb, ...writeUInt32LE(start), ...writeUInt32LE(end)];
        break;
      }

      case 'retrieve_historical_data_by_time': {
        bytes = [0xba, ...writeUInt32LE(params.time ?? 0)];
        break;
      }

      // ── LoRaWAN configuration ─────────────────────────────────────────────

      case 'set_lorawan_mode':
        // mode: 0=ClassA, 1=ClassB, 2=ClassC, 3=ClassCtoB
        bytes = [0xcf, 0x00, params.mode ?? 0];
        break;

      // ── Identity ──────────────────────────────────────────────────────────

      case 'set_product_sn':
        bytes = [0xdb, ...hexToBytes(params.product_sn ?? '0000000000000000', 8)];
        break;

      case 'set_oem_id':
        bytes = [0xd9, ...hexToBytes(params.oem_id ?? '0000', 2)];
        break;

      // ── Telemetry push (server → device) ──────────────────────────────────

      case 'send_temperature': {
        const raw = Math.round((params.temperature ?? 0) * 100);
        bytes = [0x5b, ...writeInt16LE(raw)];
        break;
      }

      case 'send_humidity': {
        const raw = Math.round((params.humidity ?? 0) * 10);
        bytes = [0x5c, ...writeUInt16LE(raw)];
        break;
      }

      // ── Core thermostat controls ───────────────────────────────────────────

      case 'set_system_status':
        // 0=Off, 1=On
        bytes = [0x67, params.system_status ?? 0];
        break;

      case 'set_temperature_control_mode':
        // 0=Ventilation, 1=Heat, 2=Cool
        bytes = [0x68, params.temperature_control_mode ?? 0];
        break;

      case 'set_mode_enable':
        // 7=Vent+Heat+Cool, 3=Vent+Heat, 5=Vent+Cool
        bytes = [0x64, params.mode_enable ?? 7];
        break;

      case 'set_target_temperature_resolution':
        // 0=0.5°C, 1=1°C
        bytes = [0x69, params.target_temperature_resolution ?? 0];
        break;

      case 'set_heating_target_temperature': {
        const v = params.heating_target_temperature ?? 20;
        if (v < 5 || v > 35) throw new Error('heating_target_temperature must be 5–35');
        bytes = [0x6b, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_cooling_target_temperature': {
        const v = params.cooling_target_temperature ?? 26;
        if (v < 5 || v > 35) throw new Error('cooling_target_temperature must be 5–35');
        bytes = [0x6c, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_tolerance': {
        const v = params.target_temperature_tolerance ?? 1;
        if (v < 0.1 || v > 5) throw new Error('target_temperature_tolerance must be 0.1–5');
        bytes = [0x6a, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_heating_target_temperature_range': {
        const min = params.min ?? 10; const max = params.max ?? 19;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('heating range min/max must be 5–35');
        bytes = [0x6d, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      case 'set_cooling_target_temperature_range': {
        const min = params.min ?? 23; const max = params.max ?? 35;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('cooling range min/max must be 5–35');
        bytes = [0x6e, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      case 'set_target_humidity_range': {
        const min = params.min ?? 40; const max = params.max ?? 80;
        if (min < 0 || min > 100 || max < 0 || max > 100) throw new Error('humidity range min/max must be 0–100');
        bytes = [0x70, ...writeUInt16LE(Math.round(min * 10)), ...writeUInt16LE(Math.round(max * 10))];
        break;
      }

      case 'set_temperature_control_dehumidification': {
        const enable = params.enable ?? 0;
        const tol    = params.temperature_tolerance ?? 1;
        if (tol < 0.1 || tol > 5) throw new Error('temperature_tolerance must be 0.1–5');
        bytes = [0x6f, enable, ...writeInt16LE(Math.round(tol * 100))];
        break;
      }

      // ── Fan control ───────────────────────────────────────────────────────

      case 'set_fan_control_mode':
        // 0=Auto, 1=Low, 2=Medium, 3=High
        bytes = [0x72, params.fan_control_mode ?? 0];
        break;

      case 'set_fan_delay_close': {
        const enable = params.enable ?? 0;
        const time   = params.time ?? 60;
        if (time < 30 || time > 3600) throw new Error('fan_delay_close.time must be 30–3600');
        bytes = [0x74, enable, ...writeUInt16LE(time)];
        break;
      }

      case 'set_fan_auto_mode_temperature_range': {
        const r1 = params.speed_range_1 ?? 3;
        const r2 = params.speed_range_2 ?? 5;
        if (r1 < 1 || r1 > 15 || r2 < 1 || r2 > 15) throw new Error('speed_range must be 1–15');
        bytes = [0x73, ...writeInt16LE(Math.round(r1 * 100)), ...writeInt16LE(Math.round(r2 * 100))];
        break;
      }

      case 'set_fan_stop_enable':
        bytes = [0x8e, params.fan_stop_enable ?? 0];
        break;

      // ── Data source / temperature source ─────────────────────────────────

      case 'set_data_source':
        // 0=Internal, 1=External NTC, 2=LoRaWAN Reception, 3=D2D Reception
        bytes = [0x04, params.data_source ?? 0];
        break;

      case 'set_temperature_source': {
        const stype = params.type ?? 0;
        bytes = [0x85, stype];
        if (stype === 0x02) {
          const timeout  = params.lorawan_reception?.timeout ?? 10;
          const response = params.lorawan_reception?.timeout_response ?? 0;
          if (timeout < 1 || timeout > 60) throw new Error('lorawan_reception.timeout must be 1–60');
          bytes.push(timeout, response);
        } else if (stype === 0x03) {
          const timeout  = params.d2d_reception?.timeout ?? 10;
          const response = params.d2d_reception?.timeout_response ?? 0;
          if (timeout < 1 || timeout > 60) throw new Error('d2d_reception.timeout must be 1–60');
          bytes.push(timeout, response);
        }
        break;
      }

      // ── Intervals ─────────────────────────────────────────────────────────

      case 'set_collection_interval': {
        const unit = params.unit ?? 0;
        bytes = [0x60, unit];
        if (unit === 0) {
          const v = params.seconds_of_time ?? 30;
          if (v < 10 || v > 64800) throw new Error('seconds_of_time must be 10–64800');
          bytes.push(...writeUInt16LE(v));
        } else {
          const v = params.minutes_of_time ?? 1;
          if (v < 1 || v > 1440) throw new Error('minutes_of_time must be 1–1440');
          bytes.push(...writeUInt16LE(v));
        }
        break;
      }

      case 'set_reporting_interval': {
        const unit = params.unit ?? 1;
        bytes = [0x62, unit];
        if (unit === 0) {
          const v = params.seconds_of_time ?? 600;
          if (v < 10 || v > 64800) throw new Error('seconds_of_time must be 10–64800');
          bytes.push(...writeUInt16LE(v));
        } else {
          const v = params.minutes_of_time ?? 10;
          if (v < 1 || v > 1440) throw new Error('minutes_of_time must be 1–1440');
          bytes.push(...writeUInt16LE(v));
        }
        break;
      }

      // ── Misc device settings ──────────────────────────────────────────────

      case 'set_auto_p_enable':
        bytes = [0xc4, params.auto_p_enable ?? 0];
        break;

      case 'set_relay_changes_report_enable':
        bytes = [0x90, params.relay_changes_report_enable ?? 0];
        break;

      case 'set_temperature_unit':
        // 0=°C, 1=°F
        bytes = [0x63, params.temperature_unit ?? 0];
        break;

      // ── Display ───────────────────────────────────────────────────────────

      case 'set_intelligent_display_enable':
        bytes = [0x65, params.intelligent_display_enable ?? 0];
        break;

      case 'set_screen_object_settings': {
        const enable = params.enable ?? 0;
        let bits = 0;
        bits |= (params.environmental_temperature ?? 0) << 0;
        bits |= (params.environmental_humidity    ?? 0) << 1;
        bits |= (params.target_temperature        ?? 0) << 2;
        bits |= (params.schedule_name             ?? 0) << 3;
        bits |= (params.reserved                  ?? 0) << 4;
        bytes = [0x66, enable, bits];
        break;
      }

      // ── Child lock / unlock ───────────────────────────────────────────────

      case 'set_child_lock': {
        const enable = params.enable ?? 0;
        let bits = 0;
        bits |= (params.system_button              ?? 0) << 0;
        bits |= (params.temperature_button         ?? 0) << 1;
        bits |= (params.fan_button                 ?? 0) << 2;
        bits |= (params.temperature_control_button ?? 0) << 3;
        bits |= (params.reboot_reset_button        ?? 0) << 4;
        bits |= (params.reserved                   ?? 0) << 5;
        bytes = [0x75, enable, bits];
        break;
      }

      case 'set_temporary_unlock_settings': {
        const enable = params.enable ?? 0;
        let bits = 0;
        bits |= (params.system              ?? 0) << 0;
        bits |= (params.temperature_up      ?? 0) << 1;
        bits |= (params.temperature_down    ?? 0) << 2;
        bits |= (params.fan                 ?? 0) << 3;
        bits |= (params.temperature_control ?? 0) << 4;
        bits |= (params.reserved            ?? 0) << 5;
        const dur = params.unlocking_duration ?? 30;
        if (dur < 1 || dur > 3600) throw new Error('unlocking_duration must be 1–3600');
        bytes = [0x8d, enable, bits, ...writeUInt16LE(dur)];
        break;
      }

      // ── Time / timezone / DST ─────────────────────────────────────────────

      case 'set_time_zone': {
        // time_zone is int16 in minutes, e.g. UTC+3 = 180, UTC-5 = -300
        const tz = params.time_zone ?? 0;
        bytes = [0xc7, ...writeInt16LE(tz)];
        break;
      }

      case 'set_daylight_saving_time': {
        const p = params;
        const enable  = p.enable ?? 0;
        const offset  = p.daylight_saving_time_offset ?? 60;
        if (offset < 1 || offset > 120) throw new Error('daylight_saving_time_offset must be 1–120');
        const startWB = ((p.start_week_num ?? 1) << 4) | (p.start_week_day ?? 7);
        const endWB   = ((p.end_week_num   ?? 1) << 4) | (p.end_week_day   ?? 7);
        bytes = [
          0xc6, enable, offset,
          p.start_month ?? 1, startWB,
          ...writeUInt16LE(p.start_hour_min ?? 0),
          p.end_month   ?? 1, endWB,
          ...writeUInt16LE(p.end_hour_min ?? 0),
        ];
        break;
      }

      // ── Timed system control ──────────────────────────────────────────────

      case 'set_timed_system_control_enable':
        bytes = [0x8c, 0x00, params.enable ?? 0];
        break;

      case 'set_timed_system_control_start_cycle': {
        const id   = params.id ?? 0;
        const en   = params.enable ?? 0;
        const time = params.execution_time_point ?? 0;
        let dayBits = 0;
        dayBits |= (params.execution_day_sun  ?? 0) << 0;
        dayBits |= (params.execution_day_mon  ?? 0) << 1;
        dayBits |= (params.execution_day_tues ?? 0) << 2;
        dayBits |= (params.execution_day_wed  ?? 0) << 3;
        dayBits |= (params.execution_day_thu  ?? 0) << 4;
        dayBits |= (params.execution_day_fri  ?? 0) << 5;
        dayBits |= (params.execution_day_sat  ?? 0) << 6;
        dayBits |= (params.reserved           ?? 0) << 7;
        bytes = [0x8c, 0x01, id, en, ...writeUInt16LE(time), dayBits];
        break;
      }

      case 'set_timed_system_control_end_cycle': {
        const id   = params.id ?? 0;
        const en   = params.enable ?? 0;
        const time = params.execution_time_point ?? 0;
        let dayBits = 0;
        dayBits |= (params.execution_day_sun  ?? 0) << 0;
        dayBits |= (params.execution_day_mon  ?? 0) << 1;
        dayBits |= (params.execution_day_tues ?? 0) << 2;
        dayBits |= (params.execution_day_wed  ?? 0) << 3;
        dayBits |= (params.execution_day_thu  ?? 0) << 4;
        dayBits |= (params.execution_day_fri  ?? 0) << 5;
        dayBits |= (params.execution_day_sat  ?? 0) << 6;
        dayBits |= (params.reserved           ?? 0) << 7;
        bytes = [0x8c, 0x02, id, en, ...writeUInt16LE(time), dayBits];
        break;
      }

      // ── Data storage ──────────────────────────────────────────────────────

      case 'set_data_storage_enable':
        bytes = [0xc5, 0x00, params.enable ?? 0];
        break;

      case 'set_data_storage_retransmission_enable':
        bytes = [0xc5, 0x01, params.retransmission_enable ?? 0];
        break;

      case 'set_data_storage_retransmission_interval': {
        const v = params.retransmission_interval ?? 600;
        if (v < 30 || v > 1200) throw new Error('retransmission_interval must be 30–1200');
        bytes = [0xc5, 0x02, ...writeUInt16LE(v)];
        break;
      }

      case 'set_data_storage_retrieval_interval': {
        const v = params.retrieval_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('retrieval_interval must be 30–1200');
        bytes = [0xc5, 0x03, ...writeUInt16LE(v)];
        break;
      }

      // ── Calibration ───────────────────────────────────────────────────────

      case 'set_temperature_calibration': {
        const enable = params.enable ?? 0;
        const val    = params.calibration_value ?? 0;
        if (val < -80 || val > 80) throw new Error('calibration_value must be -80–80');
        bytes = [0x79, enable, ...writeInt16LE(Math.round(val * 100))];
        break;
      }

      case 'set_humidity_calibration': {
        const enable = params.enable ?? 0;
        const val    = params.calibration_value ?? 0;
        if (val < -100 || val > 100) throw new Error('calibration_value must be -100–100');
        bytes = [0x7a, enable, ...writeInt16LE(Math.round(val * 10))];
        break;
      }

      // ── Alarm settings ────────────────────────────────────────────────────

      case 'set_temperature_alarm_settings': {
        const enable = params.enable ?? 0;
        const cond   = params.threshold_condition ?? 0;
        const min    = params.threshold_min ?? 0;
        const max    = params.threshold_max ?? 40;
        if (min < -20 || min > 60 || max < -20 || max > 60) throw new Error('threshold_min/max must be -20–60');
        bytes = [
          0x76, enable, cond,
          ...writeInt16LE(Math.round(min * 100)),
          ...writeInt16LE(Math.round(max * 100)),
        ];
        break;
      }

      case 'set_high_temperature_alarm_settings': {
        const enable = params.enable ?? 0;
        const diff   = params.difference_in_temperature ?? 3;
        const dur    = params.duration ?? 5;
        if (diff < 1 || diff > 10) throw new Error('difference_in_temperature must be 1–10');
        if (dur  < 0 || dur  > 60) throw new Error('duration must be 0–60');
        bytes = [0x77, enable, ...writeInt16LE(Math.round(diff * 100)), dur];
        break;
      }

      case 'set_low_temperature_alarm_settings': {
        const enable = params.enable ?? 0;
        const diff   = params.difference_in_temperature ?? 3;
        const dur    = params.duration ?? 5;
        if (diff < 1 || diff > 10) throw new Error('difference_in_temperature must be 1–10');
        if (dur  < 0 || dur  > 60) throw new Error('duration must be 0–60');
        bytes = [0x78, enable, ...writeInt16LE(Math.round(diff * 100)), dur];
        break;
      }

      // ── Schedule settings (0x7B) ───────────────────────────────────────────

      case 'set_schedule_enable': {
        const id = params.id ?? 0;
        bytes = [0x7b, id, 0x00, params.enable ?? 0];
        break;
      }

      case 'set_schedule_name_first': {
        const id = params.id ?? 0;
        bytes = [0x7b, id, 0x01, ...stringToBytes(params.name_first ?? '', 6)];
        break;
      }

      case 'set_schedule_name_last': {
        const id = params.id ?? 0;
        bytes = [0x7b, id, 0x02, ...stringToBytes(params.name_last ?? '', 4)];
        break;
      }

      case 'set_schedule_content': {
        const id      = params.id ?? 0;
        const fanMode = params.fan_mode ?? 0;
        const content = params.content ?? {};
        // Heat bits: bit0=enable, bits1–15 = temp*100 (shifted left 1)
        const heatEn   = (content.heat_target_temperature_enable ?? 0) & 0x1;
        const heatTemp = Math.round((content.heat_target_temperature ?? 17) * 100);
        const heatBits = (heatEn) | ((heatTemp & 0x7fff) << 1);
        const coolEn   = (content.cool_target_temperature_enable ?? 0) & 0x1;
        const coolTemp = Math.round((content.cool_target_temperature ?? 26) * 100);
        const coolBits = (coolEn) | ((coolTemp & 0x7fff) << 1);
        const tolEn    = (content.temperature_tolerance_enable ?? 0) & 0x1;
        const tolVal   = Math.round((content.temperature_tolerance ?? 1) * 100);
        const tolBits  = (tolEn) | ((tolVal & 0x7fff) << 1);
        bytes = [
          0x7b, id, 0x03, fanMode,
          ...writeUInt16LE(heatBits),
          ...writeUInt16LE(coolBits),
          ...writeUInt16LE(tolBits),
        ];
        break;
      }

      case 'set_schedule_cycle': {
        const schedId  = params.schedule_id ?? 0;
        const cycleId  = params.cycle_id    ?? 0;
        const enable   = params.enable      ?? 0;
        const timePt   = params.execution_time_point ?? 0;
        let dayBits = 0;
        dayBits |= (params.execution_day_sun  ?? 0) << 0;
        dayBits |= (params.execution_day_mon  ?? 0) << 1;
        dayBits |= (params.execution_day_tues ?? 0) << 2;
        dayBits |= (params.execution_day_wed  ?? 0) << 3;
        dayBits |= (params.execution_day_thu  ?? 0) << 4;
        dayBits |= (params.execution_day_fri  ?? 0) << 5;
        dayBits |= (params.execution_day_sat  ?? 0) << 6;
        dayBits |= (params.reserved           ?? 0) << 7;
        bytes = [0x7b, schedId, 0x04, cycleId, enable, ...writeUInt16LE(timePt), dayBits];
        break;
      }

      // ── Schedule events ───────────────────────────────────────────────────

      case 'insert_schedule':
        bytes = [0x5e, params.type ?? 0];
        break;

      case 'delete_schedule':
        bytes = [0x5f, params.type ?? 255];
        break;

      case 'update_open_windows_state':
        bytes = [0x5d, params.type ?? 0];
        break;

      // ── Interface settings ────────────────────────────────────────────────

      case 'set_interface_valve_4_pipe_2_wire':
        bytes = [0x7c, 0x00, params.cooling ?? 1, params.heating ?? 2];
        break;

      case 'set_interface_valve_2_pipe_2_wire':
        bytes = [0x7c, 0x01, params.control ?? 1];
        break;

      case 'set_interface_valve_2_pipe_3_wire':
        bytes = [0x7c, 0x02, params.no ?? 1, params.nc ?? 2];
        break;

      // ── DI settings ───────────────────────────────────────────────────────

      case 'set_di_enable':
        bytes = [0x80, params.di_enable ?? 0];
        break;

      case 'set_di_card_system_control':
        // system_control: 0=system off, 1=system on on insertion
        bytes = [0x81, 0x00, 0x00, params.trigger_by_insertion ?? 1];
        break;

      case 'set_di_card_insertion_plan':
        bytes = [
          0x81, 0x00, 0x01,
          params.trigger_by_insertion  ?? 0,
          params.trigger_by_extraction ?? 255,
        ];
        break;

      case 'set_di_magnet_detection':
        bytes = [0x81, 0x01, params.magnet_type ?? 0];
        break;

      // ── Window opening detection ──────────────────────────────────────────

      case 'set_window_opening_detection_enable':
        bytes = [0x82, params.window_opening_detection_enable ?? 0];
        break;

      case 'set_window_opening_detection_temperature': {
        const diff = params.difference_in_temperature ?? 3;
        const stop = params.stop_time ?? 30;
        if (diff < 1 || diff > 10) throw new Error('difference_in_temperature must be 1–10');
        if (stop < 1 || stop > 60) throw new Error('stop_time must be 1–60');
        bytes = [0x83, 0x00, ...writeInt16LE(Math.round(diff * 100)), stop];
        break;
      }

      case 'set_window_opening_detection_magnet': {
        const dur = params.duration ?? 10;
        if (dur < 1 || dur > 60) throw new Error('duration must be 1–60');
        bytes = [0x83, 0x01, dur];
        break;
      }

      // ── Freeze protection ─────────────────────────────────────────────────

      case 'set_freeze_protection': {
        const enable = params.enable ?? 0;
        const temp   = params.target_temperature ?? 3;
        if (temp < 1 || temp > 5) throw new Error('target_temperature must be 1–5');
        bytes = [0x84, enable, ...writeInt16LE(Math.round(temp * 100))];
        break;
      }

      // ── D2D pairing ───────────────────────────────────────────────────────

      case 'set_d2d_pairing_enable':
        bytes = [0x86, params.d2d_pairing_enable ?? 0];
        break;

      case 'set_d2d_pairing_item_enable': {
        const idx = params.index ?? 0;
        bytes = [0x87, idx, 0x00, params.enable ?? 0];
        break;
      }

      case 'set_d2d_pairing_item_deveui': {
        const idx = params.index ?? 0;
        bytes = [0x87, idx, 0x01, ...hexToBytes(params.deveui ?? '0000000000000000', 8)];
        break;
      }

      case 'set_d2d_pairing_item_name_first': {
        const idx = params.index ?? 0;
        bytes = [0x87, idx, 0x02, ...stringToBytes(params.name_first ?? '', 8)];
        break;
      }

      case 'set_d2d_pairing_item_name_last': {
        const idx = params.index ?? 0;
        bytes = [0x87, idx, 0x03, ...stringToBytes(params.name_last ?? '', 8)];
        break;
      }

      // ── D2D master ────────────────────────────────────────────────────────

      case 'set_d2d_master_enable':
        bytes = [0x88, params.d2d_master_enable ?? 0];
        break;

      case 'set_d2d_master_settings': {
        const trigger   = params.trigger_condition   ?? 0;
        const enable    = params.enable              ?? 0;
        const cmd       = hexToBytes(params.command ?? '0000', 2);
        const uplink    = params.uplink              ?? 0;
        const ctrlEn    = params.control_time_enable ?? 0;
        const ctrlTime  = params.control_time        ?? 5;
        if (ctrlTime < 1 || ctrlTime > 1440) throw new Error('control_time must be 1–1440');
        bytes = [0x89, trigger, enable, ...cmd, uplink, ctrlEn, ...writeUInt16LE(ctrlTime)];
        break;
      }

      // ── D2D slave ─────────────────────────────────────────────────────────

      case 'set_d2d_slave_enable':
        bytes = [0x8a, params.d2d_slave_enable ?? 0];
        break;

      case 'set_d2d_slave_settings': {
        const idx    = params.index   ?? 0;
        const enable = params.enable  ?? 0;
        const cmd    = hexToBytes(params.command ?? '0000', 2);
        const value  = params.value   ?? 16; // 16=System Off default
        bytes = [0x8b, idx, enable, ...cmd, value];
        break;
      }

      // ── Full inspection / command queries (advanced) ───────────────────────

      case 'request_check_order':
        bytes = [0xfe, params.order ?? 0];
        break;

      case 'all_configurations_request_by_device':
        bytes = [0xee];
        break;

      default:
        throw new Error(`WT303: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }
}