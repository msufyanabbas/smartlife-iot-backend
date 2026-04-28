// src/modules/devices/codecs/milesight/vs121.codec.ts
// Milesight VS121 — AI Workplace Occupancy Sensor
//
// Protocol: IPSO channel_id + channel_type (same family as EM300/WS101)
//
// Key telemetry channels:
//   0xFF 0x01 — protocol_version (1B)
//   0xFF 0x08 — sn (6B)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x1F — firmware_version (4B)   ← note: NOT 0x0A like EM300 family
//   0x04 0xC9 — people_count_all(1B) + region_count(1B) + region_mask(2B BE)
//   0x05 0xCC — people_in(2B LE) + people_out(2B LE)
//   0x06 0xCD — people_count_max(1B)
//   0x07 0xD5 — region_1..region_8 counts (8×1B)
//   0x08 0xD5 — region_9..region_16 counts (8×1B)
//   0x09 0xDA — a_to_a..a_to_d (4×2B LE)
//   0x0A 0xDA — b_to_a..b_to_d (4×2B LE)
//   0x0B 0xDA — c_to_a..c_to_d (4×2B LE)
//   0x0C 0xDA — d_to_a..d_to_d (4×2B LE)
//   0x0D 0xCC — people_total_in(2B LE) + people_total_out(2B LE)
//   0x0E 0xE4 — region(1B) + dwell_time_avg(2B LE) + dwell_time_max(2B LE)
//   0x0F 0x85 — timestamp(4B LE)
//   0x10 0xF7 — line_in(2B LE) + line_out(2B LE)
//   0x20 0xCE — history record (variable, starts with ts+type)
//
// Downlink response prefixes:
//   0xFF / 0xFE — standard responses
//   0xF9 / 0xF8 — extended responses (0xF8 carries a result flag byte)

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Low-level helpers ─────────────────────────────────────────────────────────

function readUInt8(bytes: number[], i: number): number {
  return bytes[i] & 0xff;
}

