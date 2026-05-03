// src/modules/devices/codecs/milesight/uc11xx.codec.ts
// Milesight UC11xx — Universal Controller (dual GPIO input/output/counter + dual ADC + Modbus)
// Covers: UC11-N1B, UC11-N2, UC11-N3, UC300 and other UC11xx variants sharing this decoder
//
// Protocol: IPSO channel_id + channel_type (decode-only — encoder is a no-op)
//
// Channels (differ from UC11-N1):
//   0xFF 0x01 — ipso_version (1B)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0x0B — device_status (1B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0x08 — sn (6B)
//   0x01 <≠0xC8> — gpio_input_1 (1B): low/high
//   0x02 <≠0xC8> — gpio_input_2 (1B): low/high
//   0x01 0xC8   — gpio_counter_1 (uint32 LE)
//   0x02 0xC8   — gpio_counter_2 (uint32 LE)
//   0x09 <any>  — gpio_output_1 (1B): low/high
//   0x0A <any>  — gpio_output_2 (1B): low/high
//   0x11 <any>  — adc_1 (4× int16 LE /100) = 8B
//   0x12 <any>  — adc_2 (4× int16 LE /100) = 8B
//   0xFF 0x0E   — modbus: chn_id(1B) + package_type(1B) + data(1–4B)
//                 key = "modbus_chn_{chn_id}" (direct, no offset unlike UC11-N1)
//                 data_type = package_type & 0x07
//                 0,1→uint8; 2,3→uint16 LE; 4,6→uint32 LE; 5,7→float32 LE

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

function readFloatLE(bytes: number[], i: number): number {
  const bits = ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0;
  const sign  = (bits >>> 31) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 23) & 0xff;
  const m     = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}

export class MilesightUC11xxCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc11xx';
  readonly manufacturer    = 'Milesight';
  // Register specific model names as discovered; the decoder is shared across
  // multiple UC11xx variants that use this same payload format.
  readonly supportedModels = ['UC11-N1B', 'UC11-N2', 'UC11-N3'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'UC11-N1B',
    description:  'Universal Controller — dual GPIO inputs/outputs, dual ADC channels, dual pulse counters, and Modbus',
    telemetryKeys: [
      { key: 'gpio_input_1',   label: 'GPIO Input 1',   type: 'string' as const, enum: ['high', 'low'] },
      { key: 'gpio_input_2',   label: 'GPIO Input 2',   type: 'string' as const, enum: ['high', 'low'] },
      { key: 'gpio_counter_1', label: 'GPIO Counter 1', type: 'number' as const              },
      { key: 'gpio_counter_2', label: 'GPIO Counter 2', type: 'number' as const              },
      { key: 'gpio_output_1',  label: 'GPIO Output 1',  type: 'string' as const, enum: ['high', 'low'] },
      { key: 'gpio_output_2',  label: 'GPIO Output 2',  type: 'string' as const, enum: ['high', 'low'] },
      { key: 'adc_1',          label: 'ADC 1',          type: 'number' as const              },
      { key: 'adc_1_min',      label: 'ADC 1 Min',      type: 'number' as const              },
      { key: 'adc_1_max',      label: 'ADC 1 Max',      type: 'number' as const              },
      { key: 'adc_1_avg',      label: 'ADC 1 Average',  type: 'number' as const              },
      { key: 'adc_2',          label: 'ADC 2',          type: 'number' as const              },
      { key: 'adc_2_min',      label: 'ADC 2 Min',      type: 'number' as const              },
      { key: 'adc_2_max',      label: 'ADC 2 Max',      type: 'number' as const              },
      { key: 'adc_2_avg',      label: 'ADC 2 Average',  type: 'number' as const              },
    ],
    commands: [],  // UC11xx has no downlink commands
    uiComponents: [
      { type: 'value' as const, label: 'GPIO Input 1',   keys: ['gpio_input_1']    },
      { type: 'value' as const, label: 'GPIO Input 2',   keys: ['gpio_input_2']    },
      { type: 'value' as const, label: 'GPIO Counter 1', keys: ['gpio_counter_1']  },
      { type: 'value' as const, label: 'GPIO Counter 2', keys: ['gpio_counter_2']  },
      { type: 'value' as const, label: 'GPIO Output 1',  keys: ['gpio_output_1']   },
      { type: 'value' as const, label: 'GPIO Output 2',  keys: ['gpio_output_2']   },
      { type: 'value' as const, label: 'ADC 1',          keys: ['adc_1']           },
      { type: 'value' as const, label: 'ADC 2',          keys: ['adc_2']           },
    ],
  };
}

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
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = bytes.slice(i, i + 6)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 6;
      }

      // ── GPIO input 1 (0x01, type ≠ 0xC8) ─────────────────────────────────
      else if (ch === 0x01 && ty !== 0xc8) {
        decoded.gpio_input_1 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── GPIO input 2 (0x02, type ≠ 0xC8) ─────────────────────────────────
      else if (ch === 0x02 && ty !== 0xc8) {
        decoded.gpio_input_2 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── GPIO counter 1 (0x01 0xC8) ────────────────────────────────────────
      else if (ch === 0x01 && ty === 0xc8) {
        decoded.gpio_counter_1 = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // ── GPIO counter 2 (0x02 0xC8) ────────────────────────────────────────
      else if (ch === 0x02 && ty === 0xc8) {
        decoded.gpio_counter_2 = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // ── GPIO output 1 (0x09, any type) ────────────────────────────────────
      else if (ch === 0x09) {
        decoded.gpio_output_1 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── GPIO output 2 (0x0A, any type) ────────────────────────────────────
      else if (ch === 0x0a) {
        decoded.gpio_output_2 = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── ADC 1 (0x11, any type) — 4× int16 LE /100 = 8B ───────────────────
      else if (ch === 0x11) {
        const r = (o: number) => { const v = ((bytes[i + o + 1] << 8) | bytes[i + o]) & 0xffff; return (v > 0x7fff ? v - 0x10000 : v) / 100; };
        decoded.adc_1     = r(0);
        decoded.adc_1_min = r(2);
        decoded.adc_1_max = r(4);
        decoded.adc_1_avg = r(6);
        i += 8;
      }

      // ── ADC 2 (0x12, any type) — 4× int16 LE /100 = 8B ───────────────────
      else if (ch === 0x12) {
        const r = (o: number) => { const v = ((bytes[i + o + 1] << 8) | bytes[i + o]) & 0xffff; return (v > 0x7fff ? v - 0x10000 : v) / 100; };
        decoded.adc_2     = r(0);
        decoded.adc_2_min = r(2);
        decoded.adc_2_max = r(4);
        decoded.adc_2_avg = r(6);
        i += 8;
      }

      // ── Modbus (0xFF 0x0E) ────────────────────────────────────────────────
      // [i] = chn_id (direct — no offset, unlike UC11-N1)
      // [i+1] = package_type; data_type = package_type & 0x07
      else if (ch === 0xff && ty === 0x0e) {
        const modbusChId  = bytes[i] & 0xff;
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

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('UC11xx: no downlink commands supported');
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC11xx is uniquely identified by:
  //   0x11 / 0x12 — ADC channels (UC11xx-specific channel numbers)
  //   0x09 / 0x0A — GPIO output channels
  //   0x01/0x02 0xC8 — dual counters (UC11-N1 only has 0x04 0xC8)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x11 || ch === 0x12) return true;          // ADC channels
      if (ch === 0x09 || ch === 0x0a) return true;          // GPIO output channels
      if ((ch === 0x01 || ch === 0x02) && ty === 0xc8) return true; // dual counters
    }
    return false;
  }
}