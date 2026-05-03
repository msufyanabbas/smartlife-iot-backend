// src/modules/devices/codecs/milesight/vs133.codec.ts
// Milesight VS133 / VS135 — AI ToF People Counting Sensor
//
// Protocol: IPSO channel_id + channel_type
//
// Multi-line counting (up to 4 lines), child counting, region dwell,
// occlusion alarm, and history.
//
// Channel groups (by triplet offset):
//   Total IN   : 0x03, 0x06, 0x09, 0x0C  → line_{n}_total_in  (uint32 LE)
//   Total OUT  : 0x04, 0x07, 0x0A, 0x0D  → line_{n}_total_out (uint32 LE)
//   Period     : 0x05, 0x08, 0x0B, 0x0E  → line_{n}_period_in/out (uint16 LE each)
//   Child IN   : 0x11, 0x14, 0x17, 0x1A  → line_{n}_child_total_in
//   Child OUT  : 0x12, 0x15, 0x18, 0x1B  → line_{n}_child_total_out
//   Child Per  : 0x13, 0x16, 0x19, 0x1C  → line_{n}_child_period_in/out
//
// Special channels:
//   0x0F 0xE3 — region counts 1–4 (1B each)
//   0x1D 0xE3 — region child counts 1–4
//   0x10 0xE4 — dwell time: region(1B) + avg(2B) + max(2B)
//   0x1E 0xE4 — child dwell time
//   0x50 0xFC — occlusion alarm: reserved(1B) + node_id(1B) + type(1B)
//   0x20 0xCE — history record (ts + data_type + payload)
//
// Downlink: 0xFF/0xFE standard, 0xF9/0xF8 extended (0xF8 carries result flag)
// History (firmware ≥ v1.0.9): fetch/stop/clear via 0xFD prefix

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Channel group tables (mirrors reference decoder exactly) ──────────────────
const TOTAL_IN_CHNS  = [0x03, 0x06, 0x09, 0x0c];
const TOTAL_OUT_CHNS = [0x04, 0x07, 0x0a, 0x0d];
const PERIOD_CHNS    = [0x05, 0x08, 0x0b, 0x0e];
const CHILD_IN_CHNS  = [0x11, 0x14, 0x17, 0x1a];
const CHILD_OUT_CHNS = [0x12, 0x15, 0x18, 0x1b];
const CHILD_PER_CHNS = [0x13, 0x16, 0x19, 0x1c];

