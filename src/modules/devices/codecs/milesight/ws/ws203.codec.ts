// src/modules/devices/codecs/milesight/ws203.codec.ts
// Milesight WS203 — LoRaWAN Motion & Temperature Sensor (PIR + T/H + Occupancy)
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x67 — temperature (int16 LE /10, °C)
//   0x04 0x68 — humidity (uint8 /2, %r.h.)
//   0x05 0x00 — occupancy (uint8: 0=vacant, 1=occupied)
//   0x83 0x67 — temperature with alarm (int16 + alarm_byte: 0=release, 1=alarm) — 3B
//   0x20 0xCE — history record (9B: timestamp u32 + report_type + occupancy + temp i16 + humidity)
//
// ── Attributes (0xFF channel) ─────────────────────────────────────────────────
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (0xFF 0x16, 8B), lorawan_class, reset_event, device_status
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF                        — reboot
//   0xFF 0x4A 0x00                        — sync_time
//   0xFF 0x8E 0x00 <u16>                  — set_report_interval (minutes, range [1,1440])
//   0xFF 0x02 <u16>                       — set_collection_interval (minutes)
//   0xFF 0x28 0xFF                        — query_device_status
//   0xFF 0x2F <enable>                    — set_led_indicator_enable
//   0xFF 0x95 <u16>                       — set_vacant_reporting_interval (seconds)
//   0xFF 0x06 <data> <i16_min> <i16_max> 0x00 0x00 0x00 0x00 — set_temperature_alarm_config (9B)
//              data byte: bit3=temp alarm selector, bits[2:0]=condition
//   0xFF 0x17 <i16>                       — set_time_zone (WS302 scale: UTC+8=80)
//   0xFF 0x84 <enable>                    — set_d2d_enable
//   0xFF 0x35 <8B key>                    — set_d2d_key (8 bytes = 16-char hex)
//   0xFF 0x96 <8B>                        — set_d2d_master_config
//   0xFF 0x69 <enable>                    — set_retransmit_enable
//   0xFF 0x6A 0x00 <u16>                  — set_retransmit_interval
//   0xFF 0x6A 0x01 <u16>                  — set_resend_interval
//   0xFF 0x68 <enable>                    — set_history_enable
//   0xFD 0x6B <u32>                       — fetch_history (start_time only)
//   0xFD 0x6C <u32_start> <u32_end>       — fetch_history (start + end)
//   0xFD 0x6D 0xFF                        — stop_transmit
//   0xFF 0x27 0x01                        — clear_history
//
// ── History record (0x20 0xCE) — 9 bytes ─────────────────────────────────────
//   [0:3]  timestamp (uint32 LE, UTC seconds)
//   [4]    report_type (bits[2:0]): 0=temp alarm release, 1=temp alarm,
//                                   2=pir idle, 3=pir trigger, 4=period
//   [5]    occupancy: 0=vacant, 1=occupied
//   [6:7]  temperature (int16 LE /10, °C)
//   [8]    humidity (uint8 /2, %r.h.)
//
// ── D2D master config (0xFF 0x96) — 8 data bytes ─────────────────────────────
//   [0]    mode (1-5)
//   [1]    enable
//   [2]    lora_uplink_enable
//   [3:4]  d2d_cmd (2B, byte-swapped hex string)
//   [5:6]  time (uint16 LE, minutes)
//   [7]    time_enable
//
// ── Timezone note ─────────────────────────────────────────────────────────────
//   Same WS302-style scale: UTC+8 = 80 (not 480 as in WS50x series)
//
// canDecode fingerprint: 0x05 0x00 (occupancy) — unique to WS203

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

function d2dEncode(cmd: string): number[] {
  if (!cmd || cmd.length !== 4) cmd = '0000';
  return [parseInt(cmd.slice(2, 4), 16), parseInt(cmd.slice(0, 2), 16)];
}
function d2dDecode(b: number[], i: number): string {
  return ('0' + (b[i + 1] & 0xff).toString(16)).slice(-2) + ('0' + (b[i] & 0xff).toString(16)).slice(-2);
}

const HIST_TYPE: Record<number, string> = {
  0:'temperature threshold alarm release', 1:'temperature threshold alarm',
  2:'pir idle', 3:'pir trigger', 4:'period',
};

