// src/modules/devices/codecs/milesight/em320-th.codec.ts
/**
 * Milesight EM320-TH — LoRaWAN Temperature & Humidity Sensor
 *
 * ── Relation to EM300-TH ──────────────────────────────────────────────────────
 * EM320-TH has the same telemetry channels as EM300-TH but a smaller downlink
 * command set — it omits leakage_alarm_config, temperature_calibration_settings,
 * humidity_calibration_settings, and d2d_master_config. Modelled as a standalone
 * codec rather than a thin subclass to prevent sending unsupported commands.
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
 *   0x20 0xCE — history record (7B): timestamp(4B u32) + temperature(2B i16/10) + humidity(1B u8/2)
 *
 * ── Downlink commands ────────────────────────────────────────────────────────
 *   0xFF 0x10 0xFF       — reboot
 *   0xFF 0x28 0xFF       — report_status
 *   0xFF 0x03 u16LE      — report_interval (s, range: [60, 64800])
 *   0xFF 0x02 u16LE      — collection_interval (s, range: [60, 64800])
 *   0xFF 0x06 data(11B)  — temperature_alarm_config
 *     data[0]: bits[2:0]=condition, bit3=1 (temperature channel)
 *     data[1-2]: threshold_min (i16LE × 10)
 *     data[3-4]: threshold_max (i16LE × 10)
 *     data[5-8]: reserved zeros
 *   0xFF 0x68 u8         — history_enable
 *   0xFF 0x69 u8         — retransmit_enable
 *   0xFF 0x6A sub u16LE  — retransmit_interval (sub=0) / resend_interval (sub=1)
 *   0xFD 0x6B u32LE      — fetch_history (start only)
 *   0xFD 0x6C u32LE u32LE — fetch_history (start + end)
 *   0xFD 0x6D 0xFF       — stop_transmit
 *   0xFF 0x27 0x01       — clear_history
 *
 * ── canDecode fingerprint ─────────────────────────────────────────────────────
 *   Uses model metadata to disambiguate from EM300-TH — both share identical
 *   telemetry channels. When no metadata is available, falls back to matching
 *   on 0x03 0x67 + 0x04 0x68 (may over-match to EM300-TH payloads).
 *   In ALL_CODECS: place EM320-TH before EM300-TH since it is the more specific codec,
 *   and use model metadata to disambiguate.
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const LORAWAN_CLASS: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
const CONDITION_MAP: Record<number, string>  = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_R:   Record<string, number>  = { disable:0, below:1, above:2, between:3, outside:4 };

export class MilesightEM320ThCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-em320-th';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['EM320-TH'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Temperature & Humidity Sensor';
  readonly modelFamily     = 'EM320-TH';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/em-series/em320-th/em320-th.png';

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
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => (b & 0xff).toString(16).padStart(2, '0')).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        decoded.lorawan_class = LORAWAN_CLASS[bytes[i++]] ?? 'unknown';
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = 'reset'; i++;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
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

      // History record: 7B — timestamp(4) + temperature(2) + humidity(1)
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i+3] << 24) | (bytes[i+2] << 16) | (bytes[i+1] << 8) | bytes[i]) >>> 0);
        const rawT = (bytes[i+5] << 8) | bytes[i+4];
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({
          timestamp:   ts,
          temperature: (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10,
          humidity:    (bytes[i+6] & 0xff) / 2,
        });
        i += 7;
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

  private decodeDownlinkResponse(
    ty: number, bytes: number[], offset: number
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x02: data.collection_interval = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;
      case 0x03: data.report_interval     = ((bytes[offset+1] << 8) | bytes[offset]) & 0xffff; offset += 2; break;

      case 0x06: {
        const b    = bytes[offset] & 0xff;
        const cond = b & 0x07;
        const rawMin = (bytes[offset+2] << 8) | bytes[offset+1];
        const rawMax = (bytes[offset+4] << 8) | bytes[offset+3];
        data.temperature_alarm_config = {
          condition:     CONDITION_MAP[cond] ?? 'unknown',
          threshold_min: (rawMin > 0x7fff ? rawMin - 0x10000 : rawMin) / 10,
          threshold_max: (rawMax > 0x7fff ? rawMax - 0x10000 : rawMax) / 10,
        };
        offset += 9; break;
      }

      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x68: data.history_enable    = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: data.retransmit_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x6a: {
        const sub = bytes[offset] & 0xff;
        const val = ((bytes[offset+2] << 8) | bytes[offset+1]) & 0xffff;
        if (sub === 0) data.retransmit_interval = val;
        else           data.resend_interval     = val;
        offset += 3; break;
      }

      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;

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
      case 'report_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history': bytes = [0xff, 0x27, 0x01]; break;

      case 'set_report_interval': {
        const v = p.report_interval ?? p.seconds ?? 600;
        if (v < 60 || v > 64800) throw new Error('report_interval: 60–64800 s');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_collection_interval': {
        const v = p.collection_interval ?? p.seconds ?? 300;
        if (v < 60 || v > 64800) throw new Error('collection_interval: 60–64800 s');
        bytes = [0xff, 0x02, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_temperature_alarm': {
        const cfg  = p.temperature_alarm_config ?? p;
        const cond = typeof cfg.condition === 'string' ? (CONDITION_R[cfg.condition] ?? 0) : (cfg.condition ?? 0);
        const dataByte = (1 << 3) | (cond & 0x07); // bit3=temperature channel
        const minRaw = Math.round((cfg.threshold_min ?? 0) * 10);
        const maxRaw = Math.round((cfg.threshold_max ?? 0) * 10);
        const minLE  = minRaw < 0 ? minRaw + 0x10000 : minRaw;
        const maxLE  = maxRaw < 0 ? maxRaw + 0x10000 : maxRaw;
        bytes = [0xff, 0x06, dataByte,
          minLE & 0xff, (minLE >> 8) & 0xff,
          maxLE & 0xff, (maxLE >> 8) & 0xff,
          0, 0, 0, 0]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, p.enable ? 1 : 0]; break;

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, p.enable ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = p.retransmit_interval ?? p.seconds ?? 60;
        if (v < 30 || v > 1200) throw new Error('retransmit_interval: 30–1200 s');
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_resend_interval': {
        const v = p.resend_interval ?? p.seconds ?? 60;
        if (v < 30 || v > 1200) throw new Error('resend_interval: 30–1200 s');
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff]; break;
      }

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
        throw new Error(`EM320-TH: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // EM320-TH shares telemetry channels with EM300-TH (0x03 0x67, 0x04 0x68).
  // Model metadata in _metadata.model is the primary disambiguator.
  // Without metadata: matches on temp+humidity channels (may co-match EM300-TH).

  canDecode(payload: string | Buffer, metadata?: any): boolean {
    // Use model string when available
    if (metadata?.model) {
      return this.supportedModels.includes(metadata.model);
    }

    const bytes = this.normalizePayload(payload);
    let hasTemp = false, hasHum = false;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x03 && bytes[i+1] === 0x67) hasTemp = true;
      if (bytes[i] === 0x04 && bytes[i+1] === 0x68) hasHum  = true;
    }
    return hasTemp && hasHum;
  }
}