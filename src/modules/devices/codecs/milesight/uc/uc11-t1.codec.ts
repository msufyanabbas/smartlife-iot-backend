// src/modules/devices/codecs/milesight/uc11-t1.codec.ts
// Milesight UC11-T1 — Temperature & Humidity Sensor (decode-only)
//
// Protocol: IPSO channel_id + channel_type
//
// Channels:
//   0xFF 0x01 — ipso_version (1B, nibble-split)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0x0B — device_status (1B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0x08 — sn (6B)  ← same 6-byte SN as UC11-N1
//   0x03 0x75 — battery (uint8 %)  ← NOTE: ch=0x03, not 0x01 like VS series
//   0x01 0x67 — temperature (int16 LE /10, °C)
//   0x02 0x68 — humidity (uint8 /2, %r.h.)
//
// Example: 0175640367040104687B
//   → 01 75 64   = battery ch=0x01?  NO — note decoder uses ch==0x03 for battery
//   The JSON example bytes "0175640367040104687B" shows:
//     03 75 64 → battery=100
//     01 67 04 01 → temperature=260/10=26.0°C
//     02 68 7B → humidity=123/2=61.5%

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightUC11T1Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc11-t1';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC11-T1'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute / version channels ──────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown'; i += 1;
      }
      // SN: 6 bytes via 0xFF 0x08 (same pattern as UC11-N1)
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = bytes.slice(i, i + 6)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 6;
      }

      // ── Battery (0x03 0x75) — NOTE: channel 0x03, not 0x01 ───────────────
      else if (ch === 0x03 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── Temperature (0x01 0x67) — int16 LE /10 ───────────────────────────
      else if (ch === 0x01 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }

      // ── Humidity (0x02 0x68) — uint8 /2 ──────────────────────────────────
      else if (ch === 0x02 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // UC11-T1 encoder is a no-op stub — no downlink commands supported.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('UC11-T1: no downlink commands supported');
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC11-T1 is uniquely identified by:
  //   0x03 0x75 — battery on channel 3 (unique among UC11 variants)
  //   0x01 0x67 + 0x02 0x68 — temperature + humidity together

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasBattery = false;
    let hasTemp    = false;
    let hasHumid   = false;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x03 && ty === 0x75) hasBattery = true;
      if (ch === 0x01 && ty === 0x67) hasTemp    = true;
      if (ch === 0x02 && ty === 0x68) hasHumid   = true;
    }
    return hasBattery || (hasTemp && hasHumid);
  }
}