// src/modules/devices/codecs/milesight/ft101.codec.ts
// Milesight FT101 — LoRaWAN Field Tester
//
// Protocol: Classic channel_id + channel_type (same family as GS301/WT101/UC100)
// Read-only device — no downlink commands supported.
//
// Channels:
//   0x03/0xA1 — GPS location (longitude + latitude, int32LE / 1,000,000)
//   0x04/0xA2 — Signal strength (RSSI int16LE / 10, SNR int16LE / 10)
//   0x05/0xA3 — Spreading factor (uint8)
//   0x06/0xA4 — TX power (int16LE / 100)

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightFT101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ft101';
  readonly manufacturer    = 'Milesight';
  readonly model           = 'FT101';
  readonly description     = 'LoRaWAN Field Tester — GPS, RSSI, SNR, SF, TX Power';
  readonly supportedModels = ['FT101'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    for (let i = 0; i < bytes.length; ) {
      const channel_id   = bytes[i++];
      const channel_type = bytes[i++];

      // ── Device attribute frames (0xFF prefix) ────────────────────────────

      if (channel_id === 0xff && channel_type === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (channel_id === 0xff && channel_type === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join(''); i += 8;
      }
      else if (channel_id === 0xff && channel_type === 0x0f) {
        decoded.lorawan_class = (['Class A', 'Class B', 'Class C', 'Class CtoB'])[bytes[i++]] ?? 'unknown';
      }
      else if (channel_id === 0xff && channel_type === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }
      else if (channel_id === 0xff && channel_type === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Telemetry frames ─────────────────────────────────────────────────

      // GPS Location — longitude(4B int32LE / 1_000_000) + latitude(4B int32LE / 1_000_000)
      else if (channel_id === 0x03 && channel_type === 0xa1) {
        decoded.longitude = this.i32(bytes, i)     / 1_000_000;
        decoded.latitude  = this.i32(bytes, i + 4) / 1_000_000;
        i += 8;
      }

      // Signal Strength — RSSI(2B int16LE / 10) + SNR(2B int16LE / 10)
      else if (channel_id === 0x04 && channel_type === 0xa2) {
        decoded.rssi = this.i16(bytes, i)     / 10;
        decoded.snr  = this.i16(bytes, i + 2) / 10;
        i += 4;
      }

      // Spreading Factor — SF(1B uint8)
      else if (channel_id === 0x05 && channel_type === 0xa3) {
        decoded.sf = bytes[i++];
      }

      // TX Power — tx_power(2B int16LE / 100)
      else if (channel_id === 0x06 && channel_type === 0xa4) {
        decoded.tx_power = this.i16(bytes, i) / 100; i += 2;
      }

      else { break; }
    }

    return decoded;
  }

  // ── Encode downlink ───────────────────────────────────────────────────────
  // FT101 is a read-only field tester — no downlink commands are supported.

  encode(command: { type: string; params?: any }): EncodedCommand {
    throw new Error(`FT101: this device does not support downlink commands (type: ${command.type})`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private u16(bytes: number[], i: number): number {
    return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
  }
  private i16(bytes: number[], i: number): number {
    const v = this.u16(bytes, i);
    return v > 0x7fff ? v - 0x10000 : v;
  }
  private u32(bytes: number[], i: number): number {
    return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
  }
  private i32(bytes: number[], i: number): number {
    const v = this.u32(bytes, i);
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
}