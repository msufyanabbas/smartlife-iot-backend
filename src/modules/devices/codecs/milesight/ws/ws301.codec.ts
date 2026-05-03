// src/modules/devices/codecs/milesight/ws301.codec.ts
// Milesight WS301 — LoRaWAN Magnetic Contact Switch (Door/Window Sensor)
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x00 — magnet_status (uint8: 0=close, 1=open)
//   0x04 0x00 — tamper_status (uint8: 0=installed, 1=uninstalled)
//
// ── CHANNEL COLLISION WITH WS303 ─────────────────────────────────────────────
//   WS303 also uses 0x03 0x00 but decodes it as leakage_status.
//   WS301 is identified by 0x04 0x00 (tamper_status) which WS303 does NOT have.
//   WS301 MUST be registered BEFORE WS303 in ALL_CODECS.
//   canDecode checks for 0x04 0x00 to positively identify WS301.
//
// ── SN: 0xFF 0x08, 6B (same as original WS503/WS501, not 8B like newer models)
//
// Downlink commands & responses:
//   0xFF 0x10 0xFF       — reboot
//   0xFF 0x28 0xFF       — query_device_status
//   0xFF 0x03 <u16>      — set_report_interval (seconds)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

export class MilesightWS301Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws301';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS301'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS301',
    description:  'Magnetic Contact Switch — door/window open/close detection with tamper alarm',
    telemetryKeys: [
      { key: 'battery',       label: 'Battery',       type: 'number' as const, unit: '%' },
      { key: 'magnet_status', label: 'Magnet Status', type: 'string' as const, enum: ['open', 'close'] },
      { key: 'tamper_status', label: 'Tamper Status', type: 'string' as const, enum: ['installed', 'uninstalled'] },
    ],
    commands: [
      { type: 'reboot',              label: 'Reboot Device',       params: [] },
      { type: 'query_device_status', label: 'Query Device Status', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60 }],
      },
    ],
    uiComponents: [
      { type: 'gauge'  as const, label: 'Battery',       keys: ['battery'],       unit: '%' },
      { type: 'status' as const, label: 'Magnet Status', keys: ['magnet_status']             },
      { type: 'status' as const, label: 'Tamper Status', keys: ['tamper_status']             },
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
      else if (ch === 0x01 && ty === 0x75) { decoded.battery = bytes[i++] & 0xff; }

      // Magnet status: 0x03 0x00 — same channel ID as WS303 leakage but different semantics
      else if (ch === 0x03 && ty === 0x00) {
        decoded.magnet_status = bytes[i++] === 1 ? 'open' : 'close';
      }

      // Tamper status: 0x04 0x00 — unique to WS301; used as canDecode fingerprint
      else if (ch === 0x04 && ty === 0x00) {
        decoded.tamper_status = bytes[i++] === 1 ? 'uninstalled' : 'installed';
      }

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
      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':              bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'set_report_interval': bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 300)]; break;
      default: throw new Error(`WS301: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS301 identified by 0x04 0x00 (tamper_status).
  // This distinguishes it from WS303 which also uses 0x03 0x00.
  // WS301 must appear BEFORE WS303 in ALL_CODECS.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x04 && bytes[i + 1] === 0x00) return true;
    }
    return false;
  }
}