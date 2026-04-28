// src/modules/devices/codecs/milesight/vs321.codec.ts
// Milesight VS321 — Wireless AI Occupancy Sensor
//
// Protocol: IPSO channel_id + channel_type
//
// Telemetry channels:
//   0xFF 0x01 — ipso_version (1B, nibble-split)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0xFF — tsl_version (2B)
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0xFE — reset_event (1B)
//   0xFF 0x0B — device_status (1B)
//   0x01 0x75 — battery (uint8 %)
//   0x03 0x67 — temperature (int16 LE /10) or 0xFFFF → sensor_read_failed
//   0x04 0x68 — humidity (uint8 /2) or 0xFF → sensor_read_failed
//   0x05 0xFD — people_total_counts (uint16 LE)
//   0x06 0xFE — region occupancy: region_mask(2B) + region_data(2B), 10 regions
//   0x07 0xFF — illuminance_status (1B): 0=dim, 1=bright
//   0x08 0xF4 — confidence: reserved(1B) + detection_status(1B)
//   0x0A 0xEF — timestamp (uint32 LE)
//   0x83 0x67 — temperature alarm: temp(int16 LE /10) + alarm_type(1B)
//   0x84 0x68 — humidity alarm: hum(uint8 /2) + alarm_type(1B)
//   0x20 0xCE — history record (variable)
//
// Downlink: 0xFF/0xFE standard, 0xF9/0xF8 extended (0xF8 carries result flag)
// History fetch/stop via 0xFD prefix

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Low-level helpers ─────────────────────────────────────────────────────────

function readUInt8(bytes: number[], i: number): number { return bytes[i] & 0xff; }