const D2D_MODE: Record<number, string> = {
  1:'occupied and temperature threshold alarm', 2:'occupied', 3:'vacant',
  4:'temperature threshold alarm', 5:'temperature threshold alarm release',
};
const D2D_MODE_INV: Record<string, number> = Object.fromEntries(Object.entries(D2D_MODE).map(([k, v]) => [v, +k]));

const CONDITION: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_INV: Record<string, number> = Object.fromEntries(Object.entries(CONDITION).map(([k, v]) => [v, +k]));

// WS302-style timezone: UTC+8 = 80
const TZ_MAP: Record<number, string> = {
  [-120]:'UTC-12', [-110]:'UTC-11', [-100]:'UTC-10', [-95]:'UTC-9:30',
  [-90]:'UTC-9', [-80]:'UTC-8', [-70]:'UTC-7', [-60]:'UTC-6',
  [-50]:'UTC-5', [-40]:'UTC-4', [-35]:'UTC-3:30', [-30]:'UTC-3',
  [-20]:'UTC-2', [-10]:'UTC-1', [0]:'UTC', [10]:'UTC+1', [20]:'UTC+2',
  [30]:'UTC+3', [35]:'UTC+3:30', [40]:'UTC+4', [45]:'UTC+4:30',
  [50]:'UTC+5', [55]:'UTC+5:30', [57]:'UTC+5:45', [60]:'UTC+6',
  [65]:'UTC+6:30', [70]:'UTC+7', [80]:'UTC+8', [90]:'UTC+9',
  [95]:'UTC+9:30', [100]:'UTC+10', [105]:'UTC+10:30', [110]:'UTC+11',
  [120]:'UTC+12', [127]:'UTC+12:45', [130]:'UTC+13', [140]:'UTC+14',
};
const TZ_INV: Record<string, number> = Object.fromEntries(Object.entries(TZ_MAP).map(([k, v]) => [v, +k]));

