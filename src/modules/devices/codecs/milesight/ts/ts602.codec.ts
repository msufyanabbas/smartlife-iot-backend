// src/modules/devices/codecs/milesight/ts602.codec.ts
// Milesight TS602 — Cellular Temperature / Humidity / Tilt / Light Sensor
//
// TS602 is virtually identical to TS601 with two differences:
//   1. Extended temperature range: -200°C to 800°C (vs -35 to 70°C in TS601)
//      Wire encoding unchanged: int32 LE /100
//   2. One additional command:
//      0x55 — temperature_humidity_display_switch
//             payload: 1 byte (0 = temperature, 1 = humidity)
//
// All other channels, alarm structures, cellular settings, history framing,
// and configuration commands are byte-for-byte identical to TS601.
//
// canDecode:
//   0x55 in payload → definitively TS602
//   Otherwise same fingerprint as TS601 (0x0D tilt, 0x82 probe retransmit)
//   In ALL_CODECS, TS602 must appear before TS601.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';
import { MilesightTS601Codec } from './ts601.codec';

export class MilesightTS602Codec extends MilesightTS601Codec {
  override readonly codecId         = 'milesight-ts602';
  override readonly supportedModels = ['TS602'];
  override readonly category        = 'Temperature & Humidity Sensor';
  override readonly modelFamily     = 'TS602';
  override readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ts-series/ts602/ts602.png';

  // In MilesightTS602Codec:
getCapabilities(): DeviceCapability {
  return {
    ...super.getCapabilities(),
    codecId:     this.codecId,
    model:       'TS602',
    description: 'Cellular Temperature & Humidity Sensor — extended range (-200°C to 800°C) with display switch',
    commands: [
      ...super.getCapabilities().commands,
      {
        type:   'set_temperature_humidity_display_switch',
        label:  'Set Display Switch',
        params: [{ key: 'switch', label: 'Display', type: 'select' as const, required: true, options: [{ label: 'Temperature', value: 'temperature' }, { label: 'Humidity', value: 'humidity' }] }],
      },
    ],
  };
}

  // ── Decode ─────────────────────────────────────────────────────────────────
  // Run TS601 decode, then scan for any 0x55 bytes. Since 0x55 is not a
  // payload byte in any other TS601 command, a linear scan is safe.
  // The parent's `default: i += 1` skips 0x55 and its payload byte harmlessly.

  override decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const decoded = super.decode(payload, fPort) as any;
    const bytes   = this.normalizePayload(payload);

    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x55) {
        decoded.temperature_humidity_display_switch = {
          switch: bytes[i + 1] === 1 ? 'humidity' : 'temperature',
        };
        i += 1; // skip payload byte
      }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ─────────────────────────────────────────────────────────────────

  override encode(command: { type: string; params?: any }): EncodedCommand {
    if (command.type === 'set_temperature_humidity_display_switch') {
      const sw    = command.params?.switch === 'humidity' ? 1 : 0;
      const bytes = [0x55, sw];
      return { fPort: 0, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
    }
    return super.encode(command);
  }

  // ── canDecode ───────────────────────────────────────────────────────────────

  override canDecode(payload: string | Buffer, metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x55) return true;
    }
    return super.canDecode(payload, metadata);
  }
}