function includes(arr: number[], val: number): boolean {
  return arr.indexOf(val) !== -1;
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function readUInt8(bytes: number[], i: number): number {
  return bytes[i] & 0xff;
}

function readUInt16LE(bytes: number[], i: number): number {
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

function readUInt32LE(bytes: number[], i: number): number {
  return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
}

function writeUInt16LE(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function writeUInt32LE(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

// ── Version readers ───────────────────────────────────────────────────────────

/** ipso_version: upper nibble = major, lower nibble = minor → "v{major}.{minor}" */
function readProtocolVersion(b: number): string {
  return `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
}

/** hardware_version: [major, minor] decimal → "v{major}.{minor}" */
function readHardwareVersion(bytes: number[], i: number): string {
  return `v${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`;
}

/**
 * firmware_version: [serial, major, odm, minor] decimal
 * → "v{serial}.{major}.{odm}.{minor}"
 */
function readFirmwareVersion(bytes: number[], i: number): string {
  return `v${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}.${bytes[i + 2] & 0xff}.${bytes[i + 3] & 0xff}`;
}

function readSerialNumber(bytes: number[], i: number, len: number): string {
  return bytes.slice(i, i + len)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
    .join('');
}

// ── History record decoder ────────────────────────────────────────────────────

function readHistory(bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  data.timestamp = readUInt32LE(bytes, offset);
  const dataType = readUInt8(bytes, offset + 4);
  let i = offset + 5;

  switch (dataType) {
    // Line 1–4 total in/out and period (0x03–0x0E)
    case 0x03: data.line_1_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x04: data.line_1_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x05:
      data.line_1_period_in  = readUInt16LE(bytes, i);
      data.line_1_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x06: data.line_2_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x07: data.line_2_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x08:
      data.line_2_period_in  = readUInt16LE(bytes, i);
      data.line_2_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x09: data.line_3_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x0a: data.line_3_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x0b:
      data.line_3_period_in  = readUInt16LE(bytes, i);
      data.line_3_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x0c: data.line_4_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x0d: data.line_4_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x0e:
      data.line_4_period_in  = readUInt16LE(bytes, i);
      data.line_4_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;

    // Region count + dwell
    case 0x0f:
      data.region_1_count = readUInt8(bytes, i);
      data.region_2_count = readUInt8(bytes, i + 1);
      data.region_3_count = readUInt8(bytes, i + 2);
      data.region_4_count = readUInt8(bytes, i + 3);
      i += 4; break;
    case 0x10: {
      const r = readUInt8(bytes, i);
      data[`region_${r}_avg_dwell`] = readUInt16LE(bytes, i + 1);
      i += 3; break;
    }
    case 0x20: {
      const r = readUInt8(bytes, i);
      data[`region_${r}_max_dwell`] = readUInt16LE(bytes, i + 1);
      i += 3; break;
    }

    // Child line 1–4 total in/out and period (0x11–0x1C)
    case 0x11: data.line_1_child_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x12: data.line_1_child_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x13:
      data.line_1_child_period_in  = readUInt16LE(bytes, i);
      data.line_1_child_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x14: data.line_2_child_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x15: data.line_2_child_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x16:
      data.line_2_child_period_in  = readUInt16LE(bytes, i);
      data.line_2_child_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x17: data.line_3_child_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x18: data.line_3_child_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x19:
      data.line_3_child_period_in  = readUInt16LE(bytes, i);
      data.line_3_child_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;
    case 0x1a: data.line_4_child_total_in    = readUInt32LE(bytes, i); i += 4; break;
    case 0x1b: data.line_4_child_total_out   = readUInt32LE(bytes, i); i += 4; break;
    case 0x1c:
      data.line_4_child_period_in  = readUInt16LE(bytes, i);
      data.line_4_child_period_out = readUInt16LE(bytes, i + 2);
      i += 4; break;

    // Child region count + dwell
    case 0x1d:
      data.region_1_child_count = readUInt8(bytes, i);
      data.region_2_child_count = readUInt8(bytes, i + 1);
      data.region_3_child_count = readUInt8(bytes, i + 2);
      data.region_4_child_count = readUInt8(bytes, i + 3);
      i += 4; break;
    case 0x1e: {
      const r = readUInt8(bytes, i);
      data[`region_${r}_child_avg_dwell`] = readUInt16LE(bytes, i + 1);
      i += 3; break;
    }
    case 0x3c: {
      const r = readUInt8(bytes, i);
      data[`region_${r}_child_max_dwell`] = readUInt16LE(bytes, i + 1);
      i += 3; break;
    }
    // Unknown — stop consuming
    default: break;
  }

  return { data, offset: i };
}

// ── Downlink response handlers ────────────────────────────────────────────────

function handleStdDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  switch (ty) {
    case 0x03:
      data.report_interval = readUInt16LE(bytes, offset); offset += 2; break;
    case 0x04:
      data.confirm_mode_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x10:
      data.reboot = 'yes'; offset += 1; break;
    case 0x11:
      data.timestamp = readUInt32LE(bytes, offset); offset += 4; break;
    case 0x27:
      data.clear_history = 'yes'; offset += 1; break;
    case 0x40:
      data.adr_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x42:
      data.wifi_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x43:
      data.periodic_report_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x44:
      data.trigger_report_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
    case 0x51:
      data.clear_total_count = 'yes'; offset += 1; break;
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
    case 0x6b:
      data.fetch_history = { start_time: readUInt32LE(bytes, offset) }; offset += 4; break;
    case 0x6c:
      data.fetch_history = {
        start_time: readUInt32LE(bytes, offset),
        end_time:   readUInt32LE(bytes, offset + 4),
      };
      offset += 8; break;
    case 0x6d:
      data.stop_transmit = 'yes'; offset += 1; break;
    default:
      offset += 1; break;
  }
  return { data, offset };
}

function handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
  const data: Record<string, any> = {};
  switch (ty) {
    case 0x84:
      data.sync_time_from_gateway_config = {
        enable: bytes[offset] === 1 ? 'enable' : 'disable',
        period: readUInt16LE(bytes, offset + 1),
      };
      offset += 3; break;
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
      const lvlMap: Record<number, string> = { 1: 'fatal', 2: 'error', 3: 'warning', 4: 'debug', 5: 'trace' };
      data.log_config = {
        console_log_level: lvlMap[bytes[offset]]     ?? 'unknown',
        file_log_level:    lvlMap[bytes[offset + 1]] ?? 'unknown',
      };
      offset += 2; break;
    }
    default:
      offset += 1; break;
  }

  // 0xF8 carries a result flag byte
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

export class MilesightVS133Codec extends BaseDeviceCodec {
  readonly codecId: string = 'milesight-vs133';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels: string[] = ['VS133'];
  readonly protocol        = 'lorawan' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/vs-series/vs133/vs133.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'VS133',
    description:  'AI ToF People Counting Sensor — up to 4 lines, child counting, region dwell, and occlusion alarm',
    telemetryKeys: [
      { key: 'line_1_total_in',    label: 'Line 1 Total In',    type: 'number' as const },
      { key: 'line_1_total_out',   label: 'Line 1 Total Out',   type: 'number' as const },
      { key: 'line_1_period_in',   label: 'Line 1 Period In',   type: 'number' as const },
      { key: 'line_1_period_out',  label: 'Line 1 Period Out',  type: 'number' as const },
      { key: 'line_2_total_in',    label: 'Line 2 Total In',    type: 'number' as const },
      { key: 'line_2_total_out',   label: 'Line 2 Total Out',   type: 'number' as const },
      { key: 'line_2_period_in',   label: 'Line 2 Period In',   type: 'number' as const },
      { key: 'line_2_period_out',  label: 'Line 2 Period Out',  type: 'number' as const },
      { key: 'line_3_total_in',    label: 'Line 3 Total In',    type: 'number' as const },
      { key: 'line_3_total_out',   label: 'Line 3 Total Out',   type: 'number' as const },
      { key: 'line_4_total_in',    label: 'Line 4 Total In',    type: 'number' as const },
      { key: 'line_4_total_out',   label: 'Line 4 Total Out',   type: 'number' as const },
      { key: 'region_1_count',     label: 'Region 1 Count',     type: 'number' as const },
      { key: 'region_2_count',     label: 'Region 2 Count',     type: 'number' as const },
      { key: 'region_3_count',     label: 'Region 3 Count',     type: 'number' as const },
      { key: 'region_4_count',     label: 'Region 4 Count',     type: 'number' as const },
      { key: 'line_1_child_total_in',  label: 'Line 1 Child Total In',  type: 'number' as const },
      { key: 'line_1_child_total_out', label: 'Line 1 Child Total Out', type: 'number' as const },
    ],
    commands: [
      { type: 'reboot',           label: 'Reboot Device',    params: [] },
      { type: 'clear_total_count', label: 'Clear Total Count', params: [] },
      { type: 'clear_history',    label: 'Clear History',    params: [] },
      { type: 'stop_transmit',    label: 'Stop Transmit',    params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 60, min: 1, max: 64800 }],
      },
      {
        type:   'set_periodic_report_enable',
        label:  'Set Periodic Report Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_trigger_report_enable',
        label:  'Set Trigger Report Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmit_enable',
        label:  'Set Retransmit Enable',
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
      {
        type:   'set_rejoin_config',
        label:  'Set Rejoin Config',
        params: [
          { key: 'enable',    label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'max_count', label: 'Max Count', type: 'number'  as const, required: false, default: 10 },
        ],
      },
    ],
    uiComponents: [
      { type: 'value' as const, label: 'Line 1 Total In',   keys: ['line_1_total_in']   },
      { type: 'value' as const, label: 'Line 1 Total Out',  keys: ['line_1_total_out']  },
      { type: 'value' as const, label: 'Line 1 Period In',  keys: ['line_1_period_in']  },
      { type: 'value' as const, label: 'Line 1 Period Out', keys: ['line_1_period_out'] },
      { type: 'value' as const, label: 'Line 2 Total In',   keys: ['line_2_total_in']   },
      { type: 'value' as const, label: 'Line 2 Total Out',  keys: ['line_2_total_out']  },
      { type: 'value' as const, label: 'Region 1 Count',    keys: ['region_1_count']    },
      { type: 'value' as const, label: 'Region 2 Count',    keys: ['region_2_count']    },
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

      // ── Attribute / version channels ──────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = readProtocolVersion(bytes[i++]);
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = readHardwareVersion(bytes, i); i += 2;
      }
      else if (ch === 0xff && ty === 0x1f) {
        decoded.firmware_version = readFirmwareVersion(bytes, i); i += 4;
      }
      else if (ch === 0xff && ty === 0x0a) {
        // Legacy 2-byte firmware version
        decoded.firmware_version = `v${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = readSerialNumber(bytes, i, 8); i += 8;
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

      // ── Line total IN (0x03,0x06,0x09,0x0C — type 0xD2) ──────────────────
      else if (includes(TOTAL_IN_CHNS, ch) && ty === 0xd2) {
        const n = TOTAL_IN_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_total_in`] = readUInt32LE(bytes, i); i += 4;
      }
      // ── Line total OUT (0x04,0x07,0x0A,0x0D — type 0xD2) ─────────────────
      else if (includes(TOTAL_OUT_CHNS, ch) && ty === 0xd2) {
        const n = TOTAL_OUT_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_total_out`] = readUInt32LE(bytes, i); i += 4;
      }
      // ── Line period IN/OUT (0x05,0x08,0x0B,0x0E — type 0xCC) ─────────────
      else if (includes(PERIOD_CHNS, ch) && ty === 0xcc) {
        const n = PERIOD_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_period_in`]  = readUInt16LE(bytes, i);
        decoded[`line_${n}_period_out`] = readUInt16LE(bytes, i + 2);
        i += 4;
      }
      // ── Child line total IN (0x11,0x14,0x17,0x1A — type 0xD2) ────────────
      else if (includes(CHILD_IN_CHNS, ch) && ty === 0xd2) {
        const n = CHILD_IN_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_child_total_in`] = readUInt32LE(bytes, i); i += 4;
      }
      // ── Child line total OUT (0x12,0x15,0x18,0x1B — type 0xD2) ──────────
      else if (includes(CHILD_OUT_CHNS, ch) && ty === 0xd2) {
        const n = CHILD_OUT_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_child_total_out`] = readUInt32LE(bytes, i); i += 4;
      }
      // ── Child line period IN/OUT (0x13,0x16,0x19,0x1C — type 0xCC) ───────
      else if (includes(CHILD_PER_CHNS, ch) && ty === 0xcc) {
        const n = CHILD_PER_CHNS.indexOf(ch) + 1;
        decoded[`line_${n}_child_period_in`]  = readUInt16LE(bytes, i);
        decoded[`line_${n}_child_period_out`] = readUInt16LE(bytes, i + 2);
        i += 4;
      }

      // ── Region count (0x0F 0xE3) — 4 regions, 1B each ────────────────────
      else if (ch === 0x0f && ty === 0xe3) {
        decoded.region_1_count = readUInt8(bytes, i);
        decoded.region_2_count = readUInt8(bytes, i + 1);
        decoded.region_3_count = readUInt8(bytes, i + 2);
        decoded.region_4_count = readUInt8(bytes, i + 3);
        i += 4;
      }
      // ── Region child count (0x1D 0xE3) ────────────────────────────────────
      else if (ch === 0x1d && ty === 0xe3) {
        decoded.region_1_child_count = readUInt8(bytes, i);
        decoded.region_2_child_count = readUInt8(bytes, i + 1);
        decoded.region_3_child_count = readUInt8(bytes, i + 2);
        decoded.region_4_child_count = readUInt8(bytes, i + 3);
        i += 4;
      }

      // ── Dwell time (0x10 0xE4) — region(1B) + avg(2B) + max(2B) ──────────
      else if (ch === 0x10 && ty === 0xe4) {
        const r = readUInt8(bytes, i);
        decoded[`region_${r}_avg_dwell`] = readUInt16LE(bytes, i + 1);
        decoded[`region_${r}_max_dwell`] = readUInt16LE(bytes, i + 3);
        i += 5;
      }
      // ── Child dwell time (0x1E 0xE4) ──────────────────────────────────────
      else if (ch === 0x1e && ty === 0xe4) {
        const r = readUInt8(bytes, i);
        decoded[`region_${r}_child_avg_dwell`] = readUInt16LE(bytes, i + 1);
        decoded[`region_${r}_child_max_dwell`] = readUInt16LE(bytes, i + 3);
        i += 5;
      }

      // ── Occlusion alarm (0x50 0xFC) — reserved(1B) + node_id(1B) + type(1B)
      else if (ch === 0x50 && ty === 0xfc) {
        // bytes[i] = reserved, bytes[i+1] = node_id, bytes[i+2] = alarm_type
        const nodeId   = readUInt8(bytes, i + 1);
        const nodeName = nodeId === 0x00 ? 'master' : `node_${nodeId}`;
        const alarmMap: Record<number, string> = { 0: 'alarm_released', 1: 'alarm_triggered' };
        decoded[`${nodeName}_occlusion_alarm`] = alarmMap[bytes[i + 2]] ?? 'unknown';
        i += 3;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const result = readHistory(bytes, i);
        i = result.offset;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(result.data);
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

      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 64800) throw new Error('report_interval must be 1–64800');
        // Reference encoder: writeUInt16LE → 4 bytes total
        bytes = [0xff, 0x03, ...writeUInt16LE(v)];
        break;
      }

      case 'set_confirm_mode_enable':
        bytes = [0xff, 0x04, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_adr_enable':
        bytes = [0xff, 0x40, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_wifi_enable':
        bytes = [0xff, 0x42, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_periodic_report_enable':
        bytes = [0xff, 0x43, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_trigger_report_enable':
        bytes = [0xff, 0x44, params.enable === 'enable' ? 1 : 0];
        break;

      case 'clear_total_count':
        bytes = [0xff, 0x51, 0xff];
        break;

      case 'set_timestamp': {
        const ts = params.timestamp ?? 0;
        if (ts < 0) throw new Error('timestamp must be >= 0');
        bytes = [0xff, 0x11, ...writeUInt32LE(ts)];
        break;
      }

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 600;
        if (v < 1 || v > 64800) throw new Error('retransmit_interval must be 1–64800');
        bytes = [0xff, 0x6a, 0x00, ...writeUInt16LE(v)];
        break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 600;
        if (v < 1 || v > 64800) throw new Error('resend_interval must be 1–64800');
        bytes = [0xff, 0x6a, 0x01, ...writeUInt16LE(v)];
        break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0];
        break;

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        if (params.end_time !== undefined && params.end_time !== 0) {
          const end = params.end_time;
          if (start > end) throw new Error('start_time must be <= end_time');
          bytes = [0xfd, 0x6c, ...writeUInt32LE(start), ...writeUInt32LE(end)];
        } else {
          bytes = [0xfd, 0x6b, ...writeUInt32LE(start)];
        }
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff];
        break;

      case 'clear_history':
        bytes = [0xff, 0x27, 0x01];
        break;

      case 'set_sync_time_from_gateway': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const period = params.period ?? 10;
        bytes = [0xf9, 0x84, enable, ...writeUInt16LE(period)];
        break;
      }

      case 'set_rejoin_config': {
        const enable    = params.enable === 'enable' ? 1 : 0;
        const maxCount  = params.max_count ?? 10;
        bytes = [0xf9, 0x85, enable, maxCount & 0xff];
        break;
      }

      case 'set_data_rate':
        bytes = [0xf9, 0x86, params.data_rate ?? 0];
        break;

      case 'set_tx_power_level':
        bytes = [0xf9, 0x87, params.tx_power_level ?? 0];
        break;

      case 'set_log_config': {
        const lvlMap: Record<string, number> = { fatal: 1, error: 2, warning: 3, debug: 4, trace: 5 };
        const con  = lvlMap[params.console_log_level ?? 'error'] ?? 2;
        const file = lvlMap[params.file_log_level    ?? 'error'] ?? 2;
        bytes = [0xf9, 0x88, con, file];
        break;
      }

      default:
        throw new Error(`VS133: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS133/135 is uniquely identified by:
  //   - 0xD2 type on any of the 8 total counter channels (0x03–0x0D)
  //   - 0xCC type on any period channel beyond 0x05 (0x08, 0x0B, 0x0E)
  //   - Region count 0x0F 0xE3
  //   - Dwell 0x10 0xE4
  //   - Occlusion alarm 0x50 0xFC

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      // Total IN/OUT on any of the 4 line channels
      if ((includes(TOTAL_IN_CHNS, ch) || includes(TOTAL_OUT_CHNS, ch)) && ty === 0xd2) return true;
      // Period on line 2-4 (line 1 period 0x05 0xCC would also match VS132, so prefer lines 2-4)
      if (includes([0x08, 0x0b, 0x0e], ch) && ty === 0xcc) return true;
      // Region count, dwell, alarm — uniquely VS133/135
      if (ch === 0x0f && ty === 0xe3) return true;
      if (ch === 0x10 && ty === 0xe4) return true;
      if (ch === 0x50 && ty === 0xfc) return true;
      // Child channels
      if (includes(CHILD_IN_CHNS, ch)  && ty === 0xd2) return true;
      if (includes(CHILD_OUT_CHNS, ch) && ty === 0xd2) return true;
    }
    return false;
  }
}

// ── VS135 — thin subclass (identical protocol) ────────────────────────────────
export class MilesightVS135Codec extends MilesightVS133Codec {
  override readonly codecId         = 'milesight-vs135';
  override readonly supportedModels = ['VS135'];
  getCapabilities(): DeviceCapability {
  return { ...super.getCapabilities(), codecId: this.codecId, model: 'VS135' };
}
}