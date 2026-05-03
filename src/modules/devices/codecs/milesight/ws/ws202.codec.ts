// src/modules/devices/codecs/milesight/ws202.codec.ts
// Milesight WS202 — LoRaWAN PIR & Light Sensor
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x00 — pir status (uint8: 0=normal, 1=trigger)
//   0x04 0x00 — daylight status (uint8: 0=dim, 1=bright)
//
// ── CHANNEL COLLISION WITH WS301 ─────────────────────────────────────────────
//   WS301 uses the same channels: 0x03 0x00 (magnet_status) + 0x04 0x00 (tamper_status)
//   WS202 cannot be distinguished from WS301 by payload bytes alone.
//   Both use SN format 0xFF 0x08 6B.
//   Codec selection MUST use model metadata when available.
//   canDecode returns true for 0x04 0x00 (same as WS301) — register both codecs and
//   rely on metadata or field-name awareness to select the correct one.
//   In ALL_CODECS, register WS202 after WS301 (or use metadata-first selection).
//
// Downlink commands:
//   0xFF 0x10 0xFF                         — reboot
//   0xFF 0x03 <u16>                        — set_report_interval (seconds)
//   0xFF 0x06 0x00 <u16_min> <u16_max> 0x00 0x00 0x00 0x00 — set_light_alarm_config (9B)
//
// SN: 0xFF 0x08, 6 bytes (legacy format)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

export class MilesightWS202Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws202';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS202'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS202',
    description:  'PIR & Light Sensor — motion detection and daylight/dim status',
    telemetryKeys: [
      { key: 'battery',  label: 'Battery',          type: 'number' as const, unit: '%' },
      { key: 'pir',      label: 'PIR Status',        type: 'string' as const, enum: ['normal', 'trigger'] },
      { key: 'daylight', label: 'Daylight Status',   type: 'string' as const, enum: ['dim', 'bright'] },
    ],
    commands: [
      { type: 'reboot', label: 'Reboot Device', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 60 }],
      },
      {
        type:   'set_light_alarm_config',
        label:  'Set Light Alarm Config',
        params: [
          { key: 'threshold_min', label: 'Min Threshold', type: 'number' as const, required: false, default: 0     },
          { key: 'threshold_max', label: 'Max Threshold', type: 'number' as const, required: false, default: 65535 },
        ],
      },
    ],
    uiComponents: [
      { type: 'gauge'  as const, label: 'Battery',  keys: ['battery'],  unit: '%' },
      { type: 'status' as const, label: 'PIR',      keys: ['pir']                 },
      { type: 'status' as const, label: 'Daylight', keys: ['daylight']            },
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

      // ── Attributes ────────────────────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++]; decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2; }
      // SN: 0xFF 0x08, 6 bytes (legacy format)
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = bytes.slice(i, i + 6).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 6;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Telemetry ─────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) { decoded.battery  = bytes[i++] & 0xff; }
      else if (ch === 0x03 && ty === 0x00) { decoded.pir      = bytes[i++] === 1 ? 'trigger' : 'normal'; }
      else if (ch === 0x04 && ty === 0x00) { decoded.daylight = bytes[i++] === 1 ? 'bright' : 'dim'; }

      // ── Downlink responses ─────────────────────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const r = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlinkResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03: data.report_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x06:
        // byte[0]=0x00 (type selector), then u16 min, u16 max, 4 bytes padding
        data.light_alarm_config = {
          threshold_min: u16(b, offset + 1),
          threshold_max: u16(b, offset + 3),
        };
        offset += 9; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot': bytes = [0xff, 0x10, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;

      // light_alarm_config: 0xFF 0x06 0x00 <u16_min> <u16_max> 0x00 0x00 0x00 0x00
      case 'set_light_alarm_config': {
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 65535;
        bytes = [0xff, 0x06, 0x00, ...wu16(min), ...wu16(max), 0x00, 0x00, 0x00, 0x00]; break;
      }

      default: throw new Error(`WS202: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS202 shares channel fingerprint with WS301 (both have 0x03 0x00 + 0x04 0x00).
  // Cannot be distinguished by payload bytes alone — use model metadata when possible.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x04 && bytes[i + 1] === 0x00) return true;
    }
    return false;
  }
}