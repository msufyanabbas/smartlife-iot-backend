// src/modules/devices/codecs/milesight/gs101.codec.ts
// Milesight GS101 — LoRaWAN Gas Detector with Valve & Relay Control
//
// Protocol: IPSO channel_id + channel_type (same family as TS101/TS301)
//
// Telemetry:
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//   0x05 0x8E — gas_status (1B: 0=normal, 1=alarm)
//   0x06 0x01 — valve_status (1B: 0=off, 1=on)
//   0x07 0x01 — relay_output_status (1B: 0=off, 1=on)
//   0x08 0x90 — life_remain (4B uint32 LE, seconds)
//   0xFF 0x3F — alarm (1B enum: 0=power off, 1=power on, 2=device fault,
//                       3=device fault recovered, 4=device will be invalid soon,
//                       5=device invalid)
//
// Downlink responses (via 0xFE channel):
//   0xFE 0x03 — report_interval (uint16 LE, seconds)
//   0xFE 0x11 — timestamp (uint32 LE, seconds)
//   0xFE 0x12 — time_zone (int16 LE, hour×10 units)
//   0xFE 0x2F — led_indicator_enable
//   0xFE 0x3B — time_sync_enable
//   0xFE 0x3E — buzzer_enable
//   0xFE 0x61 — stop_buzzer_with_silent_time (uint16 LE)
//
// Downlink commands:
//   0xFF 0x10 0xFF    — reboot
//   0xFF 0x03 <u16>   — set_report_interval (seconds, range 60–64800)
//   0x07 0x00 <en> 0xFF — relay_output_status (0=off, 1=on)
//   0x06 0x00 <en> 0xFF — valve_status (0=off, 1=on)
//   0x08 0x00 0x00 0xFF — query_life_remain
//   0xFF 0x28 0xFF    — query_device_status
//   0xFF 0x11 <u32>   — set_timestamp
//   0xFF 0x17 <i16>   — set_time_zone (hour×10 units, e.g. UTC+8 = 80)
//   0xFF 0x3B <en>    — time_sync_enable
//   0xFF 0x61 <u16>   — stop_buzzer_with_silent_time
//   0xFF 0x3E <en>    — buzzer_enable
//   0xFF 0x2F <en>    — led_indicator_enable
//   0xFF 0x64 0xFF    — clear_alarm
//   0xFF 0x62 0xFF    — calibration_request
//
// Key protocol notes:
//   - Timezone: hour×10 units (same as TS101/TS301 v1), NOT minutes
//   - report_interval in SECONDS (not minutes like TS201/TS301)
//   - canDecode: 0x05 0x8E (gas_status) is GS101-exclusive
//                0x06 0x01 (valve) or 0x07 0x01 (relay) also unique to this device
//                0x08 0x90 (life_remain) very distinctive

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

// ── Timezone map (hour×10 units) ─────────────────────────────────────────────
const TZ: Record<number, string> = {
  [-120]:'UTC-12',[-110]:'UTC-11',[-100]:'UTC-10',[-95]:'UTC-9:30',
  [-90]:'UTC-9',  [-80]:'UTC-8',  [-70]:'UTC-7',  [-60]:'UTC-6',
  [-50]:'UTC-5',  [-40]:'UTC-4',  [-35]:'UTC-3:30',[-30]:'UTC-3',
  [-20]:'UTC-2',  [-10]:'UTC-1',   [0]:'UTC',       [10]:'UTC+1',
   [20]:'UTC+2',   [30]:'UTC+3',  [35]:'UTC+3:30', [40]:'UTC+4',
   [45]:'UTC+4:30',[50]:'UTC+5',  [55]:'UTC+5:30', [57]:'UTC+5:45',
   [60]:'UTC+6',   [65]:'UTC+6:30',[70]:'UTC+7',   [80]:'UTC+8',
   [90]:'UTC+9',   [95]:'UTC+9:30',[100]:'UTC+10', [105]:'UTC+10:30',
  [110]:'UTC+11', [120]:'UTC+12', [127]:'UTC+12:45',[130]:'UTC+13',
  [140]:'UTC+14',
};
function tzName(v: number): string { return TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(TZ)) if (n === name) return parseInt(k);
  return 80;
}

