// src/modules/devices/codecs/milesight/ct303.codec.ts
// Milesight CT303 / CT305 / CT310 — LoRaWAN 3-Channel Smart Current Transformer
//
// Protocol: IPSO channel_id + channel_type
//
// ── CRITICAL DIFFERENCES FROM CT101 FAMILY ───────────────────────────────────
//   - 3 current channels (CHN1/CHN2/CHN3)
//   - Current type byte: 0x99 (CT101 used 0x98)
//   - Current scale: uint16 /10 A (CT101 used /100)
//   - Total current channels: 0x03/0x05/0x07 with type 0x97 (/100 Ah, same)
//   - Alarm channels: 0x84/0x86/0x88 with type 0x99, named current_chnN_*
//   - clear_current_chnN_cumulative carries channel index byte (1/2/3)
//   - Alarm config data byte: (channelIndex << 3) | condition (index 1-3)
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B hex)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x03 0x97 — current_chn1_total (uint32 LE /100, Ah)
//   0x04 0x99 — current_chn1 (uint16 LE /10, A); 0xFFFF = read failed
//   0x05 0x97 — current_chn2_total (uint32 LE /100, Ah)
//   0x06 0x99 — current_chn2 (uint16 LE /10, A); 0xFFFF = read failed
//   0x07 0x97 — current_chn3_total (uint32 LE /100, Ah)
//   0x08 0x99 — current_chn3 (uint16 LE /10, A); 0xFFFF = read failed
//   0x09 0x67 — temperature (int16 LE /10, °C)
//              sentinel 0xFFFD = over range, 0xFFFF = read failed
//   0x84 0x99 — current_chn1_alarm: max+min+cur (u16/10) + alarm_bits(1B)
//   0x86 0x99 — current_chn2_alarm
//   0x88 0x99 — current_chn3_alarm
//   0x89 0x67 — temperature_alarm: int16/10 + alarm_byte
//
// ── Downlink responses ────────────────────────────────────────────────────────
//   0xFF 0x02 — alarm_report_interval (uint16 LE, minutes)
//   0xFF 0x06 — alarm config: data_byte bits[5:3]=channel(1-3 or 4=temp), bits[2:0]=condition
//   0xFF 0x10 — reboot echo
//   0xFF 0x27 — clear_current_chnN_cumulative: index byte (1/2/3)
//   0xFF 0x28 — report_status echo
//   0xFF 0x8E — report_interval: sub(0x00) + uint16 (minutes)
//   0xFF 0xF2 — alarm_report_counts (uint16 LE)
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF          — reboot
//   0xFF 0x28 0xFF          — report_status
//   0xFF 0x27 <N>           — clear_current_chnN_cumulative (N=1/2/3)
//   0xFF 0x8E 0x00 <u16>    — set_report_interval (minutes)
//   0xFF 0x02 <u16>         — set_alarm_report_interval (minutes)
//   0xFF 0xF2 <u16>         — set_alarm_report_counts
//   0xFF 0x06 <data> <min_u16> <max_u16> <interval_u16> <counts_u16> — set_current_chnN_alarm_config
//   0xFF 0x06 <data> <min_i16×10> <max_i16×10> 0x00×4              — set_temperature_alarm_config

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
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

const CONDITION_MAP: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_INV: Record<string, number> = Object.fromEntries(Object.entries(CONDITION_MAP).map(([k, v]) => [v, +k]));
const SENSOR_STATUS: Record<number, string> = { 0:'normal', 1:'over range alarm', 2:'read failed' };

// Channel mappings
const TOTAL_CHNS  = [0x03, 0x05, 0x07]; // current_chnN_total
const CURRENT_CHNS = [0x04, 0x06, 0x08]; // current_chnN
const ALARM_CHNS   = [0x84, 0x86, 0x88]; // current_chnN_alarm