function readUInt16LE(bytes: number[], i: number): number {
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

function readInt16LE(bytes: number[], i: number): number {
  const v = readUInt16LE(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}

function readUInt16BE(bytes: number[], i: number): number {
  return ((bytes[i] << 8) | bytes[i + 1]) & 0xffff;
}

function readUInt24LE(bytes: number[], i: number): number {
  return ((bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) & 0xffffff;
}

function readUInt32LE(bytes: number[], i: number): number {
  return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
}

function readHexStr(bytes: number[], i: number, len: number): string {
  return bytes.slice(i, i + len)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

/** VS121 firmware version: 4 bytes, each decimal, joined with dots — e.g. "31.7.0.75" */
function readFirmwareVersion(bytes: number[], i: number): string {
  return [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]
    .map(b => (b & 0xff).toString(10))
    .join('.');
}

/** Hardware version: 2 bytes decimal — e.g. "1.0" */
function readHardwareVersion(bytes: number[], i: number): string {
  return `${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`;
}

function writeUInt8(v: number): number[] { return [v & 0xff]; }
function writeUInt16LE(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function writeUInt32LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
function writeUInt24LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

// ── History record decoder ────────────────────────────────────────────────────

function readHistoryData(bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  data.timestamp = readUInt32LE(bytes, offset);
  const dataType = readUInt8(bytes, offset + 4);
  offset += 5;

  switch (dataType) {
    case 0x01: // people count + region mask
      data.people_count_all = readUInt8(bytes, offset);
      data.region_count     = readUInt8(bytes, offset + 1);
      { const mask = readUInt16BE(bytes, offset + 2);
        for (let idx = 0; idx < data.region_count; idx++) {
          data[`region_${idx + 1}`] = (mask >> idx) & 1;
        } }
      offset += 4; break;
    case 0x02:
      data.people_in  = readUInt16LE(bytes, offset);
      data.people_out = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x03:
      data.people_count_max = readUInt8(bytes, offset);
      offset += 1; break;
    case 0x04:
      data.region_1_count = readUInt8(bytes, offset);
      data.region_2_count = readUInt8(bytes, offset + 1);
      data.region_3_count = readUInt8(bytes, offset + 2);
      data.region_4_count = readUInt8(bytes, offset + 3);
      offset += 4; break;
    case 0x05:
      data.region_5_count = readUInt8(bytes, offset);
      data.region_6_count = readUInt8(bytes, offset + 1);
      data.region_7_count = readUInt8(bytes, offset + 2);
      data.region_8_count = readUInt8(bytes, offset + 3);
      offset += 4; break;
    case 0x06:
      data.region_9_count  = readUInt8(bytes, offset);
      data.region_10_count = readUInt8(bytes, offset + 1);
      data.region_11_count = readUInt8(bytes, offset + 2);
      data.region_12_count = readUInt8(bytes, offset + 3);
      offset += 4; break;
    case 0x07:
      data.region_13_count = readUInt8(bytes, offset);
      data.region_14_count = readUInt8(bytes, offset + 1);
      data.region_15_count = readUInt8(bytes, offset + 2);
      data.region_16_count = readUInt8(bytes, offset + 3);
      offset += 4; break;
    case 0x08:
      data.a_to_a = readUInt16LE(bytes, offset);
      data.a_to_b = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x09:
      data.a_to_c = readUInt16LE(bytes, offset);
      data.a_to_d = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0a:
      data.b_to_a = readUInt16LE(bytes, offset);
      data.b_to_b = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0b:
      data.b_to_c = readUInt16LE(bytes, offset);
      data.b_to_d = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0c:
      data.c_to_a = readUInt16LE(bytes, offset);
      data.c_to_b = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0d:
      data.c_to_c = readUInt16LE(bytes, offset);
      data.c_to_d = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0e:
      data.d_to_a = readUInt16LE(bytes, offset);
      data.d_to_b = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x0f:
      data.d_to_c = readUInt16LE(bytes, offset);
      data.d_to_d = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x10:
      data.people_total_in  = readUInt16LE(bytes, offset);
      data.people_total_out = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    case 0x11:
      // region(1B) + dwell_avg(2B) + dwell_max(2B)
      data.dwell_time_avg = readUInt16LE(bytes, offset + 1);
      data.dwell_time_max = readUInt16LE(bytes, offset + 3);
      offset += 5; break;
    case 0x12:
      data.line_in  = readUInt16LE(bytes, offset);
      data.line_out = readUInt16LE(bytes, offset + 2);
      offset += 4; break;
    default:
      // Unknown history type — stop consuming
      break;
  }

  return { data, offset };
}

// ── Downlink response handlers ────────────────────────────────────────────────

function handleStdDownlink(channelType: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  switch (channelType) {
    case 0x03:
      data.from_now_on_report_interval = readUInt16LE(bytes, offset); offset += 2; break;
    case 0x04:
      data.confirm_mode_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x10:
      data.reboot = 'yes'; offset += 1; break;
    case 0x35:
      data.d2d_key = readHexStr(bytes, offset, 8); offset += 8; break;
    case 0x40:
      data.adr_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x43:
      data.report_regularly_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x44:
      data.people_count_change_report_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x45: {
      const modeMap: Record<number, string> = { 0: 'zero_to_nonzero', 1: 'once_result_change' };
      data.people_counting_report_mode = modeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x46:
      data.people_count_jitter_config = {
        enable: bytes[offset] === 1 ? 'enable' : 'disable',
        time:   readUInt16LE(bytes, offset + 1),
      };
      offset += 3; break;
    case 0x48:
      data.line_detect_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x50:
      data.region_people_counting_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x51:
      data.clear_cumulative_count = 'yes'; offset += 1; break;
    case 0x84:
      data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    default:
      offset += 1; break;
  }
  return { data, offset };
}

function handleExtDownlink(code: number, channelType: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};

  switch (channelType) {
    case 0x10: {
      const schemeMap: Record<number, string> = { 0: 'on_the_dot', 1: 'from_now_on' };
      data.periodic_report_scheme = schemeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x11: {
      const iMap: Record<number, string> = { 0: '5min', 1: '10min', 2: '15min', 3: '30min', 4: '1h', 5: '4h', 6: '6h', 7: '8h', 8: '12h' };
      data.on_the_dot_report_interval = iMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x3d:
      data.line_detect_report_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x85:
      data.rejoin_config = {
        enable:    bytes[offset] === 1 ? 'enable' : 'disable',
        max_count: readUInt8(bytes, offset + 1),
      };
      offset += 2; break;
    case 0x86:
      data.data_rate = readUInt8(bytes, offset); offset += 1; break;
    case 0x87:
      data.tx_power_level = readUInt8(bytes, offset); offset += 1; break;
    case 0x88: {
      const lvlMap: Record<number, string> = { 2: 'error', 4: 'debug' };
      data.log_level = lvlMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x8b: {
      const vMap: Record<number, string> = { 1: 'v1.0.2', 2: 'v1.0.3' };
      data.lorawan_version = vMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
    }
    case 0x8c:
      data.rx2_data_rate = readUInt8(bytes, offset); offset += 1; break;
    case 0x8d:
      data.rx2_frequency = readUInt32LE(bytes, offset); offset += 4; break;
    case 0x8e:
      data.d2d_occupied_config = {
        region:  readUInt8(bytes, offset) + 1,
        enable:  bytes[offset + 1] === 1 ? 'enable' : 'disable',
        command: readD2DCommand(bytes, offset + 2),
      };
      offset += 4; break;
    case 0x90:
      data.d2d_vacant_config = {
        region:     readUInt8(bytes, offset) + 1,
        enable:     bytes[offset + 1] === 1 ? 'enable' : 'disable',
        command:    readD2DCommand(bytes, offset + 2),
        delay_time: readUInt16LE(bytes, offset + 4),
      };
      offset += 6; break;
    case 0x91: {
      const modeMap: Record<number, string> = { 0: 'sync_from_gateway', 1: 'manual' };
      data.time_config = {
        mode:      modeMap[bytes[offset]] ?? 'unknown',
        timestamp: readUInt32LE(bytes, offset + 1),
      };
      offset += 5; break;
    }
    case 0x92:
      data.region_people_counting_dwell_config = {
        enable:         bytes[offset] === 1 ? 'enable' : 'disable',
        min_dwell_time: readUInt16LE(bytes, offset + 1),
      };
      offset += 3; break;
    case 0x93:
      data.report_with_timestamp = bytes[offset] === 1 ? 'yes' : 'no'; offset += 1; break;
    case 0x94:
      data.timed_reset_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x95: {
      const modeMap: Record<number, string> = { 0: 'modify', 1: 'add', 2: 'delete' };
      const weekMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const weekMask = readUInt8(bytes, offset + 2);
      const weekCycle: Record<string, string> = {};
      for (const [day, bit] of Object.entries(weekMap)) {
        weekCycle[day] = (weekMask >> bit) & 1 ? 'enable' : 'disable';
      }
      const schedule = {
        mode:       modeMap[bytes[offset]] ?? 'unknown',
        index:      readUInt8(bytes, offset + 1) + 1,
        week_cycle: weekCycle,
        time:       readUInt24LE(bytes, offset + 3),
      };
      if (!data.reset_cumulative_schedule) data.reset_cumulative_schedule = [];
      data.reset_cumulative_schedule.push(schedule);
      offset += 6; break;
    }
    case 0x96: {
      const dtMap: Record<number, string>  = { 0: 'mapped_region', 1: 'unmapped_region' };
      const rtMap: Record<number, string>  = { 0: 'occupancy', 1: 'region_people_counting' };
      data.detect_region_config = {
        enable:         bytes[offset] === 1 ? 'enable' : 'disable',
        detection_type: dtMap[bytes[offset + 1]] ?? 'unknown',
        reporting_type: rtMap[bytes[offset + 2]] ?? 'unknown',
      };
      offset += 3; break;
    }
    case 0x97: {
      const pcMap: Record<number, string> = { 0: 'region_people_counting', 1: 'line_crossing_counting', 2: 'people_flow_analysis' };
      data.time_schedule_config = {
        enable:               bytes[offset] === 1 ? 'enable' : 'disable',
        people_counting_type: pcMap[bytes[offset + 1]] ?? 'unknown',
      };
      offset += 2; break;
    }
    case 0x98:
      data.filter_u_turn_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x99: {
      const pcMap: Record<number, string> = { 0: 'region_people_counting', 1: 'line_crossing_counting', 2: 'people_flow_analysis' };
      const wdMap: Record<number, string> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
      const ts = {
        people_counting_type: pcMap[bytes[offset]] ?? 'unknown',
        period:               readUInt8(bytes, offset + 1) + 1,
        weekday:              wdMap[readUInt8(bytes, offset + 2)] ?? 'unknown',
        start_hour:           readUInt8(bytes, offset + 3),
        start_minute:         readUInt8(bytes, offset + 4),
        end_hour:             readUInt8(bytes, offset + 5),
        end_minute:           readUInt8(bytes, offset + 6),
      };
      if (!data.time_schedule) data.time_schedule = [];
      data.time_schedule.push(ts);
      offset += 7; break;
    }
    default:
      offset += 1; break;
  }

  // 0xF8 carries a result flag byte after the payload
  if (code === 0xf8) {
    const resultVal = readUInt8(bytes, offset);
    offset += 1;
    if (resultVal !== 0) {
      const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
      const req = { ...data };
      return {
        data: {
          device_response_result: {
            channel_type: channelType,
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

/** D2D command bytes: [LSB, MSB] → hex string MSB first */
function readD2DCommand(bytes: number[], offset: number): string {
  return ('0' + (bytes[offset + 1] & 0xff).toString(16)).slice(-2) +
         ('0' + (bytes[offset    ] & 0xff).toString(16)).slice(-2);
}

function d2dCommandBytes(cmd: string): number[] {
  // cmd is 4-hex-char string, MSB first → stored [LSB, MSB]
  return [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

// ── Main codec class ──────────────────────────────────────────────────────────

export class MilesightVS121Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs121';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS121'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute / version channels ────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.protocol_version = readUInt8(bytes, i++);
      }
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = readHexStr(bytes, i, 6); i += 6;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = readHardwareVersion(bytes, i); i += 2;
      }
      else if (ch === 0xff && ty === 0x1f) {
        // 4-byte firmware version, each byte decimal
        decoded.firmware_version = readFirmwareVersion(bytes, i); i += 4;
      }
      else if (ch === 0xff && ty === 0x0a) {
        // Some earlier firmwares use 0x0A for firmware version (2B)
        decoded.firmware_version = `${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
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

      // ── People count (0x04 0xC9) ─────────────────────────────────────────
      // people_count_all(1B) + region_count(1B) + region_mask(2B BE)
      else if (ch === 0x04 && ty === 0xc9) {
        decoded.people_count_all = readUInt8(bytes, i);
        decoded.region_count     = readUInt8(bytes, i + 1);
        const mask = readUInt16BE(bytes, i + 2);
        for (let idx = 0; idx < decoded.region_count; idx++) {
          decoded[`region_${idx + 1}`] = (mask >> idx) & 1;
        }
        i += 4;
      }

      // ── People in/out (0x05 0xCC) ─────────────────────────────────────────
      else if (ch === 0x05 && ty === 0xcc) {
        decoded.people_in  = readInt16LE(bytes, i);
        decoded.people_out = readInt16LE(bytes, i + 2);
        i += 4;
      }

      // ── People max (0x06 0xCD) ────────────────────────────────────────────
      else if (ch === 0x06 && ty === 0xcd) {
        decoded.people_count_max = readUInt8(bytes, i++);
      }

      // ── Region counts 1–8 (0x07 0xD5) ────────────────────────────────────
      else if (ch === 0x07 && ty === 0xd5) {
        for (let r = 1; r <= 8; r++) decoded[`region_${r}_count`] = readUInt8(bytes, i + r - 1);
        i += 8;
      }

      // ── Region counts 9–16 (0x08 0xD5) ───────────────────────────────────
      else if (ch === 0x08 && ty === 0xd5) {
        for (let r = 9; r <= 16; r++) decoded[`region_${r}_count`] = readUInt8(bytes, i + r - 9);
        i += 8;
      }

      // ── A flow (0x09 0xDA) ────────────────────────────────────────────────
      else if (ch === 0x09 && ty === 0xda) {
        decoded.a_to_a = readUInt16LE(bytes, i);
        decoded.a_to_b = readUInt16LE(bytes, i + 2);
        decoded.a_to_c = readUInt16LE(bytes, i + 4);
        decoded.a_to_d = readUInt16LE(bytes, i + 6);
        i += 8;
      }

      // ── B flow (0x0A 0xDA) ────────────────────────────────────────────────
      else if (ch === 0x0a && ty === 0xda) {
        decoded.b_to_a = readUInt16LE(bytes, i);
        decoded.b_to_b = readUInt16LE(bytes, i + 2);
        decoded.b_to_c = readUInt16LE(bytes, i + 4);
        decoded.b_to_d = readUInt16LE(bytes, i + 6);
        i += 8;
      }

      // ── C flow (0x0B 0xDA) ────────────────────────────────────────────────
      else if (ch === 0x0b && ty === 0xda) {
        decoded.c_to_a = readUInt16LE(bytes, i);
        decoded.c_to_b = readUInt16LE(bytes, i + 2);
        decoded.c_to_c = readUInt16LE(bytes, i + 4);
        decoded.c_to_d = readUInt16LE(bytes, i + 6);
        i += 8;
      }

      // ── D flow (0x0C 0xDA) ────────────────────────────────────────────────
      else if (ch === 0x0c && ty === 0xda) {
        decoded.d_to_a = readUInt16LE(bytes, i);
        decoded.d_to_b = readUInt16LE(bytes, i + 2);
        decoded.d_to_c = readUInt16LE(bytes, i + 4);
        decoded.d_to_d = readUInt16LE(bytes, i + 6);
        i += 8;
      }

      // ── People total in/out (0x0D 0xCC) ──────────────────────────────────
      else if (ch === 0x0d && ty === 0xcc) {
        decoded.people_total_in  = readUInt16LE(bytes, i);
        decoded.people_total_out = readUInt16LE(bytes, i + 2);
        i += 4;
      }

      // ── Dwell time (0x0E 0xE4) — region(1B) + avg(2B) + max(2B) ──────────
      else if (ch === 0x0e && ty === 0xe4) {
        // region byte consumed but not stored (matches reference decoder)
        decoded.dwell_time_avg = readUInt16LE(bytes, i + 1);
        decoded.dwell_time_max = readUInt16LE(bytes, i + 3);
        i += 5;
      }

      // ── Timestamp (0x0F 0x85) ─────────────────────────────────────────────
      else if (ch === 0x0f && ty === 0x85) {
        decoded.timestamp = readUInt32LE(bytes, i); i += 4;
      }

      // ── Line in/out (0x10 0xF7) ───────────────────────────────────────────
      else if (ch === 0x10 && ty === 0xf7) {
        decoded.line_in  = readUInt16LE(bytes, i);
        decoded.line_out = readUInt16LE(bytes, i + 2);
        i += 4;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const result = readHistoryData(bytes, i);
        i = result.offset;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(result.data);
      }

      // ── Standard downlink responses (0xFF / 0xFE prefix) ─────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = handleStdDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF9 / 0xF8 prefix) ─────────────────
      else if (ch === 0xf9 || ch === 0xf8) {
        const result = handleExtDownlink(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else {
        // Unknown channel — stop
        break;
      }
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

      case 'set_confirm_mode_enable':
        bytes = [0xff, 0x04, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_adr_enable':
        bytes = [0xff, 0x40, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_rejoin_config':
        bytes = [0xf9, 0x85, params.enable === 'enable' ? 1 : 0, params.max_count ?? 10];
        break;

      case 'set_data_rate':
        bytes = [0xf9, 0x86, params.data_rate ?? 0];
        break;

      case 'set_tx_power_level':
        bytes = [0xf9, 0x87, params.tx_power_level ?? 0];
        break;

      case 'set_lorawan_version': {
        const vMap: Record<string, number> = { 'v1.0.2': 1, 'v1.0.3': 2 };
        bytes = [0xf9, 0x8b, vMap[params.lorawan_version] ?? 1];
        break;
      }

      case 'set_rx2_data_rate':
        bytes = [0xf9, 0x8c, params.rx2_data_rate ?? 0];
        break;

      case 'set_rx2_frequency':
        bytes = [0xf9, 0x8d, ...writeUInt32LE(params.rx2_frequency ?? 923500000)];
        break;

      // ── D2D ───────────────────────────────────────────────────────────────
      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexToBytes(key)];
        break;
      }

      case 'set_d2d_occupied_config': {
        const region  = (params.region ?? 1) - 1;
        const enable  = params.enable === 'enable' ? 1 : 0;
        const cmd     = params.command ?? '0000';
        if (cmd.length !== 4) throw new Error('command must be 4 hex characters');
        bytes = [0xf9, 0x8e, region, enable, ...d2dCommandBytes(cmd)];
        break;
      }

      case 'set_d2d_vacant_config': {
        const region     = (params.region ?? 1) - 1;
        const enable     = params.enable === 'enable' ? 1 : 0;
        const cmd        = params.command ?? '0000';
        const delayTime  = params.delay_time ?? 0;
        if (cmd.length !== 4) throw new Error('command must be 4 hex characters');
        bytes = [0xf9, 0x90, region, enable, ...d2dCommandBytes(cmd), ...writeUInt16LE(delayTime)];
        break;
      }

      // ── Reporting ─────────────────────────────────────────────────────────
      case 'set_report_regularly_enable':
        bytes = [0xff, 0x43, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_periodic_report_scheme': {
        const schemeMap: Record<string, number> = { on_the_dot: 0, from_now_on: 1 };
        bytes = [0xf9, 0x10, schemeMap[params.scheme] ?? 0];
        break;
      }

      case 'set_on_the_dot_report_interval': {
        const iMap: Record<string, number> = { '5min': 0, '10min': 1, '15min': 2, '30min': 3, '1h': 4, '4h': 5, '6h': 6, '8h': 7, '12h': 8 };
        bytes = [0xf9, 0x11, iMap[params.interval] ?? 0];
        break;
      }

      case 'set_from_now_on_report_interval': {
        const v = params.interval ?? 60;
        if (v < 5 || v > 65535) throw new Error('interval must be 5–65535');
        bytes = [0xff, 0x03, ...writeUInt16LE(v)];
        break;
      }

      case 'set_people_counting_report_mode': {
        const modeMap: Record<string, number> = { zero_to_nonzero: 0, once_result_change: 1 };
        bytes = [0xff, 0x45, modeMap[params.mode] ?? 0];
        break;
      }

      case 'set_people_count_change_report_enable':
        bytes = [0xff, 0x44, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_people_count_jitter': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const time   = params.time ?? 2;
        if (time < 1 || time > 60) throw new Error('time must be 1–60');
        bytes = [0xff, 0x46, enable, ...writeUInt16LE(time)];
        break;
      }

      case 'set_report_with_timestamp':
        bytes = [0xf9, 0x93, params.enable === 'yes' ? 1 : 0];
        break;

      // ── Line detect ───────────────────────────────────────────────────────
      case 'set_line_detect_enable':
        bytes = [0xff, 0x48, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_line_detect_report_enable':
        bytes = [0xf9, 0x3d, params.enable === 'enable' ? 1 : 0];
        break;

      // ── Cumulative count ──────────────────────────────────────────────────
      case 'clear_cumulative_count':
        bytes = [0xff, 0x51, 0xff];
        break;

      case 'set_timed_reset_cumulative_enable':
        bytes = [0xf9, 0x94, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_reset_cumulative_schedule': {
        const modeMap: Record<string, number> = { modify: 0, add: 1, delete: 2 };
        const weekMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const mode  = modeMap[params.mode ?? 'modify'] ?? 0;
        const index = (params.index ?? 1) - 1;
        const wc    = params.week_cycle ?? {};
        let weekMask = 0;
        for (const [day, bit] of Object.entries(weekMap)) {
          if (wc[day] === 'enable' || wc[day] === 1) weekMask |= 1 << bit;
        }
        const time = params.time ?? 0;
        bytes = [0xf9, 0x95, mode, index, weekMask, ...writeUInt24LE(time)];
        break;
      }

      // ── Region / detection ────────────────────────────────────────────────
      case 'set_region_people_counting_enable':
        bytes = [0xff, 0x50, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_region_people_counting_dwell_config': {
        const enable       = params.enable === 'enable' ? 1 : 0;
        const minDwellTime = params.min_dwell_time ?? 5;
        bytes = [0xf9, 0x92, enable, ...writeUInt16LE(minDwellTime)];
        break;
      }

      case 'set_detect_region_config': {
        const detMap: Record<string, number> = { mapped_region: 0, unmapped_region: 1 };
        const repMap: Record<string, number> = { occupancy: 0, region_people_counting: 1 };
        const enable = params.enable === 'enable' ? 1 : 0;
        bytes = [
          0xf9, 0x96,
          enable,
          detMap[params.detection_type ?? 'mapped_region'] ?? 0,
          repMap[params.reporting_type ?? 'occupancy'] ?? 0,
        ];
        break;
      }

      // ── Time schedule ─────────────────────────────────────────────────────
      case 'set_time_schedule_config': {
        const pcMap: Record<string, number> = { region_people_counting: 0, line_crossing_counting: 1, people_flow_analysis: 2 };
        const enable = params.enable === 'enable' ? 1 : 0;
        bytes = [0xf9, 0x97, enable, pcMap[params.people_counting_type ?? 'region_people_counting'] ?? 0];
        break;
      }

      case 'set_time_schedule': {
        const pcMap: Record<string, number> = { region_people_counting: 0, line_crossing_counting: 1, people_flow_analysis: 2 };
        const wdMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
        const pct    = pcMap[params.people_counting_type ?? 'region_people_counting'] ?? 0;
        const period = (params.period ?? 1) - 1;
        const wd     = wdMap[params.weekday ?? 'sun'] ?? 0;
        const sh = params.start_hour   ?? 0;
        const sm = params.start_minute ?? 0;
        const eh = params.end_hour     ?? 23;
        const em = params.end_minute   ?? 59;
        if (period < 0 || period > 2) throw new Error('period must be 1–3');
        if (sh < 0 || sh > 23 || eh < 0 || eh > 23) throw new Error('hour must be 0–23');
        if (sm < 0 || sm > 59 || em < 0 || em > 59) throw new Error('minute must be 0–59');
        bytes = [0xf9, 0x99, pct, wd, period, sh, sm, eh, em];
        break;
      }

      // ── Time config ───────────────────────────────────────────────────────
      case 'set_time_config': {
        const modeMap: Record<string, number> = { sync_from_gateway: 0, manual: 1 };
        const mode = modeMap[params.mode ?? 'sync_from_gateway'] ?? 0;
        const ts   = params.timestamp ?? 0;
        bytes = [0xf9, 0x91, mode, ...writeUInt32LE(ts)];
        break;
      }

      // ── Misc ──────────────────────────────────────────────────────────────
      case 'set_filter_u_turn':
        bytes = [0xf9, 0x98, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_log_level': {
        const lvlMap: Record<string, number> = { error: 2, debug: 4 };
        const lvl = lvlMap[params.log_level] ?? 2;
        // reference encoder writes 4 bytes: F9 88 00 <level>
        bytes = [0xf9, 0x88, 0x00, lvl];
        break;
      }

      default:
        throw new Error(`VS121: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS121 is uniquely identified by its people-counting channels:
  //   0x04 0xC9 — people_count_all + region_mask
  //   0x05 0xCC — people_in / people_out
  //   0x07 0xD5 — region counts 1–8
  //   0x09 0xDA — A-flow matrix

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x04 && ty === 0xc9) return true;
      if (ch === 0x05 && ty === 0xcc) return true;
      if (ch === 0x07 && ty === 0xd5) return true;
      if (ch === 0x09 && ty === 0xda) return true;
      if (ch === 0x10 && ty === 0xf7) return true; // line in/out
    }
    return false;
  }
}