// ── Alarm status map ──────────────────────────────────────────────────────────
const ALARM_STATUS: Record<number, string> = {
  0:'power off', 1:'power on', 2:'device fault', 3:'device fault recovered',
  4:'device will be invalid soon', 5:'device invalid',
};

export class MilesightGS101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-gs101';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['GS101'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Gas Sensor';
  readonly modelFamily     = 'GS101';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/gs-series/gs101/gs101.png';

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

      // ── Gas status ───────────────────────────────────────────────────────────
      else if (ch === 0x05 && ty === 0x8e) {
        decoded.gas_status = bytes[i] === 1 ? 'alarm' : 'normal'; i += 1;
      }

      // ── Valve status ─────────────────────────────────────────────────────────
      else if (ch === 0x06 && ty === 0x01) {
        decoded.valve_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Relay output status ──────────────────────────────────────────────────
      else if (ch === 0x07 && ty === 0x01) {
        decoded.relay_output_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Life remain (uint32 LE, seconds) ─────────────────────────────────────
      else if (ch === 0x08 && ty === 0x90) {
        decoded.life_remain = u32(bytes, i); i += 4;
      }

      // ── Alarm ─────────────────────────────────────────────────────────────────
      else if (ch === 0xff && ty === 0x3f) {
        decoded.alarm = ALARM_STATUS[bytes[i] & 0xff] ?? 'unknown'; i += 1;
      }

      // ── Downlink responses (0xFE channel) ────────────────────────────────────
      else if (ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data); i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03: data.report_interval = u16(b, offset); offset += 2; break;
      case 0x11: data.timestamp       = u32(b, offset); offset += 4; break;
      case 0x12: data.time_zone       = tzName(i16(b, offset)); offset += 2; break;
      case 0x2f: data.led_indicator_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x3b: data.time_sync_enable     = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x3e: data.buzzer_enable        = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x61: data.stop_buzzer_with_silent_time = u16(b, offset); offset += 2; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':              bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'clear_alarm':         bytes = [0xff, 0x64, 0xff]; break;
      case 'calibration_request': bytes = [0xff, 0x62, 0xff]; break;
      case 'query_life_remain':   bytes = [0x08, 0x00, 0x00, 0xff]; break;

      case 'set_report_interval':     bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 300)]; break;
      case 'set_timestamp':           bytes = [0xff, 0x11, ...wu32(params.timestamp ?? 0)]; break;
      case 'set_time_zone':           bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_time_sync_enable':    bytes = [0xff, 0x3b, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_buzzer_enable':       bytes = [0xff, 0x3e, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_led_indicator_enable': bytes = [0xff, 0x2f, params.enable === 'enable' ? 1 : 0]; break;
      case 'stop_buzzer_with_silent_time':
        bytes = [0xff, 0x61, ...wu16(params.silent_time ?? 1)]; break;

      // Relay: 0x07 0x00 <on/off> 0xFF
      case 'set_relay_output_status':
        bytes = [0x07, 0x00, params.relay_output_status === 'on' ? 1 : 0, 0xff]; break;

      // Valve: 0x06 0x00 <on/off> 0xFF
      case 'set_valve_status':
        bytes = [0x06, 0x00, params.valve_status === 'on' ? 1 : 0, 0xff]; break;

      default:
        throw new Error(`GS101: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // GS101 is uniquely identified by:
  //   0x05 0x8E — gas_status (GS101-exclusive)
  //   0x08 0x90 — life_remain
  //   0x06 0x01 — valve_status
  //   0x07 0x01 — relay_output_status

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x05 && ty === 0x8e) return true; // gas_status — most distinctive
      if (ch === 0x08 && ty === 0x90) return true; // life_remain
      if (ch === 0x06 && ty === 0x01) return true; // valve
      if (ch === 0x07 && ty === 0x01) return true; // relay
    }
    return false;
  }
}