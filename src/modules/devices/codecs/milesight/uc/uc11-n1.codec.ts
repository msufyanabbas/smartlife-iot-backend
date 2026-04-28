// src/modules/devices/codecs/milesight/uc11-n1.codec.ts
// Milesight UC11-N1 — Universal Controller (GPIO + ADC + Modbus)
//
// Protocol: IPSO channel_id + channel_type (decode-only — encoder is a no-op)
//
// Telemetry channels:
//   0xFF 0x01 — ipso_version (1B, nibble-split)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0x0B — device_status (1B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0x08 — sn (6B)  ← NOTE: 6 bytes, not 8 (different from VS series)
//   0x01 0x75 — battery (uint8 %)
//   0x03 <any≠0xC8> — gpio_1 (1B): 0=low, 1=high
//   0x04 <any≠0xC8> — gpio_2 (1B): 0=low, 1=high
//   0x04 0xC8  — gpio_counter (uint32 LE)
//   0x05 <any> — adc_1 (int16/100) + adc_1_min + adc_1_max + adc_1_avg (each int16/100) = 8B
//   0x06 <any> — adc_2 (int16/100) + adc_2_min + adc_2_max + adc_2_avg                  = 8B
//   0xFF 0x0E  — modbus: modbus_chn_id(1B) + package_type(1B) + data(1-4B)
//               channel key = "modbus_chn_{id-6}", data_type = package_type & 0x07
//               data_type: 0,1→uint8; 2,3→uint16 LE; 4,6→uint32 LE; 5,7→float32 LE

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── IEEE 754 float32 LE ────────────────────────────────────────────────────
function readFloatLE(bytes: number[], i: number): number {
  const bits = ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0;
  const sign  = (bits >>> 31) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 23) & 0xff;
  const m     = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

export class MilesightUC11N1Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc11-n1';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC11-N1'];
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
      // SN is 6 bytes (0xFF 0x08), unlike VS series which uses 0xFF 0x16 + 8 bytes
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = bytes.slice(i, i + 6)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 6;
      }

      // ── Battery (0x01 0x75) ───────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── GPIO 1 (0x03, type ≠ 0xC8) ────────────────────────────────────────
      else if (ch === 0x03 && ty !== 0xc8) {
        decoded.gpio_1 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── GPIO 2 (0x04, type ≠ 0xC8) ────────────────────────────────────────
      else if (ch === 0x04 && ty !== 0xc8) {
        decoded.gpio_2 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── Pulse counter (0x04 0xC8) — uint32 LE ─────────────────────────────
      else if (ch === 0x04 && ty === 0xc8) {
        decoded.gpio_counter = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // ── ADC 1 (0x05, any type) — 4× int16 LE /100 = 8B ───────────────────
      else if (ch === 0x05) {
        const r = (o: number) => { const v = ((bytes[i + o + 1] << 8) | bytes[i + o]) & 0xffff; return (v > 0x7fff ? v - 0x10000 : v) / 100; };
        decoded.adc_1     = r(0);
        decoded.adc_1_min = r(2);
        decoded.adc_1_max = r(4);
        decoded.adc_1_avg = r(6);
        i += 8;
      }

      // ── ADC 2 (0x06, any type) — 4× int16 LE /100 = 8B ───────────────────
      else if (ch === 0x06) {
        const r = (o: number) => { const v = ((bytes[i + o + 1] << 8) | bytes[i + o]) & 0xffff; return (v > 0x7fff ? v - 0x10000 : v) / 100; };
        decoded.adc_2     = r(0);
        decoded.adc_2_min = r(2);
        decoded.adc_2_max = r(4);
        decoded.adc_2_avg = r(6);
        i += 8;
      }

      // ── Modbus (0xFF 0x0E) ────────────────────────────────────────────────
      // [i] = raw_chn_id (subtract 6 to get logical id)
      // [i+1] = package_type; data_type = package_type & 0x07
      // data_type: 0,1 → uint8 (1B); 2,3 → uint16 LE (2B); 4,6 → uint32 LE (4B); 5,7 → float32 LE (4B)
      else if (ch === 0xff && ty === 0x0e) {
        const modbusChId  = (bytes[i] & 0xff) - 6;
        const packageType = bytes[i + 1] & 0xff;
        const dataType    = packageType & 0x07;
        const key         = `modbus_chn_${modbusChId}`;
        i += 2;

        switch (dataType) {
          case 0:
          case 1:
            decoded[key] = bytes[i] & 0xff; i += 1; break;
          case 2:
          case 3:
            decoded[key] = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff; i += 2; break;
          case 4:
          case 6:
            decoded[key] = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
              (bytes[i + 1] << 8) | bytes[i]) >>> 0);
            i += 4; break;
          case 5:
          case 7:
            decoded[key] = readFloatLE(bytes, i); i += 4; break;
          default:
            break;
        }
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // UC11-N1 encoder is a no-op stub in the official firmware — no downlink commands.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('UC11-N1: no downlink commands supported');
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC11-N1 is uniquely identified by:
  //   0xFF 0x08 — 6-byte SN (no other device uses this)
  //   0x05 <any> / 0x06 <any> — ADC channels with 8B data
  //   0x04 0xC8 — pulse counter

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0xff && ty === 0x08) return true; // 6B SN: UC11-N1 unique
      if (ch === 0x04 && ty === 0xc8) return true; // pulse counter
      if (ch === 0x05 || ch === 0x06) return true; // ADC channels
    }
    return false;
  }
}