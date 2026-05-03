// src/modules/devices/codecs/milesight/gs524n.codec.ts
// Milesight GS524N — LoRaWAN Smoke Detection Sensor
//
// Protocol: Fixed 6-byte frame (NOT IPSO channel_id+type)
//   Byte 0: firmware_version[7:4] + protocol_version[3:0]
//   Byte 1: sensor_type[7:4]      + message_type[3:0]
//   Byte 2: battery (uint8, %)
//   Byte 3: concentration (uint8, %)
//   Byte 4: temperature (int8, °C, range -20..70)
//   Byte 5: CRC — sum of all 6 bytes must equal 0x00 (mod 256)
//
// sensor_type:  1 = smoke detection sensor
// message_type: 0x1=alarm, 0x2=silent, 0x4=low battery, 0x5=failover,
//               0x7=normal, 0xA=removed, 0xB=installed,
//               0xE=testing alarm with normal battery,
//               0xF=testing alarm with low battery
//
// Decode only — no downlink commands documented for this device.
//
// canDecode fingerprint:
//   Fixed 6-byte length is the first gate.
//   Byte 1 high nibble = sensor_type: only value 1 is defined (smoke sensor).
//   Byte 5 CRC: sum of all bytes == 0x00 mod 256.
//   Combined these make false-positive canDecode essentially impossible.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const EVENT_MAP: Record<number, string> = {
  0x01: 'alarm',
  0x02: 'silent',
  0x04: 'low battery',
  0x05: 'failover',
  0x07: 'normal',
  0x0a: 'removed',
  0x0b: 'installed',
  0x0e: 'testing alarm with normal battery',
  0x0f: 'testing alarm with low battery',
};

export class MilesightGS524NCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-gs524n';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['GS524N'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Smoke Detector';
  readonly modelFamily     = 'GS524N';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/gs-series/gs524n/gs524n.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'GS524N',
    description:  'Smoke Detection Sensor — smoke concentration, temperature, and battery',
    telemetryKeys: [
      { key: 'battery',       label: 'Battery',            type: 'number' as const, unit: '%'  },
      { key: 'concentration', label: 'Smoke Concentration', type: 'number' as const, unit: '%'  },
      { key: 'temperature',   label: 'Temperature',        type: 'number' as const, unit: '°C' },
      { key: 'event',         label: 'Event',              type: 'string' as const, enum: ['alarm', 'silent', 'normal', 'low battery', 'failover', 'removed', 'installed', 'testing alarm with normal battery', 'testing alarm with low battery'] },
    ],
    commands: [],  // GS524N has no downlink commands
    uiComponents: [
      { type: 'gauge' as const, label: 'Battery',             keys: ['battery'],       unit: '%'  },
      { type: 'value' as const, label: 'Smoke Concentration', keys: ['concentration'], unit: '%'  },
      { type: 'value' as const, label: 'Temperature',         keys: ['temperature'],   unit: '°C' },
      { type: 'value' as const, label: 'Event',               keys: ['event']                     },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);

    if (bytes.length !== 6) {
      return {} as DecodedTelemetry;
    }

    const decoded: any = {};

    decoded.version     = (bytes[0] >>> 4) & 0x0f;  // firmware_version in high nibble
    decoded.protocol    = bytes[0] & 0x0f;            // protocol_version in low nibble

    const sensorType    = (bytes[1] >>> 4) & 0x0f;
    const eventType     =  bytes[1] & 0x0f;

    decoded.type        = sensorType === 1 ? 'smoke sensor' : 'unknown';
    decoded.event       = EVENT_MAP[eventType] ?? 'unknown';

    decoded.battery     = bytes[2] & 0xff;
    decoded.batteryLevel = decoded.battery;

    decoded.concentration = bytes[3] & 0xff;        // smoke concentration, %

    // Byte 4: temperature as signed int8, range -20..70 °C
    const raw = bytes[4] & 0xff;
    decoded.temperature = raw > 0x7f ? raw - 0x100 : raw;

    // Byte 5 is CRC — not exposed in the output object

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // No downlink commands are defined for the GS524N.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('GS524N: this device has no downlink commands');
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // Must be exactly 6 bytes, sensor_type nibble == 1, and CRC valid.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length !== 6) return false;

    // CRC: sum of all 6 bytes must be 0x00 mod 256
    const sum = bytes.reduce((acc, b) => (acc + (b & 0xff)) & 0xff, 0);
    if (sum !== 0) return false;

    // Sensor type must be 1 (smoke sensor)
    const sensorType = (bytes[1] >>> 4) & 0x0f;
    return sensorType === 1;
  }
}