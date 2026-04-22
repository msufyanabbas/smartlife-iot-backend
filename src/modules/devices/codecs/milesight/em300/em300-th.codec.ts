// src/modules/devices/codecs/milesight/em300-th.codec.ts
/**
 * Milesight EM300-TH Codec
 * Temperature & Humidity Sensor
 *
 * Telemetry channels:
 *   - battery      (%, uint8)
 *   - temperature  (°C, int16/10)
 *   - humidity     (%r.h., uint8/2)
 *   - history[]    (timestamp, temperature, humidity)
 *
 * Reference payload: '01755C03673401046865'
 *   → { battery: 92, temperature: 30.8, humidity: 50.5 }
 *
 * History payload: '20CE9E74466310015D00'
 *   → { history: [{ timestamp: 1665561758, temperature: 27.2, humidity: 46.5 }] }
 *
 * Based on official Milesight EM300-TH decoder v1.0.0
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightEM300THCodec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-em300-th';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['EM300-TH'];
  readonly protocol = 'lorawan' as const;

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ──────────────────────────────────────────────

      // IPSO VERSION (0xFF 0x01)
      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] & 0xf0) >> 4}.${bytes[i] & 0x0f}`;
        i += 1;
      }
      // HARDWARE VERSION (0xFF 0x09)
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      // FIRMWARE VERSION (0xFF 0x0A)
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      // TSL VERSION (0xFF 0xFF)
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      // SERIAL NUMBER (0xFF 0x16) — 8 bytes
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes
          .slice(i, i + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
          .join('');
        i += 8;
      }
      // LORAWAN CLASS (0xFF 0x0F)
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = {
          0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB',
        };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }
      // RESET EVENT (0xFF 0xFE)
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      // DEVICE STATUS (0xFF 0x0B)
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // BATTERY (0x01 0x75) — uint8, %
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = bytes[i] & 0xff;
        i += 1;
      }
      // TEMPERATURE (0x03 0x67) — int16 LE / 10, °C
      else if (ch === 0x03 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }
      // HUMIDITY (0x04 0x68) — uint8 / 2, %r.h.
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }

      // HISTORICAL DATA (0x20 0xCE) — 8 bytes
      // timestamp(4B LE) + temperature(2B int16 LE /10) + humidity(1B /2) + reserved(1B)
      else if (ch === 0x20 && ty === 0xce) {
        const timestamp = (
          ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0
        );
        const tempRaw = ((bytes[i + 5] << 8) | bytes[i + 4]) & 0xffff;
        const temperature = (tempRaw > 0x7fff ? tempRaw - 0x10000 : tempRaw) / 10;
        const humidity    = (bytes[i + 6] & 0xff) / 2;
        // bytes[i+7] is reserved — ignored

        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({ timestamp, temperature, humidity });
        i += 8;
      }

      // DOWNLINK RESPONSE (0xFE / 0xFF prefix)
      else if (ch === 0xfe || ch === 0xff) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded;
  }

  // ── Downlink response handler ─────────────────────────────────────────────

  private handleDownlinkResponse(
    ty: number,
    bytes: number[],
    offset: number,
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x10: // Reboot ACK
        data.reboot = 'yes';
        offset += 1;
        break;

      case 0x03: // Report interval ACK
        data.report_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x68: // History enable ACK
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x6b: // Fetch history ACK
        data.fetch_history = { start_time: ((bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset]) >>> 0 };
        offset += 4;
        break;

      case 0x6d: // Stop transmit ACK
        data.stop_transmit = 'yes';
        offset += 1;
        break;

      default:
        offset += 1;
        break;
    }

    return { data, offset };
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    const p = command.params ?? {};

    switch (command.type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_report_interval': {
        const v = p.interval ?? 300;
        if (typeof v !== 'number' || v < 1) throw new Error('interval must be a positive number');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, p.enable ? 1 : 0];
        break;

      case 'fetch_history': {
        const start = p.start_time ?? 0;
        if (p.end_time) {
          bytes = [
            0xfd, 0x6c,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
            p.end_time & 0xff, (p.end_time >> 8) & 0xff, (p.end_time >> 16) & 0xff, (p.end_time >> 24) & 0xff,
          ];
        } else {
          bytes = [
            0xfd, 0x6b,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
          ];
        }
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff];
        break;

      default:
        throw new Error(`EM300-TH: unsupported command "${command.type}"`);
    }

    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // EM300-TH is identified by:
  //   battery (0x01 0x75) + temperature (0x03 0x67) + humidity (0x04 0x68)
  // Temperature alone could be shared — we require at least two of the three.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let hasBattery     = false;
    let hasTemperature = false;
    let hasHumidity    = false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x01 && ty === 0x75) { hasBattery     = true; i += 3; continue; }
      if (ch === 0x03 && ty === 0x67) { hasTemperature = true; i += 4; continue; }
      if (ch === 0x04 && ty === 0x68) { hasHumidity    = true; i += 3; continue; }

      // Skip known attribute channels
      if (ch === 0xff && ty === 0x01) { i += 3;  continue; }
      if (ch === 0xff && (ty === 0x09 || ty === 0x0a)) { i += 4; continue; }
      if (ch === 0xff && ty === 0xff) { i += 4;  continue; }
      if (ch === 0xff && ty === 0x16) { i += 10; continue; }
      if (ch === 0xff && ty === 0x0f) { i += 3;  continue; }
      if (ch === 0xff && (ty === 0xfe || ty === 0x0b)) { i += 3; continue; }
      if (ch === 0x20 && ty === 0xce) { i += 10; continue; } // history entry

      break;
    }

    // Require at least temperature + one of battery or humidity
    return hasTemperature && (hasBattery || hasHumidity);
  }
}