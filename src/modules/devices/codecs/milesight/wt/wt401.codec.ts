// src/modules/devices/codecs/milesight/wt/wt401.codec.ts
// Milesight WT401 — Smart Thermostat (BLE + LoRa, PIR occupancy, multi-mode HVAC)
//
// Wire protocol: FLAT COMMAND-ID
//   [cmd_id:1B][data:NB] ...  (multiple commands concatenated per frame)
//
// Temperature encoding: int16 LE / 100 = °C
// Humidity encoding:    uint16 LE / 10 = %rH
// Dead-zone encoding:   uint16 LE / 100 = °C
//
// processTemperature: adds celsius_* and fahrenheit_* aliases with per-field
// precision (matches reference decoder exactly, including precision=null → 0 dp).

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Low-level read helpers ────────────────────────────────────────────────────

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

// ── Array item helpers ────────────────────────────────────────────────────────

function pickArrayItem(array: any[], id: number, idName: string): any {
  for (const item of array) {
    if (item[idName] === id) return item;
  }
  return {};
}

function insertArrayItem(array: any[], item: any, idName: string): void {
  for (let i = 0; i < array.length; i++) {
    if (array[i][idName] === item[idName]) { array[i] = item; return; }
  }
  array.push(item);
}

// ── processTemperature ────────────────────────────────────────────────────────
// Mirrors the reference decoder exactly.
// precision: null → toFixed(null) in JS = toFixed(0) = 0 decimal places
// precision: number → toFixed(precision)

interface TempProp { precision: number | null; }

const TEMP_PROPS: Record<string, TempProp> = {
  'temperature':                                                    { precision: 1 },
  'target_temperature1':                                            { precision: 1 },
  'target_temperature2':                                            { precision: 1 },
  'target_temperature_settings.heat':                               { precision: null },
  'target_temperature_settings.em_heat':                            { precision: null },
  'target_temperature_settings.cool':                               { precision: null },
  'target_temperature_settings.auto':                               { precision: null },
  'target_temperature_settings.auto_heat':                          { precision: null },
  'target_temperature_settings.auto_cool':                          { precision: null },
  'minimum_dead_zone':                                              { precision: 1 },
  'target_temperature_range.heat.min':                              { precision: 1 },
  'target_temperature_range.heat.max':                              { precision: 1 },
  'target_temperature_range.em_heat.min':                           { precision: 1 },
  'target_temperature_range.em_heat.max':                           { precision: 1 },
  'target_temperature_range.cool.min':                              { precision: 1 },
  'target_temperature_range.cool.max':                              { precision: 1 },
  'target_temperature_range.auto.min':                              { precision: 1 },
  'target_temperature_range.auto.max':                              { precision: 1 },
  'temperature_calibration_settings.calibration_value':             { precision: 2 },
  'schedule_settings._item.content1.heat_target_temperature':       { precision: 1 },
  'schedule_settings._item.content1.em_heat_target_temperature':    { precision: 1 },
  'schedule_settings._item.content1.cool_target_temperature':       { precision: 1 },
  'schedule_settings._item.content2.auto_target_temperature':       { precision: 1 },
  'schedule_settings._item.content2.auto_heat_target_temperature':  { precision: 1 },
  'schedule_settings._item.content2.auto_cool_target_temperature':  { precision: 1 },
  'origin_temperature':                                             { precision: 1 },
};

function getAllLeafPaths(obj: any, prefix = ''): string[] {
  const paths: string[] = [];
  function recurse(cur: any, path: string) {
    if (Array.isArray(cur)) {
      cur.forEach((item, idx) => recurse(item, path ? `${path}.${idx}` : String(idx)));
    } else if (cur !== null && typeof cur === 'object') {
      for (const key of Object.keys(cur)) {
        recurse(cur[key], path ? `${path}.${key}` : key);
      }
    } else {
      paths.push(path);
    }
  }
  recurse(obj, prefix);
  return paths;
}

function getDeepPath(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return null;
    cur = cur[p];
  }
  return cur;
}

