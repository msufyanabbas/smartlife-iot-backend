// src/modules/devices/codecs/milesight/vs330.codec.ts
// Milesight VS330 — Bathroom Occupancy Sensor (ToF distance-based)
//
// Telemetry channels:
//   0xFF 0x01 — ipso_version (1B, nibble-split)
//   0xFF 0x09 — hardware_version (2B)
//   0xFF 0x0A — firmware_version (2B)
//   0xFF 0xFF — tsl_version (2B)
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class (1B)
//   0xFF 0xFE — reset_event (1B)
//   0xFF 0x0B — device_status (1B)
//   0x01 0x75 — battery (uint8 %)
//   0x02 0x82 — distance (uint16 LE, mm)
//   0x03 0x8E — occupancy (1B): 0=vacant, 1=occupied
//   0x04 0x8E — calibration_status (1B): 0=failed, 1=success
//
// Downlink (all 0xFF/0xFE prefix):
//   0x02 — collection_interval (uint16 LE, seconds, 1–10)
//   0x03 — report_interval (uint16 LE, seconds, 60–64800)
//   0x10 — reboot
//   0x70 — human_exist_height (uint16 LE, mm, 1–300)
//   0x71 — test_enable (1B)
//   0x72 — test_duration (uint16 LE, min, 1–30)
//   0x7A — back_test_config: enable(1B) + distance(uint16 LE, mm, 40–3500)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightVS330Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs330';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS330'];
  readonly protocol        = 'lorawan' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/vs-series/vs330/vs330.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'VS330',
    description:  'Bathroom Occupancy Sensor — ToF distance-based occupancy detection',
    telemetryKeys: [
      { key: 'battery',             label: 'Battery',             type: 'number' as const, unit: '%'  },
      { key: 'distance',            label: 'Distance',            type: 'number' as const, unit: 'mm' },
      { key: 'occupancy',           label: 'Occupancy',           type: 'string' as const, enum: ['occupied', 'vacant'] },
      { key: 'calibration_status',  label: 'Calibration Status',  type: 'string' as const, enum: ['success', 'failed'] },
    ],
    commands: [
      { type: 'reboot', label: 'Reboot Device', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 60, max: 64800 }],
      },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 5, min: 1, max: 10 }],
      },
      {
        type:   'set_human_exist_height',
        label:  'Set Human Exist Height',
        params: [{ key: 'human_exist_height', label: 'Height (mm)', type: 'number' as const, required: true, default: 120, min: 1, max: 300 }],
      },
      {
        type:   'set_test_enable',
        label:  'Set Test Mode Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_test_duration',
        label:  'Set Test Duration',
        params: [{ key: 'test_duration', label: 'Duration (minutes)', type: 'number' as const, required: true, default: 10, min: 1, max: 30 }],
      },
      {
        type:   'set_back_test_config',
        label:  'Set Back Test Config',
        params: [
          { key: 'enable',   label: 'Enable',          type: 'boolean' as const, required: true  },
          { key: 'distance', label: 'Distance (mm)',    type: 'number'  as const, required: false, default: 1000, min: 40, max: 3500 },
        ],
      },
    ],
    uiComponents: [
      { type: 'gauge'  as const, label: 'Battery',    keys: ['battery'],   unit: '%'  },
      { type: 'status' as const, label: 'Occupancy',  keys: ['occupancy']             },
      { type: 'value'  as const, label: 'Distance',   keys: ['distance'],  unit: 'mm' },
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
        // ipso_version: upper nibble = major, lower nibble = minor
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        // hardware_version: hex(major) + minor>>4
        decoded.hardware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        // firmware_version: hex(major) + hex(minor)
        decoded.firmware_version =
          `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
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
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal'; i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Telemetry channels ────────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // DISTANCE (0x02 0x82) — uint16 LE, mm
      else if (ch === 0x02 && ty === 0x82) {
        decoded.distance = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        i += 2;
      }

      // OCCUPANCY (0x03 0x8E) — 0=vacant, 1=occupied
      else if (ch === 0x03 && ty === 0x8e) {
        decoded.occupancy = bytes[i] === 1 ? 'occupied' : 'vacant'; i += 1;
      }

      // CALIBRATION STATUS (0x04 0x8E) — 0=failed, 1=success
      else if (ch === 0x04 && ty === 0x8e) {
        decoded.calibration_status = bytes[i] === 1 ? 'success' : 'failed'; i += 1;
      }

      // ── Downlink responses (0xFF / 0xFE prefix) ───────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;

    switch (ty) {
      case 0x02:
        data.collection_interval = u16(offset); offset += 2; break;
      case 0x03:
        data.report_interval = u16(offset); offset += 2; break;
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x70:
        data.human_exist_height = u16(offset); offset += 2; break;
      case 0x71:
        data.test_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x72:
        data.test_duration = u16(offset); offset += 2; break;
      case 0x7a:
        data.back_test_config = {
          enable:   bytes[offset] === 1 ? 'enable' : 'disable',
          distance: u16(offset + 1),
        };
        offset += 3; break;
      default:
        offset += 1; break;
    }

    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

    switch (type) {

      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_collection_interval': {
        const v = params.collection_interval ?? 5;
        if (v < 1 || v > 10) throw new Error('collection_interval must be 1–10 seconds');
        bytes = [0xff, 0x02, ...u16(v)];
        break;
      }

      case 'set_report_interval': {
        const v = params.report_interval ?? 600;
        if (v < 60 || v > 64800) throw new Error('report_interval must be 60–64800 seconds');
        bytes = [0xff, 0x03, ...u16(v)];
        break;
      }

      case 'set_human_exist_height': {
        const v = params.human_exist_height ?? 120;
        if (v < 1 || v > 300) throw new Error('human_exist_height must be 1–300 mm');
        bytes = [0xff, 0x70, ...u16(v)];
        break;
      }

      case 'set_test_enable':
        bytes = [0xff, 0x71, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_test_duration': {
        const v = params.test_duration ?? 10;
        if (v < 1 || v > 30) throw new Error('test_duration must be 1–30 minutes');
        bytes = [0xff, 0x72, ...u16(v)];
        break;
      }

      case 'set_back_test_config': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const dist   = params.distance ?? 1000;
        if (dist < 40 || dist > 3500) throw new Error('back_test_config.distance must be 40–3500 mm');
        bytes = [0xff, 0x7a, enable, ...u16(dist)];
        break;
      }

      default:
        throw new Error(`VS330: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS330 is uniquely identified by:
  //   0x02 0x82 — distance (mm, uint16)
  //   0x03 0x8E — occupancy
  //   0x04 0x8E — calibration_status

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x02 && ty === 0x82) return true;
      if (ch === 0x03 && ty === 0x8e) return true;
      if (ch === 0x04 && ty === 0x8e) return true;
    }
    return false;
  }
}