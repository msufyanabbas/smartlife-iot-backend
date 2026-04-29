// src/modules/devices/codecs/milesight/ft101.codec.ts
// Milesight FT101 — LoRaWAN Field Tester
//
// Protocol: IPSO channel_id + channel_type (same family as TS/GS IPSO series)
//
// Attributes:
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B hex)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//
// Telemetry:
//   0x03 0xA1 — longitude (int32 LE /1000000) + latitude (int32 LE /1000000)  8B
//   0x04 0xA2 — rssi (int16 LE /10, dBm) + snr (int16 LE /10, dB)            4B
//   0x05 0xA3 — sf (uint8, spreading factor)                                   1B
//   0x06 0xA4 — tx_power (int16 LE /100, dBm)                                 2B
//
// Decode only — no downlink commands documented for this device.
//
// canDecode fingerprint:
//   0x03 0xA1 (location) and/or 0x04 0xA2 (signal) are unique to FT101.
//   0x05 0xA3 (SF) and 0x06 0xA4 (tx_power) are also FT101-exclusive channels.

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

function i32(b: number[], i: number): number {
  const u = (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0);
  return u > 0x7fffffff ? u - 0x100000000 : u;
}
function i16(b: number[], i: number): number {
  const u = ((b[i + 1] << 8) | b[i]) & 0xffff;
  return u > 0x7fff ? u - 0x10000 : u;
}

export class MilesightFT101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ft101';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['FT101'];
  readonly protocol        = 'lorawan' as const;

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
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal'; i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Location (int32 LE / 1000000, degrees) ───────────────────────────────
      else if (ch === 0x03 && ty === 0xa1) {
        decoded.longitude = i32(bytes, i) / 1000000;
        decoded.latitude  = i32(bytes, i + 4) / 1000000;
        i += 8;
      }

      // ── Signal strength (int16 LE / 10) ───────────────────────────────────────
      else if (ch === 0x04 && ty === 0xa2) {
        decoded.rssi = i16(bytes, i) / 10;      // dBm
        decoded.snr  = i16(bytes, i + 2) / 10;  // dB
        i += 4;
      }

      // ── Spreading factor (uint8) ──────────────────────────────────────────────
      else if (ch === 0x05 && ty === 0xa3) {
        decoded.sf = bytes[i++] & 0xff;
      }

      // ── TX power (int16 LE / 100, dBm) ───────────────────────────────────────
      else if (ch === 0x06 && ty === 0xa4) {
        decoded.tx_power = i16(bytes, i) / 100;
        i += 2;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // No downlink commands are defined for the FT101.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('FT101: this device has no downlink commands');
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // FT101 is uniquely identified by its telemetry channel IDs:
  //   0x03 0xA1 (location) — FT101-exclusive
  //   0x04 0xA2 (signal)   — FT101-exclusive
  //   0x05 0xA3 (SF)       — FT101-exclusive
  //   0x06 0xA4 (tx_power) — FT101-exclusive

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x03 && ty === 0xa1) return true; // location
      if (ch === 0x04 && ty === 0xa2) return true; // signal
      if (ch === 0x05 && ty === 0xa3) return true; // SF
      if (ch === 0x06 && ty === 0xa4) return true; // tx_power
    }
    return false;
  }
}