function readUInt16LE(bytes: number[], i: number): number {
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

function readInt16LE(bytes: number[], i: number): number {
  const v = readUInt16LE(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function readUInt32LE(bytes: number[], i: number): number {
  return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
}

function writeUInt16LE(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function writeInt16LE(v: number): number[] {
  const u = v < 0 ? v + 0x10000 : v;
  return [u & 0xff, (u >> 8) & 0xff];
}
function writeUInt32LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function readHexStr(bytes: number[], i: number, len: number): string {
  return bytes.slice(i, i + len)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** D2D command: [LSB, MSB] → hex string MSB first */
function readD2DCommand(bytes: number[], i: number): string {
  return ('0' + (bytes[i + 1] & 0xff).toString(16)).slice(-2) +
         ('0' + (bytes[i    ] & 0xff).toString(16)).slice(-2);
}

function d2dCommandBytes(cmd: string): number[] {
  return [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

// ── Version readers ───────────────────────────────────────────────────────────

/** ipso_version: upper nibble = major, lower nibble = minor */
function readProtocolVersion(b: number): string {
  return `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
}

/** hardware_version: [hex(major), minor>>4] → "v{major}.{minor}" */
function readHardwareVersion(bytes: number[], i: number): string {
  return `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
}

/** firmware_version: [hex(major), hex(minor)] → "v{major}.{minor}" */
function readFirmwareVersion(bytes: number[], i: number): string {
  return `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
}

// ── Alarm config decoder (0xFF 0x06) ─────────────────────────────────────────
// data byte: bits[2:0]=condition, bits[5:3]=channel_id, bit[6]=reserved
// channel_id: 1=temperature, 2=humidity, 3=illuminance

function decodeAlarmConfig(bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };
  const byte0     = readUInt8(bytes, offset);
  const condition = condMap[byte0 & 0x07] ?? 'unknown';
  const chId      = (byte0 >>> 3) & 0x07;

  if (chId === 0x01) {
    data.temperature_alarm_config = {
      condition,
      threshold_min:  readInt16LE(bytes, offset + 1) / 10,
      threshold_max:  readInt16LE(bytes, offset + 3) / 10,
      lock_time:      readUInt16LE(bytes, offset + 5),
      continue_time:  readUInt16LE(bytes, offset + 7),
    };
  } else if (chId === 0x02) {
    data.humidity_alarm_config = {
      condition,
      threshold_min:  readUInt16LE(bytes, offset + 1) / 2,
      threshold_max:  readUInt16LE(bytes, offset + 3) / 2,
      lock_time:      readUInt16LE(bytes, offset + 5),
      continue_time:  readUInt16LE(bytes, offset + 7),
    };
  } else if (chId === 0x03) {
    data.illuminance_alarm_config = {
      condition,
      threshold_min:  readUInt16LE(bytes, offset + 1),
      threshold_max:  readUInt16LE(bytes, offset + 3),
      lock_time:      readUInt16LE(bytes, offset + 5),
      continue_time:  readUInt16LE(bytes, offset + 7),
    };
  }

  return { data, offset: offset + 9 };
}

// ── Region occupancy decoder ──────────────────────────────────────────────────
// region_mask(2B LE) + region_data(2B LE), bits 0–9 = regions 1–10

const REGION_KEYS = [
  'region_1', 'region_2', 'region_3', 'region_4', 'region_5',
  'region_6', 'region_7', 'region_8', 'region_9', 'region_10',
];

function decodeRegionOccupancy(bytes: number[], i: number, decoded: any): void {
  const mask  = readUInt16LE(bytes, i);
  const value = readUInt16LE(bytes, i + 2);
  for (let idx = 0; idx < REGION_KEYS.length; idx++) {
    const key = REGION_KEYS[idx];
    decoded[`${key}_enable`] = ((mask  >>> idx) & 1) === 1 ? 'enable'   : 'disable';
    decoded[key]             = ((value >>> idx) & 1) === 1 ? 'occupied' : 'vacant';
  }
}

// ── Downlink response handlers ────────────────────────────────────────────────

function handleStdDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  switch (ty) {
    case 0x02:
      data.collection_interval = readUInt16LE(bytes, offset); offset += 2; break;
    case 0x06: {
      const result = decodeAlarmConfig(bytes, offset);
      Object.assign(data, result.data);
      offset = result.offset; break;
    }
    case 0x10:
      data.reboot = 'yes'; offset += 1; break;
    case 0x35:
      data.d2d_key = readHexStr(bytes, offset, 8); offset += 8; break;
    case 0x40:
      data.adr_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x65:
      data.lora_port = readUInt8(bytes, offset); offset += 1; break;
    case 0x68:
      data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x69:
      data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x6a: {
      const t = readUInt8(bytes, offset);
      if (t === 0) data.retransmit_interval = readUInt16LE(bytes, offset + 1);
      else         data.resend_interval     = readUInt16LE(bytes, offset + 1);
      offset += 3; break;
    }
    case 0x6d:
      data.stop_transmit = 'yes'; offset += 1; break;
    case 0x84:
      data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x8e:
      // skip first byte (sub-type 0x00), then uint16 LE
      data.report_interval = readUInt16LE(bytes, offset + 1); offset += 3; break;
    case 0x96: {
      const cfg: Record<string, any> = {
        mode:               readUInt8(bytes, offset),
        enable:             bytes[offset + 1] === 1 ? 'enable' : 'disable',
        lora_uplink_enable: bytes[offset + 2] === 1 ? 'enable' : 'disable',
        d2d_cmd:            readD2DCommand(bytes, offset + 3),
        time:               readUInt16LE(bytes, offset + 5),
        time_enable:        bytes[offset + 7] === 1 ? 'enable' : 'disable',
      };
      if (!data.d2d_master_config) data.d2d_master_config = [];
      data.d2d_master_config.push(cfg);
      offset += 8; break;
    }
    default:
      offset += 1; break;
  }
  return { data, offset };
}

function handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  switch (ty) {
    case 0x10: {
      const typeMap: Record<number, string> = { 0: 'period', 1: 'immediately' };
      data.report_type = typeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x6b: {
      const modeMap: Record<number, string> = { 0: 'auto', 1: 'on' };
      data.detection_mode = modeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x6c:
      data.detect = 'yes'; offset += 1; break;
    case 0x6e:
      data.reset = 'yes'; offset += 1; break;
    default:
      offset += 1; break;
  }

  // 0xF8 carries result flag byte
  if (code === 0xf8) {
    const resultVal = readUInt8(bytes, offset);
    offset += 1;
    if (resultVal !== 0) {
      const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
      const req = { ...data };
      return {
        data: {
          device_response_result: {
            channel_type: ty,
            result:       resultMap[resultVal] ?? 'unknown',
            request:      req,
          },
        },
        offset,
      };
    }
  }

  return { data, offset };
}

// ── Main codec class ──────────────────────────────────────────────────────────

export class MilesightVS321Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs321';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS321'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute / version channels ──────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = readProtocolVersion(bytes[i++]);
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = readHardwareVersion(bytes, i); i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = readFirmwareVersion(bytes, i); i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = readHexStr(bytes, i, 8); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal'; i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Battery (0x01 0x75) ───────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = readUInt8(bytes, i);
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── Temperature (0x03 0x67) — int16 LE /10, 0xFFFF = read_failed ─────
      else if (ch === 0x03 && ty === 0x67) {
        const raw = readUInt16LE(bytes, i);
        if (raw === 0xffff) {
          decoded.temperature_sensor_status = 'read_failed';
        } else {
          decoded.temperature = readInt16LE(bytes, i) / 10;
        }
        i += 2;
      }

      // ── Humidity (0x04 0x68) — uint8 /2, 0xFF = read_failed ──────────────
      else if (ch === 0x04 && ty === 0x68) {
        const raw = readUInt8(bytes, i);
        if (raw === 0xff) {
          decoded.humidity_sensor_status = 'read_failed';
        } else {
          decoded.humidity = raw / 2;
        }
        i += 1;
      }

      // ── People total counts (0x05 0xFD) ───────────────────────────────────
      else if (ch === 0x05 && ty === 0xfd) {
        decoded.people_total_counts = readUInt16LE(bytes, i); i += 2;
      }

      // ── Region occupancy (0x06 0xFE) — mask(2B) + data(2B) ───────────────
      else if (ch === 0x06 && ty === 0xfe) {
        decodeRegionOccupancy(bytes, i, decoded); i += 4;
      }

      // ── Illuminance status (0x07 0xFF) — 0=dim, 1=bright ─────────────────
      else if (ch === 0x07 && ty === 0xff) {
        decoded.illuminance_status = bytes[i] === 1 ? 'bright' : 'dim'; i += 1;
      }

      // ── Detection/confidence status (0x08 0xF4) — reserved(1B) + status(1B)
      else if (ch === 0x08 && ty === 0xf4) {
        // first byte reserved, skip it
        decoded.detection_status = bytes[i + 1] === 1 ? 'unavailable' : 'normal';
        i += 2;
      }

      // ── Timestamp (0x0A 0xEF) ─────────────────────────────────────────────
      else if (ch === 0x0a && ty === 0xef) {
        decoded.timestamp = readUInt32LE(bytes, i); i += 4;
      }

      // ── Temperature alarm (0x83 0x67) — temp(int16 /10) + alarm(1B) ──────
      else if (ch === 0x83 && ty === 0x67) {
        decoded.temperature        = readInt16LE(bytes, i) / 10;
        decoded.temperature_alarm  = bytes[i + 2] === 1 ? 'threshold_alarm' : 'threshold_alarm_release';
        i += 3;
      }

      // ── Humidity alarm (0x84 0x68) — hum(uint8 /2) + alarm(1B) ──────────
      else if (ch === 0x84 && ty === 0x68) {
        decoded.humidity       = readUInt8(bytes, i) / 2;
        decoded.humidity_alarm = bytes[i + 1] === 1 ? 'threshold_alarm' : 'threshold_alarm_release';
        i += 2;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const entry: Record<string, any> = {};
        entry.timestamp = readUInt32LE(bytes, i);
        const mode = readUInt8(bytes, i + 4);
        if (mode === 0x00) {
          // people_total_counts
          entry.people_total_counts = readUInt16LE(bytes, i + 5);
          i += 7;
        } else if (mode === 0x01) {
          // region occupancy: mask(2B) + data(2B)
          const mask  = readUInt16LE(bytes, i + 5);
          const value = readUInt16LE(bytes, i + 7);
          for (let idx = 0; idx < REGION_KEYS.length; idx++) {
            const key = REGION_KEYS[idx];
            entry[`${key}_enable`] = ((mask  >>> idx) & 1) === 1 ? 'enable'   : 'disable';
            entry[key]             = ((value >>> idx) & 1) === 1 ? 'occupied' : 'vacant';
          }
          i += 9;
        } else {
          i += 5; // unknown mode — skip header only
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = handleStdDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF9 / 0xF8) ─────────────────────────
      else if (ch === 0xf9 || ch === 0xf8) {
        const result = handleExtDownlink(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      // ── System ────────────────────────────────────────────────────────────
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'detect':
        bytes = [0xf9, 0x6c, 0xff];
        break;

      case 'reset':
        bytes = [0xf9, 0x6e, 0xff];
        break;

      // ── Reporting / collection ─────────────────────────────────────────────
      case 'set_report_interval': {
        const v = params.report_interval ?? 10;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        // 0xFF 0x8E 0x00 + uint16 LE
        bytes = [0xff, 0x8e, 0x00, ...writeUInt16LE(v)];
        break;
      }

      case 'set_collection_interval': {
        const allowed = [2, 5, 10, 15, 30, 60];
        const v = params.collection_interval ?? 10;
        if (!allowed.includes(v)) throw new Error(`collection_interval must be one of ${allowed.join(', ')}`);
        bytes = [0xff, 0x02, ...writeUInt16LE(v)];
        break;
      }

      case 'set_report_type': {
        const typeMap: Record<string, number> = { period: 0, immediately: 1 };
        const v = typeMap[params.report_type ?? 'period'] ?? 0;
        bytes = [0xf9, 0x10, v];
        break;
      }

      case 'set_detection_mode': {
        const modeMap: Record<string, number> = { auto: 0, on: 1 };
        const v = modeMap[params.detection_mode ?? 'auto'] ?? 0;
        bytes = [0xf9, 0x6b, v];
        break;
      }

      case 'set_adr_enable':
        bytes = [0xff, 0x40, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_lora_port': {
        const v = params.lora_port ?? 85;
        if (v < 0 || v > 255) throw new Error('lora_port must be 0–255');
        bytes = [0xff, 0x65, v];
        break;
      }

      // ── Alarm configs ─────────────────────────────────────────────────────
      case 'set_temperature_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        // data byte: bits[2:0]=condition, bits[5:3]=1(temp), bit[6]=1(reserved)
        const dataByte = cond | (1 << 3) | (1 << 6);
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 0;
        const lock = params.lock_time ?? 0;
        const cont = params.continue_time ?? 0;
        bytes = [
          0xff, 0x06, dataByte,
          ...writeInt16LE(Math.round(min * 10)),
          ...writeInt16LE(Math.round(max * 10)),
          ...writeUInt16LE(lock),
          ...writeUInt16LE(cont),
        ];
        break;
      }

      case 'set_humidity_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (2 << 3) | (1 << 6);
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 0;
        const lock = params.lock_time ?? 0;
        const cont = params.continue_time ?? 0;
        bytes = [
          0xff, 0x06, dataByte,
          ...writeUInt16LE(Math.round(min * 2)),
          ...writeUInt16LE(Math.round(max * 2)),
          ...writeUInt16LE(lock),
          ...writeUInt16LE(cont),
        ];
        break;
      }

      case 'set_illuminance_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (3 << 3) | (1 << 6);
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 0;
        const lock = params.lock_time ?? 0;
        const cont = params.continue_time ?? 0;
        bytes = [
          0xff, 0x06, dataByte,
          ...writeUInt16LE(min),
          ...writeUInt16LE(max),
          ...writeUInt16LE(lock),
          ...writeUInt16LE(cont),
        ];
        break;
      }

      // ── D2D ───────────────────────────────────────────────────────────────
      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexToBytes(key)];
        break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_d2d_master_config': {
        const mode               = params.mode               ?? 0;
        const enable             = params.enable             === 'enable' ? 1 : 0;
        const loraUplink         = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd                = params.d2d_cmd            ?? '0000';
        const time               = params.time               ?? 0;
        const timeEnable         = params.time_enable        === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [
          0xff, 0x96,
          mode & 0xff,
          enable,
          loraUplink,
          ...d2dCommandBytes(cmd),
          ...writeUInt16LE(time),
          timeEnable,
        ];
        break;
      }

      // ── History / retransmit ──────────────────────────────────────────────
      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('retransmit_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x00, ...writeUInt16LE(v)];
        break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('resend_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x01, ...writeUInt16LE(v)];
        break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        if (end === 0) {
          bytes = [0xfd, 0x6b, ...writeUInt32LE(start)];
        } else {
          bytes = [0xfd, 0x6c, ...writeUInt32LE(start), ...writeUInt32LE(end)];
        }
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff];
        break;

      default:
        throw new Error(`VS321: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS321 is uniquely identified by:
  //   0x05 0xFD — people_total_counts
  //   0x06 0xFE — region occupancy
  //   0x07 0xFF — illuminance_status
  //   0x08 0xF4 — detection/confidence status

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x05 && ty === 0xfd) return true;
      if (ch === 0x06 && ty === 0xfe) return true;
      if (ch === 0x07 && ty === 0xff) return true;
      if (ch === 0x08 && ty === 0xf4) return true;
    }
    return false;
  }
}