export class MilesightWS203Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws203';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS203'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ────────────────────────────────────────────────────────
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
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Telemetry ─────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) { decoded.battery      = bytes[i++] & 0xff; }
      else if (ch === 0x03 && ty === 0x67) { decoded.temperature  = i16(bytes, i) / 10; i += 2; }
      else if (ch === 0x04 && ty === 0x68) { decoded.humidity     = (bytes[i++] & 0xff) / 2; }
      else if (ch === 0x05 && ty === 0x00) { decoded.occupancy    = bytes[i++] === 1 ? 'occupied' : 'vacant'; }

      // Temperature with alarm: 0x83 0x67 — int16 + alarm byte (3B total)
      else if (ch === 0x83 && ty === 0x67) {
        decoded.temperature       = i16(bytes, i) / 10;
        decoded.temperature_alarm = bytes[i + 2] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 3;
      }

      // History record: 0x20 0xCE — 9 bytes
      else if (ch === 0x20 && ty === 0xce) {
        if (!decoded.history) decoded.history = [];
        decoded.history.push({
          timestamp:   u32(bytes, i),
          report_type: HIST_TYPE[bytes[i + 4] & 0x07] ?? 'unknown',
          occupancy:   bytes[i + 5] === 1 ? 'occupied' : 'vacant',
          temperature: i16(bytes, i + 6) / 10,
          humidity:    (bytes[i + 8] & 0xff) / 2,
        });
        i += 9;
      }

      // ── Downlink responses (0xFF / 0xFE / 0xFD) ────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const r = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }
      else if (ch === 0xfd) {
        const r = this.handleFdResponse(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlinkResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x06: {
        const cond = b[offset] & 0x07;
        data.temperature_alarm_config = {
          condition:     CONDITION[cond] ?? 'unknown',
          threshold_min: i16(b, offset + 1) / 10,
          threshold_max: i16(b, offset + 3) / 10,
        };
        offset += 9; break;
      }
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x17: data.time_zone = TZ_MAP[i16(b, offset)] ?? i16(b, offset); offset += 2; break;
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      case 0x2f: data.led_indicator_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x35: data.d2d_key = b.slice(offset, offset + 8).map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join(''); offset += 8; break;
      case 0x4a: data.sync_time = 'yes'; offset += 1; break;
      case 0x68: data.history_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: data.retransmit_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x6a: {
        const itype = b[offset];
        const val   = u16(b, offset + 1);
        if (itype === 0) data.retransmit_interval = val;
        else if (itype === 1) data.resend_interval = val;
        offset += 3; break;
      }
      case 0x84: data.d2d_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break;
      case 0x95: data.vacant_reporting_interval = u16(b, offset); offset += 2; break;
      case 0x96: {
        const cfg = {
          mode:               D2D_MODE[b[offset]] ?? 'unknown',
          enable:             b[offset + 1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: b[offset + 2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            d2dDecode(b, offset + 3),
          time:               u16(b, offset + 5),
          time_enable:        b[offset + 7] === 1 ? 'enable' : 'disable',
        };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(cfg);
        offset += 8; break;
      }
      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleFdResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x6b: data.fetch_history = { start_time: u32(b, offset) }; offset += 4; break;
      case 0x6c: data.fetch_history = { start_time: u32(b, offset), end_time: u32(b, offset + 4) }; offset += 8; break;
      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;
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
      case 'sync_time':           bytes = [0xff, 0x4a, 0x00]; break;
      case 'query_device_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'stop_transmit':       bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history':       bytes = [0xff, 0x27, 0x01]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 20)]; break;

      case 'set_collection_interval':
        bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 1)]; break;

      case 'set_led_indicator_enable':
        bytes = [0xff, 0x2f, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_vacant_reporting_interval':
        bytes = [0xff, 0x95, ...wu16(params.vacant_reporting_interval ?? 300)]; break;

      case 'set_temperature_alarm_config': {
        const cond = CONDITION_INV[params.condition ?? 'disable'] ?? 0;
        const data = (1 << 3) | cond; // bit3 = temperature alarm selector
        const min  = Math.round((params.threshold_min ?? 0) * 10);
        const max  = Math.round((params.threshold_max ?? 0) * 10);
        bytes = [0xff, 0x06, data, ...wi16(min), ...wi16(max), 0x00, 0x00, 0x00, 0x00]; break;
      }

      case 'set_time_zone': {
        const tz = typeof params.time_zone === 'number' ? params.time_zone : (TZ_INV[params.time_zone] ?? 0);
        bytes = [0xff, 0x17, ...wi16(tz)]; break;
      }

      case 'set_d2d_enable': bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_key': {
        const hex = (params.d2d_key ?? '0000000000000000').slice(0, 16).padEnd(16, '0');
        const keyBytes: number[] = [];
        for (let i = 0; i < 16; i += 2) keyBytes.push(parseInt(hex.slice(i, i + 2), 16));
        bytes = [0xff, 0x35, ...keyBytes]; break;
      }

      case 'set_d2d_master_config': {
        const p    = params;
        const mode = D2D_MODE_INV[p.mode ?? 'occupied'] ?? 2;
        const en   = p.enable             === 'enable' ? 1 : 0;
        const lu   = p.lora_uplink_enable === 'enable' ? 1 : 0;
        const te   = p.time_enable        === 'enable' ? 1 : 0;
        bytes = [0xff, 0x96, mode, en, lu, ...d2dEncode(p.d2d_cmd ?? '0000'), ...wu16(p.time ?? 0), te]; break;
      }

      case 'set_retransmit_enable': bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_interval': bytes = [0xff, 0x6a, 0x00, ...wu16(params.retransmit_interval ?? 600)]; break;
      case 'set_resend_interval':     bytes = [0xff, 0x6a, 0x01, ...wu16(params.resend_interval ?? 600)]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time;
        if (end) bytes = [0xfd, 0x6c, ...wu32(start), ...wu32(end)];
        else     bytes = [0xfd, 0x6b, ...wu32(start)];
        break;
      }

      default: throw new Error(`WS203: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS203 is uniquely identified by 0x05 0x00 (occupancy) or 0x20 0xCE (history).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if ((bytes[i] === 0x05 && bytes[i + 1] === 0x00) ||
          (bytes[i] === 0x20 && bytes[i + 1] === 0xce)) return true;
    }
    return false;
  }
}