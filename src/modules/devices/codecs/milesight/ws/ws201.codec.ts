// src/modules/devices/codecs/milesight/ws201.codec.ts
// Milesight WS201 — LoRaWAN Smart Fill Level Monitoring Sensor (Ultrasonic)
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x82 — distance (uint16 LE, mm) — ultrasonic distance to surface
//   0x04 0xD6 — remaining (uint8, %) — fill level percentage
//
// ── Attributes (0xFF channel) ─────────────────────────────────────────────────
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (0xFF 0x16, 8B), lorawan_class, reset_event, device_status
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF                         — reboot
//   0xFF 0x28 0xFF                         — report_status
//   0xFF 0x03 <u16>                        — set_report_interval (seconds)
//   0xFF 0x02 <u16>                        — set_collection_interval (seconds)
//   0xFF 0x17 <i16>                        — set_time_zone (WS302 scale: UTC+8=80)
//   0xFF 0x76 <u16>                        — set_depth (mm, container depth)
//   0xFF 0x75 <enable> <u16_start> <u16_end> <weekdays_byte> — set_hibernate_config (6B)
//             weekdays: bit1=Mon..bit7=Sun (note: bit0 unused, bits shift by 1)
//   0xFF 0x06 <data> <u16=0> <u16_thresh> <u16=0> <u16=0> — set_remaining_alarm_config (9B)
//             data byte: bit7=alarm_release_enable, bit6=enable, bits[5:3]=index(1 or 2)
//
// ── remaining_alarm_config data byte packing ────────────────────────────────
//   bit7 = alarm_release_enable
//   bit6 = enable
//   bits[5:3] = index (1 or 2)
//   Example: index=1, enable=1, alarm_release_enable=1 → data=0xC8
//
// ── hibernate_config weekdays byte ──────────────────────────────────────────
//   bit1=Monday, bit2=Tuesday, bit3=Wednesday, bit4=Thursday,
//   bit5=Friday, bit6=Saturday, bit7=Sunday (bit0 unused)
//   All days enabled = 0xFE
//
// ── Timezone note ─────────────────────────────────────────────────────────────
//   Same WS302-style scale: UTC+8 = 80 (not 480 as in WS50x series)
//
// canDecode fingerprint: 0x03 0x82 (distance) or 0x04 0xD6 (remaining) — unique to WS201

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

const DAY_MAP: Record<string, number> = {
  monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:7
};

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

function readWeekdays(data: number): Record<string, string> {
  const days: Record<string, string> = {};
  for (const [day, bit] of Object.entries(DAY_MAP)) {
    days[day] = (data >> bit) & 1 ? 'enable' : 'disable';
  }
  return days;
}

export class MilesightWS201Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws201';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS201'];
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
      else if (ch === 0x01 && ty === 0x75) { decoded.battery   = bytes[i++] & 0xff; }
      else if (ch === 0x03 && ty === 0x82) { decoded.distance  = u16(bytes, i); i += 2; }
      else if (ch === 0x04 && ty === 0xd6) { decoded.remaining = bytes[i++] & 0xff; }

      // ── Downlink responses ─────────────────────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const r = this.handleDownlinkResponse(ty, bytes, i);
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
      case 0x03: data.report_interval     = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x17: data.time_zone = TZ_MAP[i16(b, offset)] ?? i16(b, offset); offset += 2; break;
      case 0x28: data.report_status       = 'yes'; offset += 1; break;
      case 0x76: data.depth               = u16(b, offset); offset += 2; break;

      case 0x06: {
        // data byte: bit7=alarm_release_enable, bit6=enable, bits[5:3]=index
        const d = b[offset] & 0xff;
        const cfg = {
          index:                 (d >>> 3) & 0x07,
          enable:                (d >>> 6) & 1 ? 'enable' : 'disable',
          alarm_release_enable:  (d >>> 7) & 1 ? 'enable' : 'disable',
          // skip 2 zero bytes, then threshold u16
          threshold:             u16(b, offset + 3),
          // skip 4 zero bytes
        };
        if (!data.remaining_alarm_config) data.remaining_alarm_config = [];
        data.remaining_alarm_config.push(cfg);
        offset += 9; break;
      }

      case 0x75: {
        // enable(1B) + start_time u16 + end_time u16 + weekdays(1B) = 6B
        data.hibernate_config = {
          enable:     b[offset] === 1 ? 'enable' : 'disable',
          start_time: u16(b, offset + 1),
          end_time:   u16(b, offset + 3),
          weekdays:   readWeekdays(b[offset + 5] & 0xff),
        };
        offset += 6; break;
      }

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status': bytes = [0xff, 0x28, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;

      case 'set_collection_interval':
        bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;

      case 'set_time_zone': {
        const tz = typeof params.time_zone === 'number' ? params.time_zone : (TZ_INV[params.time_zone] ?? 0);
        bytes = [0xff, 0x17, ...wi16(tz)]; break;
      }

      case 'set_depth':
        bytes = [0xff, 0x76, ...wu16(params.depth ?? 0)]; break;

      // remaining_alarm_config: FF 06 <data> 0x00 0x00 <u16_thresh> 0x00 0x00 0x00 0x00
      // data = (alarm_release_enable<<7) | (enable<<6) | (index<<3)
      case 'set_remaining_alarm_config': {
        const idx  = params.index ?? 1;
        const en   = params.enable               === 'enable' ? 1 : 0;
        const rel  = params.alarm_release_enable === 'enable' ? 1 : 0;
        const d    = ((rel & 1) << 7) | ((en & 1) << 6) | ((idx & 0x07) << 3);
        bytes = [0xff, 0x06, d, 0x00, 0x00, ...wu16(params.threshold ?? 0), 0x00, 0x00, 0x00, 0x00]; break;
      }

      // hibernate_config: FF 75 <enable> <u16_start> <u16_end> <weekdays>
      // weekdays: bit1=Mon..bit7=Sun
      case 'set_hibernate_config': {
        const en  = params.enable === 'enable' ? 1 : 0;
        const wkd = params.weekdays ?? {};
        let dayByte = 0;
        for (const [day, bit] of Object.entries(DAY_MAP)) {
          if (wkd[day] === 'enable') dayByte |= 1 << bit;
        }
        bytes = [0xff, 0x75, en, ...wu16(params.start_time ?? 0), ...wu16(params.end_time ?? 0), dayByte]; break;
      }

      default: throw new Error(`WS201: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS201 uniquely identified by 0x03 0x82 (distance) or 0x04 0xD6 (remaining).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if ((bytes[i] === 0x03 && bytes[i + 1] === 0x82) ||
          (bytes[i] === 0x04 && bytes[i + 1] === 0xd6)) return true;
    }
    return false;
  }
}