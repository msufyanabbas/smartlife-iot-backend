// src/modules/devices/codecs/milesight/ws302.codec.ts
// Milesight WS302 — LoRaWAN Sound Level Sensor
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x05 0x5B — sound level (7B: weight + L + Leq + Lmax)
//
// Sound channel (0x05 0x5B) — 7 bytes:
//   [0] weight byte: bits[1:0]=freq_weight, bits[3:2]=time_weight
//       freq_weight: 0=Z, 1=A, 2=C
//       time_weight: 0=I, 1=F, 2=S
//   [1:2] L<freq><time>  = uint16LE / 10, dB  (e.g. LAF)
//   [3:4] L<freq>eq      = uint16LE / 10, dB  (e.g. LAeq)
//   [5:6] L<freq><time>max = uint16LE / 10, dB (e.g. LAFmax)
//   Field names are dynamically constructed from the weight byte.
//   Example: weight=0x05 (freq=A,time=F) → LAF, LAeq, LAFmax
//
// Attributes (0xFF channel):
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (0xFF 0x16, 8B), lorawan_class, reset_event, device_status
//
// Downlink commands & responses:
//   0xFF 0x10 0xFF           — reboot
//   0xFF 0x11 <u32>          — set_timestamp (UTC seconds, uint32 LE)
//   0xFF 0x17 <i16>          — set_time_zone (NOTE: scaled differently from WS series!)
//                               UTC+8 = 80 (not 480); unit is "hour * 10"
//   0xFF 0x1D <freq> <time>  — set_weighting_type (freq: 0=Z,1=A,2=C; time: 0=I,1=F,2=S)
//   0xFF 0x2D <enable>       — set_led_indicator_enable
//   0xFF 0x3B <enable>       — set_time_sync_enable
//
// ── IMPORTANT: WS302 timezone scale differs from WS50x series ────────────────
//   WS50x: UTC+8 = 480 (minutes)
//   WS302: UTC+8 = 80  (hours * 10, i.e. "hh:mm" with decimal encoding)
//   The timezone_map keys here match the WS302 encoder/decoder directly.
//
// canDecode fingerprint: 0x05 0x5B (sound channel) — unique to WS302

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

const FREQ_WEIGHT: Record<number, string> = { 0:'Z', 1:'A', 2:'C' };
const TIME_WEIGHT: Record<number, string> = { 0:'I', 1:'F', 2:'S' };
const FREQ_INV: Record<string, number>    = { Z:0, A:1, C:2 };
const TIME_INV: Record<string, number>    = { I:0, F:1, S:2 };

// WS302-specific timezone scale: UTC+8 = 80 (not 480 like WS50x)
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

export class MilesightWS302Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws302';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS302'];
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

      // ── Battery ───────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) { decoded.battery = bytes[i++] & 0xff; }

      // ── Sound Level (0x05 0x5B) ───────────────────────────────────────────
      // weight byte: bits[1:0]=freq (0=Z,1=A,2=C), bits[3:2]=time (0=I,1=F,2=S)
      // 7 bytes total: weight(1B) + L(2B) + Leq(2B) + Lmax(2B)
      // Field names constructed dynamically: L<freq><time>, L<freq>eq, L<freq><time>max
      else if (ch === 0x05 && ty === 0x5b) {
        const weight = bytes[i] & 0xff;
        const fw = FREQ_WEIGHT[weight & 0x03]       ?? 'Z';
        const tw = TIME_WEIGHT[(weight >> 2) & 0x03] ?? 'I';
        decoded[`L${fw}${tw}`]       = u16(bytes, i + 1) / 10;
        decoded[`L${fw}eq`]          = u16(bytes, i + 3) / 10;
        decoded[`L${fw}${tw}max`]    = u16(bytes, i + 5) / 10;
        i += 7;
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────
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
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x11: data.timestamp = u32(b, offset); offset += 4; break;
      case 0x17: data.time_zone = TZ_MAP[i16(b, offset)] ?? i16(b, offset); offset += 2; break;
      case 0x1d:
        data.frequency_weighting_type = FREQ_WEIGHT[b[offset]] ?? 'unknown';
        data.time_weighting_type      = TIME_WEIGHT[b[offset + 1]] ?? 'unknown';
        offset += 2; break;
      case 0x2d: data.led_indicator_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x3b: data.time_sync_enable = 'yes'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot': bytes = [0xff, 0x10, 0xff]; break;

      // timestamp: 0xFF 0x11 <uint32 LE, UTC seconds>
      case 'set_timestamp':
        bytes = [0xff, 0x11, ...wu32(params.timestamp ?? 0)]; break;

      // time_zone: 0xFF 0x17 <int16 LE>
      // NOTE: scale is "hours * 10" — UTC+8 = 80 (not 480 like WS50x!)
      case 'set_time_zone': {
        const tz = typeof params.time_zone === 'number'
          ? params.time_zone
          : (TZ_INV[params.time_zone] ?? 0);
        bytes = [0xff, 0x17, ...wi16(tz)]; break;
      }

      case 'set_time_sync_enable':
        bytes = [0xff, 0x3b, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_led_indicator_enable':
        bytes = [0xff, 0x2d, params.enable === 'enable' ? 1 : 0]; break;

      // set_weighting_type: 0xFF 0x1D <freq_byte> <time_byte>
      case 'set_weighting_type': {
        const freq = FREQ_INV[params.frequency_weighting_type ?? 'A'] ?? 1;
        const time = TIME_INV[params.time_weighting_type ?? 'F']      ?? 1;
        bytes = [0xff, 0x1d, freq, time]; break;
      }

      default:
        throw new Error(`WS302: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS302 is uniquely identified by the sound channel 0x05 0x5B.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x05 && bytes[i + 1] === 0x5b) return true;
    }
    return false;
  }
}