export class MilesightCT303Codec extends BaseDeviceCodec {
  readonly codecId: string        = 'milesight-ct303';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['CT303', 'CT305', 'CT310'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Current Monitoring';
  readonly modelFamily     = 'CT303';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ct-series/ct303/ct303.png';

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ───────────────────────────────────────────────────────────
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

      // ── Total current (uint32 LE /100, Ah) — channels 1/2/3 ─────────────────
      else if (TOTAL_CHNS.includes(ch) && ty === 0x97) {
        const n = TOTAL_CHNS.indexOf(ch) + 1;
        decoded[`current_chn${n}_total`] = u32(bytes, i) / 100;
        i += 4;
      }

      // ── Instantaneous current (uint16 LE /10, A) — channels 1/2/3 ───────────
      else if (CURRENT_CHNS.includes(ch) && ty === 0x99) {
        const n = CURRENT_CHNS.indexOf(ch) + 1;
        const raw = u16(bytes, i); i += 2;
        if (raw === 0xffff) {
          decoded[`current_chn${n}_sensor_status`] = SENSOR_STATUS[2]; // read failed
        } else {
          decoded[`current_chn${n}`] = raw / 10;
        }
      }

      // ── Temperature (int16 LE /10, °C) ────────────────────────────────────────
      else if (ch === 0x09 && ty === 0x67) {
        const raw = u16(bytes, i); i += 2;
        if (raw === 0xfffd) {
          decoded.temperature_sensor_status = SENSOR_STATUS[1];
        } else if (raw === 0xffff) {
          decoded.temperature_sensor_status = SENSOR_STATUS[2];
        } else {
          decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        }
      }

      // ── Current alarm (0x84/0x86/0x88 0x99) ──────────────────────────────────
      // max(u16/10) + min(u16/10) + current(u16/10) + alarm_bits(1B)
      else if (ALARM_CHNS.includes(ch) && ty === 0x99) {
        const n = ALARM_CHNS.indexOf(ch) + 1;
        decoded[`current_chn${n}_max`] = u16(bytes, i) / 10;
        decoded[`current_chn${n}_min`] = u16(bytes, i + 2) / 10;
        decoded[`current_chn${n}`]     = u16(bytes, i + 4) / 10;
        const alm = bytes[i + 6];
        decoded[`current_chn${n}_alarm`] = {
          current_threshold_alarm:         (alm >> 0) & 1 ? 'yes' : 'no',
          current_threshold_alarm_release:  (alm >> 1) & 1 ? 'yes' : 'no',
          current_over_range_alarm:         (alm >> 2) & 1 ? 'yes' : 'no',
          current_over_range_alarm_release: (alm >> 3) & 1 ? 'yes' : 'no',
        };
        i += 7;
      }

      // ── Temperature alarm (0x89 0x67) ────────────────────────────────────────
      else if (ch === 0x89 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10;
        decoded.temperature_alarm = bytes[i + 2] === 0
          ? 'temperature threshold alarm release'
          : 'temperature threshold alarm';
        i += 3;
      }

      // ── Downlink responses (0xFF / 0xFE channel) ──────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlinkResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x02:
        data.alarm_report_interval = u16(b, offset); offset += 2; break;

      case 0x06: {
        const dataByte    = b[offset];
        const channelIdx  = (dataByte >>> 3) & 0x07;
        const condition   = CONDITION_MAP[dataByte & 0x07] ?? 'unknown';
        if (channelIdx >= 1 && channelIdx <= 3) {
          data[`current_chn${channelIdx}_alarm_config`] = {
            condition,
            threshold_min:  u16(b, offset + 1),
            threshold_max:  u16(b, offset + 3),
            alarm_interval: u16(b, offset + 5),
            alarm_counts:   u16(b, offset + 7),
          };
        } else if (channelIdx === 0x04) {
          data.temperature_alarm_config = {
            condition,
            threshold_min: i16(b, offset + 1) / 10,
            threshold_max: i16(b, offset + 3) / 10,
          };
        }
        offset += 9; break;
      }

      case 0x10: data.reboot = 'yes'; offset += 1; break;

      case 0x27: {
        const idx = b[offset++] & 0xff;
        data[`clear_current_chn${idx}_cumulative`] = 'yes'; break;
      }

      case 0x28: data.report_status = 'yes'; offset += 1; break;

      case 0x8e:
        data.report_interval = u16(b, offset + 1); offset += 3; break;

      case 0xf2:
        data.alarm_report_counts = u16(b, offset); offset += 2; break;

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
        bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 20)]; break;

      case 'set_alarm_report_interval':
        bytes = [0xff, 0x02, ...wu16(params.alarm_report_interval ?? 1)]; break;

      case 'set_alarm_report_counts':
        bytes = [0xff, 0xf2, ...wu16(params.alarm_report_counts ?? 1)]; break;

      // params: { channel: 1|2|3 }
      case 'clear_current_cumulative': {
        const n = params.channel ?? 1;
        bytes = [0xff, 0x27, n]; break;
      }

      // params: { channel: 1|2|3, condition, threshold_min, threshold_max, alarm_interval, alarm_counts }
      case 'set_current_alarm_config': {
        const p = params;
        const n = p.channel ?? 1;
        const condVal = CONDITION_INV[p.condition ?? 'disable'] ?? 0;
        const dataByte = (n << 3) | condVal;
        bytes = [
          0xff, 0x06, dataByte,
          ...wu16(p.threshold_min ?? 0),
          ...wu16(p.threshold_max ?? 0),
          ...wu16(p.alarm_interval ?? 0),
          ...wu16(p.alarm_counts ?? 0),
        ]; break;
      }

      // params: { condition, threshold_min, threshold_max }
      case 'set_temperature_alarm_config': {
        const p = params;
        const condVal = CONDITION_INV[p.condition ?? 'disable'] ?? 0;
        const dataByte = (0x04 << 3) | condVal;
        bytes = [
          0xff, 0x06, dataByte,
          ...wi16(Math.round((p.threshold_min ?? 0) * 10)),
          ...wi16(Math.round((p.threshold_max ?? 0) * 10)),
          0x00, 0x00, 0x00, 0x00, // reserved
        ]; break;
      }

      default:
        throw new Error(`CT303: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // CT303 uniquely identified by type byte 0x99 (CT101 uses 0x98) combined
  // with channel IDs 0x04/0x06/0x08/0x84/0x86/0x88.
  // Also: multi-channel total current channels 0x05/0x07 with type 0x97.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      // Any current channel with type 0x99 — unambiguous CT303 fingerprint
      if (ty === 0x99) return true;
      // CHN2/CHN3 total current — only CT303 has these
      if ((ch === 0x05 || ch === 0x07) && ty === 0x97) return true;
    }
    return false;
  }
}

// CT305 and CT310 share identical wire protocol with CT303.
// Subclasses for distinct module registration and user visibility.

export class MilesightCT305Codec extends MilesightCT303Codec {
  override readonly codecId         = 'milesight-ct305';
  override readonly supportedModels = ['CT305'];
}

export class MilesightCT310Codec extends MilesightCT303Codec {
  override readonly codecId         = 'milesight-ct310';
  override readonly supportedModels = ['CT310'];
}