function setDeepPath(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function normalizeTempPath(path: string): string {
  // Replace array indices with _item
  let p = path.split('.').map((part) => (/^\d+$/.test(part) ? '_item' : part)).join('.');
  // Strip celsius_/fahrenheit_ prefixes from leaf segment
  const parts2 = p.split('.');
  const leaf = parts2[parts2.length - 1];
  parts2[parts2.length - 1] = leaf.replace(/^fahrenheit_/, '').replace(/^celsius_/, '');
  return parts2.join('.');
}

function processTemperature(decoded: any): void {
  const leafPaths = getAllLeafPaths(decoded);
  for (const propertyId of leafPaths) {
    // Normalize to canonical key form (strip array indices and celsius_/fahrenheit_ prefixes)
    const normalizedId = normalizeTempPath(propertyId);
    const prop = TEMP_PROPS[normalizedId];
    if (!prop) continue;

    // Strip celsius_/fahrenheit_ from actual property path for getting value
    const parts = propertyId.split('.');
    const leaf  = parts[parts.length - 1];
    const cleanLeaf = leaf.replace(/^fahrenheit_/, '').replace(/^celsius_/, '');
    parts[parts.length - 1] = cleanLeaf;
    const cleanPath = parts.join('.');

    const value = getDeepPath(decoded, cleanPath);
    if (value == null || typeof value !== 'number') continue;

    const precision = prop.precision ?? 0;
    const parentPath = parts.slice(0, -1).join('.');
    const cPath = parentPath ? `${parentPath}.celsius_${cleanLeaf}`    : `celsius_${cleanLeaf}`;
    const fPath = parentPath ? `${parentPath}.fahrenheit_${cleanLeaf}` : `fahrenheit_${cleanLeaf}`;

    setDeepPath(decoded, fPath, Number((value * 1.8 + 32).toFixed(precision)));
    setDeepPath(decoded, cPath, Number(value.toFixed(precision)));
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
  const [major, minor, release, alpha, unit_test, test] = [0,1,2,3,4,5].map(j => bytes[i+j] & 0xff);
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
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  while (bytes.length < len) bytes.push(0);
  return bytes.slice(0, len);
}

function stringToBytes(str: string, len: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80)        bytes.push(code);
    else if (code < 0x800)  bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else                    bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  while (bytes.length < len) bytes.push(0);
  return bytes.slice(0, len);
}

// ── Main codec class ──────────────────────────────────────────────────────────

export class MilesightWT401Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-wt401';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WT401'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const cmd = bytes[i++];

      switch (cmd) {

        // ── 0xff: check sequence number reply ─────────────────────────────────
        case 0xff:
          decoded.check_sequence_number_reply = decoded.check_sequence_number_reply ?? {};
          decoded.check_sequence_number_reply.sequence_number = readUInt8(bytes, i++);
          break;

        // ── 0xfe: check order reply ───────────────────────────────────────────
        case 0xfe:
          decoded.check_order_reply = 1;
          i++; // consume the order byte (echo only)
          break;

        // ── 0xef: command response ────────────────────────────────────────────
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

        // ── 0xee: all configurations request by device ────────────────────────
        case 0xee:
          decoded.all_configurations_request_by_device = 1;
          break;

        // ── 0xcf: LoRaWAN configuration settings ──────────────────────────────
        case 0xcf: {
          decoded.lorawan_configuration_settings = decoded.lorawan_configuration_settings ?? {};
          const sub = bytes[i++];
          if (sub === 0x00) decoded.lorawan_configuration_settings.mode = readUInt8(bytes, i++);
          break;
        }

        // ── 0xdf: TSL version ──────────────────────────────────────────────────
        case 0xdf:
          decoded.tsl_version = readProtocolVersion(bytes[i], bytes[i + 1]);
          i += 2;
          break;

        // ── 0xde: product name ────────────────────────────────────────────────
        case 0xde:
          decoded.product_name = readString(bytes, i, 32);
          i += 32;
          break;

        // ── 0xdd: product PN ──────────────────────────────────────────────────
        case 0xdd:
          decoded.product_pn = readString(bytes, i, 32);
          i += 32;
          break;

        // ── 0xdb: product SN ──────────────────────────────────────────────────
        case 0xdb:
          decoded.product_sn = readHexString(bytes, i, 8);
          i += 8;
          break;

        // ── 0xda: hardware + firmware version ─────────────────────────────────
        case 0xda:
          decoded.version = {
            hardware_version: readHardwareVersion(bytes[i], bytes[i + 1]),
            firmware_version: readFirmwareVersion(bytes, i + 2),
          };
          i += 8;
          break;

        // ── 0xd9: OEM ID ──────────────────────────────────────────────────────
        case 0xd9:
          decoded.oem_id = readHexString(bytes, i, 2);
          i += 2;
          break;

        // ── 0xd8: product frequency band ──────────────────────────────────────
        case 0xd8:
          decoded.product_frequency_band = readString(bytes, i, 16);
          i += 16;
          break;

        // ── 0xd5: BLE phone name ──────────────────────────────────────────────
        case 0xd5: {
          decoded.ble_phone_name = decoded.ble_phone_name ?? {};
          decoded.ble_phone_name.length = readUInt8(bytes, i++);
          decoded.ble_phone_name.value  = readString(bytes, i, decoded.ble_phone_name.length);
          i += decoded.ble_phone_name.length;
          break;
        }

        // ── 0x00: battery ─────────────────────────────────────────────────────
        case 0x00:
          decoded.battery = readUInt8(bytes, i++);
          break;

        // ── 0x01: temperature ─────────────────────────────────────────────────
        case 0x01:
          decoded.temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x02: humidity ────────────────────────────────────────────────────
        case 0x02:
          decoded.humidity = readUInt16LE(bytes, i) / 10;
          i += 2;
          break;

        // ── 0x08: PIR status ──────────────────────────────────────────────────
        case 0x08:
          // 0=Vacant, 1=Occupied, 2=Night Occupied
          decoded.pir_status = readUInt8(bytes, i++);
          break;

        // ── 0x03: temperature control mode ────────────────────────────────────
        case 0x03:
          // 0=heat, 1=em heat, 2=cool, 3=auto, 4=dehumidify, 5=ventilation, 10=off, 11=none
          decoded.temperature_mode = readUInt8(bytes, i++);
          break;

        // ── 0x06: target temperature 1 ────────────────────────────────────────
        case 0x06:
          decoded.target_temperature1 = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x07: target temperature 2 ────────────────────────────────────────
        case 0x07:
          decoded.target_temperature2 = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x04: fan mode ────────────────────────────────────────────────────
        case 0x04:
          // 0=auto, 1=circulate, 2=on, 3=low, 4=medium, 5=high, 10=off, 11=none/keep
          decoded.fan_mode = readUInt8(bytes, i++);
          break;

        // ── 0x05: execution plan ID ───────────────────────────────────────────
        case 0x05:
          decoded.execution_plan_id = readUInt8(bytes, i++);
          break;

        // ── 0x0b: temperature alarm ───────────────────────────────────────────
        case 0x0b:
          decoded.temperature_alarm = decoded.temperature_alarm ?? {};
          decoded.temperature_alarm.type = readUInt8(bytes, i++);
          break;

        // ── 0x0c: humidity alarm ──────────────────────────────────────────────
        case 0x0c:
          decoded.humidity_alarm = decoded.humidity_alarm ?? {};
          decoded.humidity_alarm.type = readUInt8(bytes, i++);
          break;

        // ── 0x09: BLE event ───────────────────────────────────────────────────
        case 0x09:
          decoded.ble_event = decoded.ble_event ?? {};
          decoded.ble_event.type = readUInt8(bytes, i++);
          break;

        // ── 0x0a: power bus event ─────────────────────────────────────────────
        case 0x0a:
          decoded.power_bus_event = decoded.power_bus_event ?? {};
          decoded.power_bus_event.type = readUInt8(bytes, i++);
          break;

        // ── 0x0d: key event ───────────────────────────────────────────────────
        case 0x0d: {
          decoded.key_event = decoded.key_event ?? {};
          const type = readUInt8(bytes, i++);
          decoded.key_event.type = type;
          if (type === 0x00) decoded.key_event.f1 = {};
          if (type === 0x01) decoded.key_event.f2 = {};
          if (type === 0x02) decoded.key_event.f3 = {};
          break;
        }

        // ── 0x0f: battery event ───────────────────────────────────────────────
        case 0x0f:
          decoded.battery_event = decoded.battery_event ?? {};
          decoded.battery_event.type = readUInt8(bytes, i++);
          break;

        // ── 0x60: collection interval ─────────────────────────────────────────
        case 0x60: {
          decoded.collection_interval = decoded.collection_interval ?? {};
          const unit = readUInt8(bytes, i++);
          decoded.collection_interval.unit = unit;
          if (unit === 0x00) { decoded.collection_interval.seconds_of_time = readUInt16LE(bytes, i); i += 2; }
          if (unit === 0x01) { decoded.collection_interval.minutes_of_time = readUInt16LE(bytes, i); i += 2; }
          break;
        }

        // ── 0x8d: communication mode ──────────────────────────────────────────
        case 0x8d:
          // 0=BLE, 1=LoRa, 2=BLE+LoRa, 3=PowerBus+LoRa
          decoded.communication_mode = readUInt8(bytes, i++);
          break;

        // ── 0x61: reporting interval ──────────────────────────────────────────
        case 0x61: {
          decoded.reporting_interval = decoded.reporting_interval ?? {};
          const riType = readUInt8(bytes, i++);
          const riMap: Record<number, string> = { 0x00: 'ble', 0x01: 'lora', 0x02: 'ble_lora', 0x03: 'power_lora' };
          const riKey = riMap[riType];
          if (riKey) {
            decoded.reporting_interval[riKey] = decoded.reporting_interval[riKey] ?? {};
            const obj = decoded.reporting_interval[riKey];
            const unit = readUInt8(bytes, i++);
            obj.unit = unit;
            if (unit === 0x00) { obj.seconds_of_time = readUInt16LE(bytes, i); i += 2; }
            if (unit === 0x01) { obj.minutes_of_time = readUInt16LE(bytes, i); i += 2; }
          }
          break;
        }

        // ── 0x6c: communicate interval ────────────────────────────────────────
        case 0x6c: {
          decoded.communicate_interval = decoded.communicate_interval ?? {};
          const ciId = readUInt8(bytes, i++);
          const ciMap: Record<number, string> = { 0x00: 'ble', 0x01: 'lora', 0x02: 'ble_lora', 0x03: 'power_bus' };
          const ciKey = ciMap[ciId];
          if (ciKey) {
            decoded.communicate_interval[ciKey] = decoded.communicate_interval[ciKey] ?? {};
            const obj = decoded.communicate_interval[ciKey];
            const unit = readUInt8(bytes, i++);
            obj.unit = unit;
            if (unit === 0x00) { obj.seconds_of_time = readUInt16LE(bytes, i); i += 2; }
            if (unit === 0x01) { obj.minutes_of_time = readUInt16LE(bytes, i); i += 2; }
          }
          break;
        }

        // ── 0xc8: device status ────────────────────────────────────────────────
        case 0xc8:
          // 0=Power Off, 1=Power On
          decoded.device_status = readUInt8(bytes, i++);
          break;

        // ── 0x63: temperature unit ────────────────────────────────────────────
        case 0x63:
          decoded.temperature_unit = readUInt8(bytes, i++);
          break;

        // ── 0x7d: data sync to peer ───────────────────────────────────────────
        case 0x7d:
          // 0=Embedded Data, 1=External Receive
          decoded.data_sync_to_peer = readUInt8(bytes, i++);
          break;

        // ── 0x7e: data sync timeout ───────────────────────────────────────────
        case 0x7e:
          decoded.data_sync_timeout = readUInt8(bytes, i++);
          break;

        // ── 0x85: BLE enable ──────────────────────────────────────────────────
        case 0x85:
          decoded.ble_enable = readUInt8(bytes, i++);
          break;

        // ── 0x8b: BLE name ────────────────────────────────────────────────────
        case 0x8b:
          decoded.ble_name = readString(bytes, i, 32);
          i += 32;
          break;

        // ── 0x67: system status ───────────────────────────────────────────────
        case 0x67:
          // 0=Off, 1=On
          decoded.system_status = readUInt8(bytes, i++);
          break;

        // ── 0x64: mode enable ─────────────────────────────────────────────────
        case 0x64: {
          decoded.mode_enable = decoded.mode_enable ?? {};
          const bits = readUInt8(bytes, i++);
          decoded.mode_enable.heat     = extractBits(bits, 0, 1);
          decoded.mode_enable.em_heat  = extractBits(bits, 1, 2);
          decoded.mode_enable.cool     = extractBits(bits, 2, 3);
          decoded.mode_enable.auto     = extractBits(bits, 3, 4);
          decoded.mode_enable.reserved = extractBits(bits, 6, 8);
          break;
        }

        // ── 0x88: fan enable ──────────────────────────────────────────────────
        case 0x88: {
          decoded.fan_enable = decoded.fan_enable ?? {};
          const bits = readUInt8(bytes, i++);
          decoded.fan_enable.auto     = extractBits(bits, 0, 1);
          decoded.fan_enable.circul   = extractBits(bits, 1, 2);
          decoded.fan_enable.on       = extractBits(bits, 2, 3);
          decoded.fan_enable.low      = extractBits(bits, 3, 4);
          decoded.fan_enable.medium   = extractBits(bits, 4, 5);
          decoded.fan_enable.high     = extractBits(bits, 5, 6);
          decoded.fan_enable.reserved = extractBits(bits, 6, 8);
          break;
        }

        // ── 0x68: temperature control mode settings ───────────────────────────
        case 0x68: {
          decoded.temperature_control_mode = decoded.temperature_control_mode ?? {};
          const sub = readUInt8(bytes, i++);
          if (sub === 0x00) {
            decoded.temperature_control_mode.mode = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            decoded.temperature_control_mode.plan_mode_enable = readUInt8(bytes, i++);
          }
          break;
        }

        // ── 0x65: target temperature mode ─────────────────────────────────────
        case 0x65:
          // 0=single, 1=dual
          decoded.target_temperature_mode = readUInt8(bytes, i++);
          break;

        // ── 0x66: target temperature resolution ───────────────────────────────
        case 0x66:
          // 0=0.5, 1=1
          decoded.target_temperature_resolution = readUInt8(bytes, i++);
          break;

        // ── 0x69: target temperature settings ────────────────────────────────
        case 0x69: {
          decoded.target_temperature_settings = decoded.target_temperature_settings ?? {};
          const sub = readUInt8(bytes, i++);
          const keyMap: Record<number, string> = {
            0x00: 'heat', 0x01: 'em_heat', 0x02: 'cool',
            0x03: 'auto', 0x04: 'auto_heat', 0x05: 'auto_cool',
          };
          const key = keyMap[sub];
          if (key) {
            decoded.target_temperature_settings[key] = readInt16LE(bytes, i) / 100;
            i += 2;
          }
          break;
        }

        // ── 0x6a: minimum dead zone ───────────────────────────────────────────
        case 0x6a:
          decoded.minimum_dead_zone = readUInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x6b: target temperature range ───────────────────────────────────
        case 0x6b: {
          decoded.target_temperature_range = decoded.target_temperature_range ?? {};
          const rangeId = readUInt8(bytes, i++);
          const rangeMap: Record<number, string> = { 0x00: 'heat', 0x01: 'em_heat', 0x02: 'cool', 0x03: 'auto' };
          const rKey = rangeMap[rangeId];
          if (rKey) {
            decoded.target_temperature_range[rKey] = {
              min: readInt16LE(bytes, i) / 100,
              max: readInt16LE(bytes, i + 2) / 100,
            };
            i += 4;
          }
          break;
        }

        // ── 0x74: fan control mode ────────────────────────────────────────────
        case 0x74:
          // 0=auto, 1=circulate, 2=on, 3=low, 4=medium, 5=high
          decoded.fan_control_mode = readUInt8(bytes, i++);
          break;

        // ── 0x82: PIR common ──────────────────────────────────────────────────
        case 0x82: {
          decoded.pir_common = decoded.pir_common ?? {};
          const sub = readUInt8(bytes, i++);
          if (sub === 0x01) {
            decoded.pir_common.enable = readUInt8(bytes, i++);
          } else if (sub === 0x02) {
            decoded.pir_common.release_time = readUInt16LE(bytes, i); i += 2;
          } else if (sub === 0x03) {
            // 0=Immediate Trigger, 1=Rule Trigger
            decoded.pir_common.mode = readUInt8(bytes, i++);
          } else if (sub === 0x04) {
            decoded.pir_common.check = decoded.pir_common.check ?? {};
            decoded.pir_common.check.period = readUInt8(bytes, i++);
            decoded.pir_common.check.rate   = readUInt8(bytes, i++);
          }
          break;
        }

        // ── 0x83: PIR energy ──────────────────────────────────────────────────
        case 0x83: {
          decoded.pir_energy = decoded.pir_energy ?? {};
          const sub = readUInt8(bytes, i++);
          if (sub === 0x01) {
            decoded.pir_energy.enable = readUInt8(bytes, i++);
          } else if (sub === 0x02) {
            decoded.pir_energy.plan = decoded.pir_energy.plan ?? {};
            decoded.pir_energy.plan.occupied   = readUInt8(bytes, i++);
            decoded.pir_energy.plan.unoccupied = readUInt8(bytes, i++);
          }
          break;
        }

        // ── 0x84: PIR night ───────────────────────────────────────────────────
        case 0x84: {
          decoded.pir_night = decoded.pir_night ?? {};
          const sub = readUInt8(bytes, i++);
          if (sub === 0x01) {
            decoded.pir_night.enable = readUInt8(bytes, i++);
          } else if (sub === 0x02) {
            decoded.pir_night.mode = readUInt8(bytes, i++);
          } else if (sub === 0x03) {
            decoded.pir_night.check = decoded.pir_night.check ?? {};
            decoded.pir_night.check.period = readUInt8(bytes, i++);
            decoded.pir_night.check.rate   = readUInt8(bytes, i++);
          } else if (sub === 0x04) {
            decoded.pir_night.night_time = decoded.pir_night.night_time ?? {};
            decoded.pir_night.night_time.start = readUInt16LE(bytes, i); i += 2;
            decoded.pir_night.night_time.stop  = readUInt16LE(bytes, i); i += 2;
          } else if (sub === 0x05) {
            decoded.pir_night.occupied = readUInt8(bytes, i++);
          }
          break;
        }

        // ── 0x75: screen display settings ─────────────────────────────────────
        case 0x75: {
          decoded.screen_display_settings = decoded.screen_display_settings ?? {};
          const bits = readUInt8(bytes, i++);
          decoded.screen_display_settings.plan_name    = extractBits(bits, 0, 1);
          decoded.screen_display_settings.ambient_temp = extractBits(bits, 1, 2);
          decoded.screen_display_settings.ambient_humi = extractBits(bits, 2, 3);
          decoded.screen_display_settings.target_temp  = extractBits(bits, 3, 4);
          decoded.screen_display_settings.reserved     = extractBits(bits, 4, 8);
          break;
        }

        // ── 0x71: button custom function ──────────────────────────────────────
        case 0x71: {
          decoded.button_custom_function = decoded.button_custom_function ?? {};
          const sub = readUInt8(bytes, i++);
          if (sub === 0x00) { decoded.button_custom_function.enable = readInt8(bytes,  i++); }
          if (sub === 0x01) { decoded.button_custom_function.mode1  = readUInt8(bytes, i++); }
          if (sub === 0x02) { decoded.button_custom_function.mode2  = readUInt8(bytes, i++); }
          if (sub === 0x03) { decoded.button_custom_function.mode3  = readUInt8(bytes, i++); }
          break;
        }

        // ── 0x72: children lock settings ──────────────────────────────────────
        case 0x72: {
          decoded.children_lock_settings = decoded.children_lock_settings ?? {};
          decoded.children_lock_settings.enable = readUInt8(bytes, i++);
          const bits = readUInt16LE(bytes, i); i += 2;
          decoded.children_lock_settings.temp_up                   = extractBits(bits,  0,  1);
          decoded.children_lock_settings.temp_down                 = extractBits(bits,  1,  2);
          decoded.children_lock_settings.system_on_off             = extractBits(bits,  2,  3);
          decoded.children_lock_settings.fan_mode                  = extractBits(bits,  3,  4);
          decoded.children_lock_settings.temperature_control_mode  = extractBits(bits,  4,  5);
          decoded.children_lock_settings.reboot_reset              = extractBits(bits,  5,  6);
          decoded.children_lock_settings.power_on_off              = extractBits(bits,  6,  7);
          decoded.children_lock_settings.cancel_pair               = extractBits(bits,  7,  8);
          decoded.children_lock_settings.plan_switch               = extractBits(bits,  8,  9);
          decoded.children_lock_settings.status_report             = extractBits(bits,  9, 10);
          decoded.children_lock_settings.filter_clean_alarm_release = extractBits(bits, 10, 11);
          decoded.children_lock_settings.button1_event             = extractBits(bits, 11, 12);
          decoded.children_lock_settings.button2_event             = extractBits(bits, 12, 13);
          decoded.children_lock_settings.button3_event             = extractBits(bits, 13, 14);
          decoded.children_lock_settings.temperature_unit_switch   = extractBits(bits, 14, 15);
          decoded.children_lock_settings.reserved                  = extractBits(bits, 15, 16);
          break;
        }

        // ── 0x81: unlock button ───────────────────────────────────────────────
        case 0x81:
          decoded.unlock_button = decoded.unlock_button ?? {};
          decoded.unlock_button.enable  = readUInt8(bytes, i++);
          decoded.unlock_button.timeout = readUInt16LE(bytes, i); i += 2;
          break;

        // ── 0x80: unlock combination button settings ──────────────────────────
        case 0x80: {
          decoded.unlock_combination_button_settings = decoded.unlock_combination_button_settings ?? {};
          const bits = readUInt8(bytes, i++);
          decoded.unlock_combination_button_settings.button1  = extractBits(bits, 0, 1);
          decoded.unlock_combination_button_settings.button2  = extractBits(bits, 1, 2);
          decoded.unlock_combination_button_settings.button3  = extractBits(bits, 2, 3);
          decoded.unlock_combination_button_settings.button4  = extractBits(bits, 3, 4);
          decoded.unlock_combination_button_settings.button5  = extractBits(bits, 4, 5);
          decoded.unlock_combination_button_settings.reserved = extractBits(bits, 5, 8);
          break;
        }

        // ── 0x62: intelligent display enable ──────────────────────────────────
        case 0x62:
          decoded.intelligent_display_enable = readUInt8(bytes, i++);
          break;

        // ── 0xc7: time zone ───────────────────────────────────────────────────
        case 0xc7:
          decoded.time_zone = readInt16LE(bytes, i);
          i += 2;
          break;

        // ── 0xc6: daylight saving time ────────────────────────────────────────
        case 0xc6: {
          decoded.daylight_saving_time = decoded.daylight_saving_time ?? {};
          decoded.daylight_saving_time.enable = readUInt8(bytes, i++);
          decoded.daylight_saving_time.daylight_saving_time_offset = readUInt8(bytes, i++);
          decoded.daylight_saving_time.start_month    = readUInt8(bytes, i++);
          const swb = readUInt8(bytes, i++);
          decoded.daylight_saving_time.start_week_num = extractBits(swb, 4, 8);
          decoded.daylight_saving_time.start_week_day = extractBits(swb, 0, 4);
          decoded.daylight_saving_time.start_hour_min = readUInt16LE(bytes, i); i += 2;
          decoded.daylight_saving_time.end_month      = readUInt8(bytes, i++);
          const ewb = readUInt8(bytes, i++);
          decoded.daylight_saving_time.end_week_num   = extractBits(ewb, 4, 8);
          decoded.daylight_saving_time.end_week_day   = extractBits(ewb, 0, 4);
          decoded.daylight_saving_time.end_hour_min   = readUInt16LE(bytes, i); i += 2;
          break;
        }

        // ── 0x76: temperature calibration settings ────────────────────────────
        case 0x76:
          decoded.temperature_calibration_settings = {
            enable:            readUInt8(bytes, i++),
            calibration_value: readInt16LE(bytes, i) / 100,
          };
          i += 2;
          break;

        // ── 0x77: humidity calibration settings ───────────────────────────────
        case 0x77:
          decoded.humidity_calibration_settings = {
            enable:            readUInt8(bytes, i++),
            calibration_value: readInt16LE(bytes, i) / 10,
          };
          i += 2;
          break;

        // ── 0x7b: schedule settings ───────────────────────────────────────────
        case 0x7b: {
          decoded.schedule_settings = decoded.schedule_settings ?? [];
          const schedId = readUInt8(bytes, i++);
          const item    = pickArrayItem(decoded.schedule_settings, schedId, 'id');
          item.id = schedId;
          insertArrayItem(decoded.schedule_settings, item, 'id');
          const sub = readUInt8(bytes, i++);
          if (sub === 0x00) {
            item.enable = readUInt8(bytes, i++);
          } else if (sub === 0x01) {
            item.name_first = readString(bytes, i, 6); i += 6;
          } else if (sub === 0x02) {
            item.name_last = readString(bytes, i, 4); i += 4;
          } else if (sub === 0x03) {
            // content1: tstat_mode + heat + em_heat + cool target temps (int16/100 each)
            item.content1 = item.content1 ?? {};
            item.content1.tstat_mode               = readUInt8(bytes, i++);
            item.content1.heat_target_temperature    = readInt16LE(bytes, i) / 100; i += 2;
            item.content1.em_heat_target_temperature = readInt16LE(bytes, i) / 100; i += 2;
            item.content1.cool_target_temperature    = readInt16LE(bytes, i) / 100; i += 2;
          } else if (sub === 0x04) {
            // content2: fan_mode + auto/auto_heat/auto_cool target temps (int16/100 each)
            item.content2 = item.content2 ?? {};
            item.content2.fan_mode                      = readUInt8(bytes, i++);
            item.content2.auto_target_temperature        = readInt16LE(bytes, i) / 100; i += 2;
            item.content2.auto_heat_target_temperature   = readInt16LE(bytes, i) / 100; i += 2;
            item.content2.auto_cool_target_temperature   = readInt16LE(bytes, i) / 100; i += 2;
          }
          break;
        }

        // ── 0x59: system status control ───────────────────────────────────────
        case 0x59:
          decoded.system_status_control = decoded.system_status_control ?? {};
          decoded.system_status_control.on_off      = readUInt8(bytes, i++);
          decoded.system_status_control.mode        = readUInt8(bytes, i++);
          decoded.system_status_control.temperature1 = readInt16LE(bytes, i) / 100; i += 2;
          decoded.system_status_control.temperature2 = readInt16LE(bytes, i) / 100; i += 2;
          break;

        // ── 0x86: origin (external) temperature ──────────────────────────────
        case 0x86:
          decoded.origin_temperature = readInt16LE(bytes, i) / 100;
          i += 2;
          break;

        // ── 0x87: origin (external) humidity ─────────────────────────────────
        case 0x87:
          decoded.origin_humidity = readUInt16LE(bytes, i) / 10;
          i += 2;
          break;

        // ── 0x5c: insert temporary plan ───────────────────────────────────────
        case 0x5c:
          decoded.insert_temporary_plan = decoded.insert_temporary_plan ?? {};
          decoded.insert_temporary_plan.id = readUInt8(bytes, i++);
          break;

        // ── 0x55: fan error alarm ─────────────────────────────────────────────
        case 0x55:
          decoded.fan_error_alarm = decoded.fan_error_alarm ?? {};
          decoded.fan_error_alarm.mode = readUInt8(bytes, i++);
          break;

        // ── 0x5b: filter clean alarm ──────────────────────────────────────────
        case 0x5b:
          decoded.filter_clean_alarm = decoded.filter_clean_alarm ?? {};
          decoded.filter_clean_alarm.mode = readUInt8(bytes, i++);
          break;

        // ── 0x57: frost protection alarm ──────────────────────────────────────
        case 0x57:
          decoded.frost_protection_alarm = decoded.frost_protection_alarm ?? {};
          decoded.frost_protection_alarm.mode = readUInt8(bytes, i++);
          break;

        // ── 0x5a: open window alarm ───────────────────────────────────────────
        case 0x5a:
          decoded.open_window_alarm = decoded.open_window_alarm ?? {};
          decoded.open_window_alarm.mode = readUInt8(bytes, i++);
          break;

        // ── 0x58: not wired alarm ─────────────────────────────────────────────
        case 0x58:
          decoded.not_wired_alarm = decoded.not_wired_alarm ?? {};
          decoded.not_wired_alarm.mode = readUInt8(bytes, i++);
          break;

        // ── Service commands (uplink echo) ────────────────────────────────────
        case 0xbe: decoded.reboot             = 1; break;
        case 0xb9: decoded.query_device_status = 1; break;
        case 0xb8: decoded.synchronize_time   = 1; break;
        case 0xb6: decoded.reconnect          = 1; break;

        case 0x5f:
          decoded.delete_task_plan = decoded.delete_task_plan ?? {};
          decoded.delete_task_plan.type = readUInt8(bytes, i++);
          break;

        default:
          decoded.raw_command_id = `0x${cmd.toString(16).padStart(2, '0')}`;
          i = bytes.length;
          break;
      }
    }

    processTemperature(decoded);
    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      // ── System / utility ──────────────────────────────────────────────────

      case 'reboot':                   bytes = [0xbe]; break;
      case 'query_device_status':      bytes = [0xb9]; break;
      case 'synchronize_time':         bytes = [0xb8]; break;
      case 'reconnect':                bytes = [0xb6]; break;

      case 'request_check_sequence_number': {
        const sn = params.sequence_number ?? 0;
        if (sn < 0 || sn > 255) throw new Error('sequence_number must be 0–255');
        bytes = [0xff, sn];
        break;
      }

      case 'request_check_order': {
        const order = params.order ?? 0;
        if (order < 0 || order > 255) throw new Error('order must be 0–255');
        bytes = [0xfe, order];
        break;
      }

      case 'request_query_all_configurations':
        bytes = [0xee];
        break;

      // ── LoRaWAN ───────────────────────────────────────────────────────────

      case 'set_lorawan_mode':
        // 0=ClassA, 1=ClassB, 2=ClassC, 3=ClassCtoB
        bytes = [0xcf, 0x00, params.mode ?? 0];
        break;

      // ── Identity ──────────────────────────────────────────────────────────

      case 'set_product_name':
        bytes = [0xde, ...stringToBytes(params.product_name ?? '', 32)];
        break;

      case 'set_product_pn':
        bytes = [0xdd, ...stringToBytes(params.product_pn ?? '', 32)];
        break;

      case 'set_product_sn':
        bytes = [0xdb, ...hexToBytes(params.product_sn ?? '0000000000000000', 8)];
        break;

      case 'set_oem_id':
        bytes = [0xd9, ...hexToBytes(params.oem_id ?? '0000', 2)];
        break;

      case 'set_ble_phone_name': {
        const val = params.value ?? '';
        const valBytes = stringToBytes(val, val.length);
        const len = Math.max(1, Math.min(64, valBytes.length || 1));
        if (len < 1 || len > 64) throw new Error('ble_phone_name.length must be 1–64');
        bytes = [0xd5, len, ...valBytes.slice(0, len)];
        break;
      }

      // ── Telemetry (uplink-style pushes) ───────────────────────────────────

      case 'set_origin_temperature': {
        const v = params.origin_temperature ?? 0;
        if (v < -20 || v > 60) throw new Error('origin_temperature must be -20–60');
        bytes = [0x86, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_origin_humidity': {
        const v = params.origin_humidity ?? 0;
        if (v < 0 || v > 100) throw new Error('origin_humidity must be 0–100');
        bytes = [0x87, ...writeUInt16LE(Math.round(v * 10))];
        break;
      }

      // ── Core thermostat state ─────────────────────────────────────────────

      case 'set_system_status':
        bytes = [0x67, params.system_status ?? 0];
        break;

      case 'set_temperature_unit':
        bytes = [0x63, params.temperature_unit ?? 0];
        break;

      case 'set_communication_mode': {
        const v = params.communication_mode ?? 1;
        if (v < 0 || v > 3) throw new Error('communication_mode must be 0–3');
        bytes = [0x8d, v];
        break;
      }

      case 'set_device_status':
        bytes = [0xc8, params.device_status ?? 1];
        break;

      case 'set_data_sync_to_peer':
        bytes = [0x7d, params.data_sync_to_peer ?? 0];
        break;

      case 'set_data_sync_timeout': {
        const v = params.data_sync_timeout ?? 10;
        if (v < 1 || v > 60) throw new Error('data_sync_timeout must be 1–60');
        bytes = [0x7e, v];
        break;
      }

      case 'set_ble_enable':
        bytes = [0x85, params.ble_enable ?? 1];
        break;

      case 'set_ble_name':
        bytes = [0x8b, ...stringToBytes(params.ble_name ?? '', 32)];
        break;

      case 'set_intelligent_display_enable':
        bytes = [0x62, params.intelligent_display_enable ?? 0];
        break;

      // ── Mode enables ──────────────────────────────────────────────────────

      case 'set_mode_enable': {
        let bits = 0;
        bits |= (params.heat     ?? 0) << 0;
        bits |= (params.em_heat  ?? 0) << 1;
        bits |= (params.cool     ?? 0) << 2;
        bits |= (params.auto     ?? 0) << 3;
        bits |= (params.reserved ?? 0) << 6;
        bytes = [0x64, bits];
        break;
      }

      case 'set_fan_enable': {
        let bits = 0;
        bits |= (params.auto     ?? 0) << 0;
        bits |= (params.circul   ?? 0) << 1;
        bits |= (params.on       ?? 0) << 2;
        bits |= (params.low      ?? 0) << 3;
        bits |= (params.medium   ?? 0) << 4;
        bits |= (params.high     ?? 0) << 5;
        bits |= (params.reserved ?? 0) << 6;
        bytes = [0x88, bits];
        break;
      }

      // ── Temperature control mode ──────────────────────────────────────────

      case 'set_temperature_control_mode': {
        const mode = params.mode ?? 0;
        if (mode < 0 || mode > 5) throw new Error('mode must be 0–5');
        bytes = [0x68, 0x00, mode];
        break;
      }

      case 'set_temperature_control_plan_mode_enable':
        bytes = [0x68, 0x01, params.plan_mode_enable ?? 0];
        break;

      case 'set_target_temperature_mode':
        bytes = [0x65, params.target_temperature_mode ?? 0];
        break;

      case 'set_target_temperature_resolution':
        bytes = [0x66, params.target_temperature_resolution ?? 0];
        break;

      case 'set_fan_control_mode': {
        const v = params.fan_control_mode ?? 0;
        if (v < 0 || v > 5) throw new Error('fan_control_mode must be 0–5');
        bytes = [0x74, v];
        break;
      }

      // ── Target temperature settings ───────────────────────────────────────

      case 'set_target_temperature_heat': {
        const v = params.heat ?? 17;
        if (v < 5 || v > 35) throw new Error('heat must be 5–35');
        bytes = [0x69, 0x00, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_em_heat': {
        const v = params.em_heat ?? 25;
        if (v < 5 || v > 35) throw new Error('em_heat must be 5–35');
        bytes = [0x69, 0x01, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_cool': {
        const v = params.cool ?? 28;
        if (v < 5 || v > 35) throw new Error('cool must be 5–35');
        bytes = [0x69, 0x02, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_auto': {
        const v = params.auto ?? 23;
        if (v < 5 || v > 35) throw new Error('auto must be 5–35');
        bytes = [0x69, 0x03, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_auto_heat': {
        const v = params.auto_heat ?? 17;
        if (v < 5 || v > 35) throw new Error('auto_heat must be 5–35');
        bytes = [0x69, 0x04, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_target_temperature_auto_cool': {
        const v = params.auto_cool ?? 28;
        if (v < 5 || v > 35) throw new Error('auto_cool must be 5–35');
        bytes = [0x69, 0x05, ...writeInt16LE(Math.round(v * 100))];
        break;
      }

      case 'set_minimum_dead_zone': {
        const v = params.minimum_dead_zone ?? 5;
        if (v < 1 || v > 30) throw new Error('minimum_dead_zone must be 1–30');
        bytes = [0x6a, ...writeUInt16LE(Math.round(v * 100))];
        break;
      }

      // ── Target temperature range ──────────────────────────────────────────

      case 'set_target_temperature_range_heat': {
        const min = params.min ?? 10; const max = params.max ?? 19;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('heat range min/max must be 5–35');
        bytes = [0x6b, 0x00, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      case 'set_target_temperature_range_em_heat': {
        const min = params.min ?? 10; const max = params.max ?? 27;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('em_heat range min/max must be 5–35');
        bytes = [0x6b, 0x01, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      case 'set_target_temperature_range_cool': {
        const min = params.min ?? 23; const max = params.max ?? 35;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('cool range min/max must be 5–35');
        bytes = [0x6b, 0x02, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      case 'set_target_temperature_range_auto': {
        const min = params.min ?? 10; const max = params.max ?? 35;
        if (min < 5 || min > 35 || max < 5 || max > 35) throw new Error('auto range min/max must be 5–35');
        bytes = [0x6b, 0x03, ...writeInt16LE(Math.round(min * 100)), ...writeInt16LE(Math.round(max * 100))];
        break;
      }

      // ── Intervals ─────────────────────────────────────────────────────────

      case 'set_collection_interval': {
        const unit = params.unit ?? 0;
        bytes = [0x60, unit];
        if (unit === 0) {
          const v = params.seconds_of_time ?? 30;
          if (v < 1 || v > 3600) throw new Error('seconds_of_time must be 1–3600');
          bytes.push(...writeUInt16LE(v));
        } else {
          const v = params.minutes_of_time ?? 1;
          if (v < 1 || v > 1440) throw new Error('minutes_of_time must be 1–1440');
          bytes.push(...writeUInt16LE(v));
        }
        break;
      }

      case 'set_reporting_interval_ble':
      case 'set_reporting_interval_lora':
      case 'set_reporting_interval_ble_lora':
      case 'set_reporting_interval_power_lora': {
        const subMap: Record<string, number> = {
          'set_reporting_interval_ble':        0x00,
          'set_reporting_interval_lora':       0x01,
          'set_reporting_interval_ble_lora':   0x02,
          'set_reporting_interval_power_lora': 0x03,
        };
        const unit = params.unit ?? 1;
        bytes = [0x61, subMap[type], unit];
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

      case 'set_communicate_interval_ble':
      case 'set_communicate_interval_lora':
      case 'set_communicate_interval_ble_lora':
      case 'set_communicate_interval_power_bus': {
        const ciSubMap: Record<string, number> = {
          'set_communicate_interval_ble':       0x00,
          'set_communicate_interval_lora':      0x01,
          'set_communicate_interval_ble_lora':  0x02,
          'set_communicate_interval_power_bus': 0x03,
        };
        const unit = params.unit ?? 1;
        bytes = [0x6c, ciSubMap[type], unit];
        if (unit === 0) {
          const v = params.seconds_of_time ?? 600;
          if (v < 10 || v > 1800) throw new Error('seconds_of_time must be 10–1800');
          bytes.push(...writeUInt16LE(v));
        } else {
          const v = params.minutes_of_time ?? 1;
          if (v < 1 || v > 30) throw new Error('minutes_of_time must be 1–30');
          bytes.push(...writeUInt16LE(v));
        }
        break;
      }

      // ── PIR ───────────────────────────────────────────────────────────────

      case 'set_pir_common_enable': {
        const v = params.enable ?? 1;
        if (v < 0 || v > 1) throw new Error('pir_common.enable must be 0–1');
        bytes = [0x82, 0x01, v];
        break;
      }

      case 'set_pir_common_release_time': {
        const v = params.release_time ?? 30;
        if (v < 1 || v > 360) throw new Error('release_time must be 1–360');
        bytes = [0x82, 0x02, ...writeUInt16LE(v)];
        break;
      }

      case 'set_pir_common_mode':
        bytes = [0x82, 0x03, params.mode ?? 0];
        break;

      case 'set_pir_common_check': {
        const period = params.period ?? 5;
        const rate   = params.rate   ?? 50;
        if (period < 1 || period > 60)  throw new Error('period must be 1–60');
        if (rate   < 1 || rate   > 100) throw new Error('rate must be 1–100');
        bytes = [0x82, 0x04, period, rate];
        break;
      }

      case 'set_pir_energy_enable': {
        const v = params.enable ?? 1;
        if (v < 0 || v > 1) throw new Error('pir_energy.enable must be 0–1');
        bytes = [0x83, 0x01, v];
        break;
      }

      case 'set_pir_energy_plan': {
        const occupied   = params.occupied   ?? 0;
        const unoccupied = params.unoccupied ?? 255;
        if (occupied < 0 || occupied > 255 || unoccupied < 0 || unoccupied > 255)
          throw new Error('pir_energy.plan occupied/unoccupied must be 0–255');
        bytes = [0x83, 0x02, occupied, unoccupied];
        break;
      }

      case 'set_pir_night_enable': {
        const v = params.enable ?? 0;
        if (v < 0 || v > 1) throw new Error('pir_night.enable must be 0–1');
        bytes = [0x84, 0x01, v];
        break;
      }

      case 'set_pir_night_mode':
        bytes = [0x84, 0x02, params.mode ?? 0];
        break;

      case 'set_pir_night_check': {
        const period = params.period ?? 5;
        const rate   = params.rate   ?? 50;
        if (period < 1 || period > 60)  throw new Error('period must be 1–60');
        if (rate   < 1 || rate   > 100) throw new Error('rate must be 1–100');
        bytes = [0x84, 0x03, period, rate];
        break;
      }

      case 'set_pir_night_time': {
        const start = params.start ?? 1260;
        const stop  = params.stop  ?? 480;
        if (start < 0 || start > 1439 || stop < 0 || stop > 1439)
          throw new Error('night_time start/stop must be 0–1439');
        bytes = [0x84, 0x04, ...writeUInt16LE(start), ...writeUInt16LE(stop)];
        break;
      }

      case 'set_pir_night_occupied': {
        const v = params.occupied ?? 255;
        if (v < 0 || v > 255) throw new Error('pir_night.occupied must be 0–255');
        bytes = [0x84, 0x05, v];
        break;
      }

      // ── Screen display ────────────────────────────────────────────────────

      case 'set_screen_display_settings': {
        let bits = 0;
        bits |= (params.plan_name    ?? 0) << 0;
        bits |= (params.ambient_temp ?? 0) << 1;
        bits |= (params.ambient_humi ?? 0) << 2;
        bits |= (params.target_temp  ?? 0) << 3;
        bits |= (params.reserved     ?? 0) << 4;
        bytes = [0x75, bits];
        break;
      }

      // ── Button custom function ────────────────────────────────────────────

      case 'set_button_custom_function_enable':
        bytes = [0x71, 0x00, params.enable ?? 0];
        break;

      case 'set_button1_function':
        bytes = [0x71, 0x01, params.mode1 ?? 1];
        break;

      case 'set_button2_function':
        bytes = [0x71, 0x02, params.mode2 ?? 2];
        break;

      case 'set_button3_function':
        bytes = [0x71, 0x03, params.mode3 ?? 0];
        break;

      // ── Child lock ────────────────────────────────────────────────────────

      case 'set_children_lock_settings': {
        const enable = params.enable ?? 0;
        let bits = 0;
        bits |= (params.temp_up                    ?? 0) <<  0;
        bits |= (params.temp_down                  ?? 0) <<  1;
        bits |= (params.system_on_off              ?? 0) <<  2;
        bits |= (params.fan_mode                   ?? 0) <<  3;
        bits |= (params.temperature_control_mode   ?? 0) <<  4;
        bits |= (params.reboot_reset               ?? 0) <<  5;
        bits |= (params.power_on_off               ?? 0) <<  6;
        bits |= (params.cancel_pair                ?? 0) <<  7;
        bits |= (params.plan_switch                ?? 0) <<  8;
        bits |= (params.status_report              ?? 0) <<  9;
        bits |= (params.filter_clean_alarm_release ?? 0) << 10;
        bits |= (params.button1_event              ?? 0) << 11;
        bits |= (params.button2_event              ?? 0) << 12;
        bits |= (params.button3_event              ?? 0) << 13;
        bits |= (params.temperature_unit_switch    ?? 0) << 14;
        bits |= (params.reserved                   ?? 0) << 15;
        bytes = [0x72, enable, ...writeUInt16LE(bits)];
        break;
      }

      case 'set_unlock_button': {
        const enable  = params.enable  ?? 0;
        const timeout = params.timeout ?? 30;
        if (timeout < 1 || timeout > 3600) throw new Error('unlock_button.timeout must be 1–3600');
        bytes = [0x81, enable, ...writeUInt16LE(timeout)];
        break;
      }

      case 'set_unlock_combination_buttons': {
        let bits = 0;
        bits |= (params.button1  ?? 0) << 0;
        bits |= (params.button2  ?? 0) << 1;
        bits |= (params.button3  ?? 0) << 2;
        bits |= (params.button4  ?? 0) << 3;
        bits |= (params.button5  ?? 0) << 4;
        bits |= (params.reserved ?? 0) << 5;
        bytes = [0x80, bits];
        break;
      }

      // ── Time / DST ────────────────────────────────────────────────────────

      case 'set_time_zone': {
        const tz = params.time_zone ?? 0;
        if (tz < -720 || tz > 840) throw new Error('time_zone must be -720–840');
        bytes = [0xc7, ...writeInt16LE(tz)];
        break;
      }

      case 'set_daylight_saving_time': {
        const p      = params;
        const enable = p.enable ?? 0;
        const offset = p.daylight_saving_time_offset ?? 60;
        if (offset < 1 || offset > 120) throw new Error('daylight_saving_time_offset must be 1–120');
        const sm = p.start_month ?? 1;
        const em = p.end_month   ?? 1;
        if (sm < 1 || sm > 12 || em < 1 || em > 12) throw new Error('start_month/end_month must be 1–12');
        const swb = ((p.start_week_num ?? 1) << 4) | (p.start_week_day ?? 1);
        const ewb = ((p.end_week_num   ?? 1) << 4) | (p.end_week_day   ?? 1);
        const shm = p.start_hour_min ?? 0;
        const ehm = p.end_hour_min   ?? 0;
        if (shm < 0 || shm > 1380 || ehm < 0 || ehm > 1380) throw new Error('start/end hour_min must be 0–1380');
        bytes = [0xc6, enable, offset, sm, swb, ...writeUInt16LE(shm), em, ewb, ...writeUInt16LE(ehm)];
        break;
      }

      // ── Calibration ───────────────────────────────────────────────────────

      case 'set_temperature_calibration': {
        const enable = params.enable ?? 0;
        const val    = params.calibration_value ?? 0;
        if (val < -80 || val > 80) throw new Error('calibration_value must be -80–80');
        bytes = [0x76, enable, ...writeInt16LE(Math.round(val * 100))];
        break;
      }

      case 'set_humidity_calibration': {
        const enable = params.enable ?? 0;
        const val    = params.calibration_value ?? 0;
        if (val < -100 || val > 100) throw new Error('calibration_value must be -100–100');
        bytes = [0x77, enable, ...writeInt16LE(Math.round(val * 10))];
        break;
      }

      // ── Schedule settings ─────────────────────────────────────────────────

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

      case 'set_schedule_content1': {
        const id    = params.id ?? 0;
        const c     = params.content1 ?? {};
        const tmode = c.tstat_mode               ?? 0;
        const heat  = c.heat_target_temperature    ?? 19;
        const emh   = c.em_heat_target_temperature ?? 25;
        const cool  = c.cool_target_temperature    ?? 28;
        if (heat < 5 || heat > 35 || emh < 5 || emh > 35 || cool < 5 || cool > 35)
          throw new Error('content1 temperatures must be 5–35');
        bytes = [
          0x7b, id, 0x03, tmode,
          ...writeInt16LE(Math.round(heat * 100)),
          ...writeInt16LE(Math.round(emh  * 100)),
          ...writeInt16LE(Math.round(cool * 100)),
        ];
        break;
      }

      case 'set_schedule_content2': {
        const id   = params.id ?? 0;
        const c    = params.content2 ?? {};
        const fan  = c.fan_mode                      ?? 0;
        const auto = c.auto_target_temperature        ?? 23;
        const autH = c.auto_heat_target_temperature   ?? 17;
        const autC = c.auto_cool_target_temperature   ?? 28;
        if (auto < 5 || auto > 35 || autH < 5 || autH > 35 || autC < 5 || autC > 35)
          throw new Error('content2 temperatures must be 5–35');
        bytes = [
          0x7b, id, 0x04, fan,
          ...writeInt16LE(Math.round(auto * 100)),
          ...writeInt16LE(Math.round(autH * 100)),
          ...writeInt16LE(Math.round(autC * 100)),
        ];
        break;
      }

      // ── System status control ─────────────────────────────────────────────

      case 'system_status_control': {
        const on_off = params.on_off ?? 1;
        const mode   = params.mode   ?? 0;
        const temp1  = params.temperature1 ?? 17;
        const temp2  = params.temperature2 ?? 28;
        if (mode < 0 || mode > 5) throw new Error('system_status_control.mode must be 0–5');
        if (temp1 < 5 || temp1 > 35) throw new Error('temperature1 must be 5–35');
        bytes = [
          0x59, on_off, mode,
          ...writeInt16LE(Math.round(temp1 * 100)),
          ...writeInt16LE(Math.round(temp2 * 100)),
        ];
        break;
      }

      // ── Insert / delete plans ─────────────────────────────────────────────

      case 'insert_temporary_plan': {
        const id = params.id ?? 0;
        if (id < 0 || id > 15) throw new Error('insert_temporary_plan.id must be 0–15');
        bytes = [0x5c, id];
        break;
      }

      case 'delete_task_plan': {
        const t = params.type ?? 255;
        if (t < 0 || t > 255) throw new Error('delete_task_plan.type must be 0–255');
        bytes = [0x5f, t];
        break;
      }

      // ── Alarm actions ─────────────────────────────────────────────────────

      case 'set_fan_error_alarm':         bytes = [0x55, params.mode ?? 0]; break;
      case 'set_filter_clean_alarm':      bytes = [0x5b, params.mode ?? 0]; break;
      case 'set_frost_protection_alarm':  bytes = [0x57, params.mode ?? 0]; break;
      case 'set_open_window_alarm':       bytes = [0x5a, params.mode ?? 0]; break;
      case 'set_not_wired_alarm':         bytes = [0x58, params.mode ?? 0]; break;

      default:
        throw new Error(`WT401: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }
}