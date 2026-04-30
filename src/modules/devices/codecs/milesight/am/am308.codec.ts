// src/modules/devices/codecs/milesight/am308.codec.ts
/**
 * Milesight AM308 — LoRaWAN Ambience Monitoring Sensor with PM2.5/PM10
 *
 * ── Relation to AM307 ─────────────────────────────────────────────────────────
 * AM308 = AM307 + PM2.5 + PM10 + pm2_5_collection_interval
 *
 * Added vs AM307:
 *   Telemetry: 0x0B 0x7D — pm2_5 (uint16 LE, µg/m³)
 *              0x0C 0x7D — pm10  (uint16 LE, µg/m³)
 *   Downlink:  0xFF 0x65 — pm2_5_collection_interval (u16 LE, s)
 *   History:   20B records (AM307 = 16B) — appends pm2_5(2B) + pm10(2B)
 *   Screen elements: adds pm2_5 (bit7) and pm10 (bit8) to 0xF0 mask
 *
 * Everything else is identical: same screen commands (0x2D, 0x3C, 0x66, 0xF0),
 * same TVOC dual-unit scheme, same CO₂ calibration, same history channel IDs.
 *
 * ── Telemetry channels ────────────────────────────────────────────────────────
 *   0xFF 0x01 — ipso_version (1B)
 *   0xFF 0x09 — hardware_version (2B)
 *   0xFF 0x0A — firmware_version (2B)
 *   0xFF 0xFF — tsl_version (2B)
 *   0xFF 0x16 — sn (8B hex)
 *   0xFF 0x0F — lorawan_class (1B)
 *   0xFF 0xFE — reset_event (1B)
 *   0xFF 0x0B — device_status (1B)
 *   0x01 0x75 — battery (uint8, %)
 *   0x03 0x67 — temperature (int16 LE /10, °C)
 *   0x04 0x68 — humidity (uint8 /2, %r.h.)
 *   0x05 0x00 — pir (uint8: 0=idle, 1=trigger)
 *   0x06 0xCB — light_level (uint8, 0–5 scale)
 *   0x07 0x7D — co2 (uint16 LE, ppm)
 *   0x08 0x7D — tvoc (uint16 LE /100, iaq)
 *   0x08 0xE6 — tvoc (uint16 LE, µg/m³)
 *   0x09 0x73 — pressure (uint16 LE /10, hPa)
 *   0x0B 0x7D — pm2_5 (uint16 LE, µg/m³)   ← AM308-exclusive
 *   0x0C 0x7D — pm10  (uint16 LE, µg/m³)   ← AM308-exclusive
 *   0x0E 0x01 — buzzer_status (uint8: 0=off, 1=on)
 *
 * ── History record layout (20B) ──────────────────────────────────────────────
 *   timestamp(4B u32) + temperature(2B i16/10) + humidity(2B u16/2)
 *   + pir(1B) + light_level(1B) + co2(2B u16) + tvoc(2B) + pressure(2B u16/10)
 *   + pm2_5(2B u16) + pm10(2B u16)
 *
 * ── Downlink channels ────────────────────────────────────────────────────────
 *   (all AM307 channels, plus:)
 *   0xFF 0x65 — pm2_5_collection_interval (u16 LE, s)
 *   0xFF 0xF0 — screen_display_element_settings (mask u16 + data u16)
 *               bits: temp=0, hum=1, co2=2, light=3, tvoc=4, smile=5,
 *                     letter=6, pm2_5=7, pm10=8
 *
 * ── Timezone scale ────────────────────────────────────────────────────────────
 *   hours×10: UTC+8 = 80
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   0x0B 0x7D (PM2.5) or 0x0C 0x7D (PM10) — exclusive to AM308.
 *   In ALL_CODECS: place AM308 before AM307/AM307L since AM308 payloads also
 *   contain 0x08 0x7D (TVOC) which AM307/AM307L match.
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const TIMEZONE_MAP: Record<string, string> = {
  '-120':'UTC-12', '-110':'UTC-11', '-100':'UTC-10', '-95':'UTC-9:30',
  '-90':'UTC-9',   '-80':'UTC-8',   '-70':'UTC-7',   '-60':'UTC-6',
  '-50':'UTC-5',   '-40':'UTC-4',   '-35':'UTC-3:30','-30':'UTC-3',
  '-20':'UTC-2',   '-10':'UTC-1',   '0':'UTC',        '10':'UTC+1',
  '20':'UTC+2',    '30':'UTC+3',    '35':'UTC+3:30',  '40':'UTC+4',
  '45':'UTC+4:30', '50':'UTC+5',    '55':'UTC+5:30',  '57':'UTC+5:45',
  '60':'UTC+6',    '65':'UTC+6:30', '70':'UTC+7',     '80':'UTC+8',
  '90':'UTC+9',    '95':'UTC+9:30', '100':'UTC+10',   '105':'UTC+10:30',
  '110':'UTC+11',  '120':'UTC+12',  '127':'UTC+12:45','130':'UTC+13',
  '140':'UTC+14',
};
const TIMEZONE_REVERSE: Record<string, number> = {};
for (const k in TIMEZONE_MAP) TIMEZONE_REVERSE[TIMEZONE_MAP[k]] = Number(k);

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
const CALIB_MODE:   Record<number, string>  = { 0:'factory', 1:'abc', 2:'manual', 3:'background', 4:'zero' };
const CALIB_MODE_R: Record<string, number>  = { factory:0, abc:1, manual:2, background:3, zero:4 };

// Screen display element bit positions (AM308 extends AM307 with pm2_5/pm10)
const SCREEN_BITS: Record<string, number> = {
  temperature:0, humidity:1, co2:2, light:3, tvoc:4, smile:5, letter:6, pm2_5:7, pm10:8
};

export class MilesightAM308Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-am308';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['AM308'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Ambience Monitoring';
  readonly modelFamily     = 'AM308';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/am-series/am308/am308.png';

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: Record<string, any> = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ─────────────────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] >> 4) & 0x0f}.${bytes[i] & 0x0f}`; i++;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i+1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }
      else if (ch === 0xff && ty === 0x0f) {
        decoded.lorawan_class = LORAWAN_CLASS[bytes[i++]] ?? 'unknown';
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => (b & 0xff).toString(16).padStart(2, '0')).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }

      // ── Telemetry channels ─────────────────────────────────────────────────

      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i++] & 0xff;
      }
      else if (ch === 0x03 && ty === 0x67) {
        const raw = (bytes[i+1] << 8) | bytes[i];
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10; i += 2;
      }
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i++] & 0xff) / 2;
      }
      else if (ch === 0x05 && ty === 0x00) {
        decoded.pir = bytes[i++] === 1 ? 'trigger' : 'idle';
      }
      else if (ch === 0x06 && ty === 0xcb) {
        decoded.light_level = bytes[i++] & 0xff;
      }
      else if (ch === 0x07 && ty === 0x7d) {
        decoded.co2 = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      else if (ch === 0x08 && ty === 0x7d) {
        decoded.tvoc      = (((bytes[i+1] << 8) | bytes[i]) & 0xffff) / 100;
        decoded.tvoc_unit = 'iaq'; i += 2;
      }
      else if (ch === 0x08 && ty === 0xe6) {
        decoded.tvoc      = ((bytes[i+1] << 8) | bytes[i]) & 0xffff;
        decoded.tvoc_unit = 'µg/m³'; i += 2;
      }
      else if (ch === 0x09 && ty === 0x73) {
        decoded.pressure = (((bytes[i+1] << 8) | bytes[i]) & 0xffff) / 10; i += 2;
      }
      // AM308-exclusive PM channels
      else if (ch === 0x0b && ty === 0x7d) {
        decoded.pm2_5 = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      else if (ch === 0x0c && ty === 0x7d) {
        decoded.pm10 = ((bytes[i+1] << 8) | bytes[i]) & 0xffff; i += 2;
      }
      else if (ch === 0x0e && ty === 0x01) {
        decoded.buzzer_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── History records (20B — AM307 16B + pm2_5 2B + pm10 2B) ───────────

      else if ((ch === 0x20 || ch === 0x21) && ty === 0xce) {
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(this.decodeHistoryRecord(bytes, i, ch === 0x21));
        i += 20;
      }

      // ── Downlink response channels ─────────────────────────────────────────

      else if (ch === 0xfe || ch === 0xff) {
        const r = this.decodeDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, r.data);
        i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private decodeHistoryRecord(bytes: number[], i: number, luxMode: boolean): Record<string, any> {
    const ts    = (((bytes[i+3] << 24) | (bytes[i+2] << 16) | (bytes[i+1] << 8) | bytes[i]) >>> 0);
    const rawT  = (bytes[i+5] << 8) | bytes[i+4];
    const tvocRaw = ((bytes[i+13] << 8) | bytes[i+12]) & 0xffff;
    return {
      timestamp:   ts,
      temperature: (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10,
      humidity:    (((bytes[i+7] << 8) | bytes[i+6]) & 0xffff) / 2,
      pir:         bytes[i+8] === 1 ? 'trigger' : 'idle',
      light_level: bytes[i+9] & 0xff,
      co2:         ((bytes[i+11] << 8) | bytes[i+10]) & 0xffff,
      tvoc:        luxMode ? tvocRaw : tvocRaw / 100,
      tvoc_unit:   luxMode ? 'µg/m³' : 'iaq',
      pressure:    (((bytes[i+15] << 8) | bytes[i+14]) & 0xffff) / 10,
      pm2_5:       ((bytes[i+17] << 8) | bytes[i+16]) & 0xffff,
      pm10:        ((bytes[i+19] << 8) | bytes[i+18]) & 0xffff,
    };
  }

  private decodeDownlinkResponse(
    ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x03:
        data.report_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x10:
        data.reboot = 'yes'; offset += 1; break;

      case 0x17: {
        const raw = (bytes[offset+1] << 8) | bytes[offset];
        const tz  = raw > 0x7fff ? raw - 0x10000 : raw;
        data.time_zone = TIMEZONE_MAP[String(tz)] ?? `UTC offset ${tz}`; offset += 2; break;
      }

      case 0x1a: {
        const mode = bytes[offset] & 0xff;
        data.co2_calibration_settings = { mode: CALIB_MODE[mode] ?? 'unknown' };
        if (mode === 2) { data.co2_calibration_settings.calibration_value = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff; offset += 3; }
        else { offset += 1; }
        break;
      }

      case 0x25: {
        const bits = bytes[offset++];
        data.child_lock_settings = {
          off_button:        bits & 0x01 ? 'enable' : 'disable',
          on_button:         (bits >> 1) & 0x01 ? 'enable' : 'disable',
          collection_button: (bits >> 2) & 0x01 ? 'enable' : 'disable',
        };
        break;
      }

      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x2c: data.query_status  = 'yes'; offset += 1; break;
      case 0x2d: data.screen_display_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x2e: {
        const modeMap: Record<number, string> = { 0:'off', 1:'on', 2:'blink' };
        data.led_indicator_mode = modeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }

      case 0x39:
        data.co2_abc_calibration_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 5; break;

      case 0x3b: data.time_sync_enable = bytes[offset] === 2 ? 'enable' : 'disable'; offset += 1; break;
      case 0x3c: data.screen_display_pattern = bytes[offset++] & 0xff; break;
      case 0x3d: data.stop_buzzer            = 'yes'; offset += 1; break;
      case 0x3e: data.buzzer_enable          = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      // AM308-exclusive
      case 0x65:
        data.pm2_5_collection_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x66: data.screen_display_alarm_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x68: data.history_enable              = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: data.retransmit_enable           = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x6a: {
        const sub = bytes[offset] & 0xff;
        const val = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        if (sub === 0) data.retransmit_interval = val;
        else           data.resend_interval     = val;
        offset += 3; break;
      }

      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;

      case 0xeb: {
        const unitMap: Record<number, string> = { 0:'iaq', 1:'µg/m³' };
        data.tvoc_unit = unitMap[bytes[offset++]] ?? 'unknown'; break;
      }

      case 0xf0: {
        // AM308 extends screen elements with pm2_5 (bit7) and pm10 (bit8)
        const mask = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff;
        const dval = ((bytes[offset+3] << 8) | bytes[offset+2]) & 0xffff;
        const elem: Record<string, string> = {};
        for (const [k, b] of Object.entries(SCREEN_BITS)) {
          if ((mask >> b) & 1) elem[k] = (dval >> b) & 1 ? 'enable' : 'disable';
        }
        data.screen_display_element_settings = elem;
        offset += 4; break;
      }

      case 0xf4: data.co2_calibration_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      default: offset += 1; break;
    }

    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params: p = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'stop_buzzer':   bytes = [0xff, 0x3d, 0x00]; break;
      case 'query_status':  bytes = [0xff, 0x2c, 0x00]; break;
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history': bytes = [0xff, 0x27, 0x01]; break;

      case 'set_report_interval': {
        const v = p.report_interval ?? 300;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_time_sync':
        bytes = [0xff, 0x3b, p.enable ? 2 : 0]; break;

      case 'set_time_zone': {
        const tz = typeof p.time_zone === 'string'
          ? (TIMEZONE_REVERSE[p.time_zone] ?? 0)
          : (p.time_zone ?? 0);
        const v = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0x17, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_tvoc_unit':
        bytes = [0xff, 0xeb, p.unit === 'µg/m³' || p.unit === 1 ? 1 : 0]; break;

      // AM308-exclusive
      case 'set_pm2_5_collection_interval': {
        const v = p.pm2_5_collection_interval ?? p.interval ?? 300;
        bytes = [0xff, 0x65, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_co2_abc_calibration':
        bytes = [0xff, 0x39, p.enable ? 1 : 0, 0, 0, 0, 0]; break;

      case 'set_co2_calibration_enable':
        bytes = [0xff, 0xf4, p.enable ? 1 : 0]; break;

      case 'set_co2_calibration': {
        const mode = typeof p.mode === 'string' ? (CALIB_MODE_R[p.mode] ?? 0) : (p.mode ?? 0);
        if (mode === 2) {
          const val = p.calibration_value ?? 400;
          bytes = [0xff, 0x1a, mode, val & 0xff, (val >> 8) & 0xff];
        } else {
          bytes = [0xff, 0x1a, mode];
        }
        break;
      }

      case 'set_buzzer':
        bytes = [0xff, 0x3e, p.enable ? 1 : 0]; break;

      case 'set_led_indicator': {
        const modeMap: Record<string, number> = { off:0, on:1, blink:2 };
        const val = typeof p.mode === 'string' ? (modeMap[p.mode] ?? 0) : (p.mode ?? 0);
        bytes = [0xff, 0x2e, val]; break;
      }

      case 'set_screen_display_enable':
        bytes = [0xff, 0x2d, p.enable ? 1 : 0]; break;

      case 'set_screen_display_alarm_enable':
        bytes = [0xff, 0x66, p.enable ? 1 : 0]; break;

      case 'set_screen_display_pattern': {
        const pat = p.pattern ?? 1;
        if (![1,2,3].includes(pat)) throw new Error('screen_display_pattern: 1, 2, or 3');
        bytes = [0xff, 0x3c, pat]; break;
      }

      case 'set_screen_display_elements': {
        // AM308 supports 9 elements including pm2_5 and pm10
        let mask = 0, dval = 0;
        const elems = p.screen_display_element_settings ?? p.elements ?? p;
        for (const [k, b] of Object.entries(SCREEN_BITS)) {
          if (k in elems) {
            mask |= 1 << b;
            if (elems[k] === 'enable' || elems[k] === 1) dval |= 1 << b;
          }
        }
        bytes = [0xff, 0xf0, mask & 0xff, (mask >> 8) & 0xff, dval & 0xff, (dval >> 8) & 0xff]; break;
      }

      case 'set_child_lock': {
        const e = p.child_lock_settings ?? p;
        const bits = (e.off_button        === 'enable' || e.off_button        === 1 ? 1 : 0)
                   | (e.on_button         === 'enable' || e.on_button         === 1 ? 2 : 0)
                   | (e.collection_button === 'enable' || e.collection_button === 1 ? 4 : 0);
        bytes = [0xff, 0x25, bits]; break;
      }

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, p.enable ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = p.retransmit_interval ?? p.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('retransmit_interval: 1–64800 s');
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_resend_interval': {
        const v = p.resend_interval ?? p.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('resend_interval: 1–64800 s');
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, p.enable ? 1 : 0]; break;

      case 'fetch_history': {
        const start = p.start_time ?? 0;
        const end   = p.end_time;
        if (end !== undefined && end !== 0) {
          bytes = [0xfd, 0x6c,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
            end   & 0xff, (end   >> 8) & 0xff, (end   >> 16) & 0xff, (end   >> 24) & 0xff];
        } else {
          bytes = [0xfd, 0x6b,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff];
        }
        break;
      }

      default:
        throw new Error(`AM308: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // AM308 is uniquely identified by PM channels: 0x0B 0x7D (PM2.5) or 0x0C 0x7D (PM10).
  // In ALL_CODECS: place AM308 BEFORE AM307/AM307L — AM308 payloads also contain
  // 0x08 0x7D (TVOC) which would match AM307/AM307L first.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x0b && bytes[i+1] === 0x7d) return true; // PM2.5
      if (bytes[i] === 0x0c && bytes[i+1] === 0x7d) return true; // PM10
    }
    return false;
  }
}