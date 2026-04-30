// src/modules/devices/codecs/milesight/vs132.codec.ts
// Milesight VS132 — 3D ToF People Counting Sensor
//
// Telemetry channels:
//   0xFF 0x01 — protocol_version (1B)
//   0xFF 0x16 — sn (8B)
//   0xFF 0x09 — hardware_version (2B, each byte decimal dot-joined)
//   0xFF 0x1F — firmware_version (4B, each byte decimal dot-joined)
//   0x03 0xD2 — total_counter_in (uint32 LE)
//   0x04 0xD2 — total_counter_out (uint32 LE)
//   0x05 0xCC — periodic_counter_in (uint16 LE) + periodic_counter_out (uint16 LE)
//
// Downlink responses (0xFF / 0xFE prefix):
//   0x03 — report_interval
//   0x04 — confirm_mode_enable
//   0x10 — reboot
//   0x40 — adr_enable
//   0x42 — wifi_enable
//   0x43 — periodic_report_enable
//   0x51 — clear_total_count

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightVS132Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs132';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS132'];
  readonly protocol        = 'lorawan' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/vs-series/vs132/vs132.png';

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
        decoded.protocol_version = bytes[i++] & 0xff;
      }
      else if (ch === 0xff && ty === 0x16) {
        // SN: 8 bytes hex
        decoded.sn = bytes.slice(i, i + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x09) {
        // Hardware version: 2 bytes decimal dot-joined, e.g. [1,2] → "1.2"
        decoded.hardware_version = `${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x1f) {
        // Firmware version: 4 bytes decimal dot-joined, e.g. [132,1,0,1] → "132.1.0.1"
        decoded.firmware_version = [bytes[i], bytes[i+1], bytes[i+2], bytes[i+3]]
          .map(b => (b & 0xff).toString(10)).join('.');
        i += 4;
      }
      else if (ch === 0xff && ty === 0x0a) {
        // Older 2-byte firmware version
        decoded.firmware_version = `${bytes[i] & 0xff}.${bytes[i + 1] & 0xff}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ────────────────────────────────────────────────

      // TOTAL COUNTER IN (0x03 0xD2) — uint32 LE
      else if (ch === 0x03 && ty === 0xd2) {
        decoded.total_counter_in = this.readUInt32LE(bytes, i);
        i += 4;
      }
      // TOTAL COUNTER OUT (0x04 0xD2) — uint32 LE
      else if (ch === 0x04 && ty === 0xd2) {
        decoded.total_counter_out = this.readUInt32LE(bytes, i);
        i += 4;
      }
      // PERIODIC COUNTER IN/OUT (0x05 0xCC) — uint16 LE + uint16 LE
      else if (ch === 0x05 && ty === 0xcc) {
        decoded.periodic_counter_in  = this.readUInt16LE(bytes, i);
        decoded.periodic_counter_out = this.readUInt16LE(bytes, i + 2);
        i += 4;
      }

      // ── Downlink responses (0xFF / 0xFE prefix) ───────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else {
        break;
      }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03:
        data.report_interval = this.readUInt16LE(bytes, offset); offset += 2; break;
      case 0x04:
        data.confirm_mode_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x40:
        data.adr_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x42:
        data.wifi_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x43:
        data.periodic_report_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x51:
        data.clear_total_count = 'yes'; offset += 1; break;
      default:
        offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 64800) throw new Error('report_interval must be 1–64800');
        // Reference encoder writes only 1 byte for the value (uint8)
        bytes = [0xff, 0x03, v & 0xff];
        break;
      }

      case 'set_confirm_mode_enable':
        bytes = [0xff, 0x04, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_adr_enable':
        bytes = [0xff, 0x40, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_wifi_enable':
        bytes = [0xff, 0x42, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_periodic_report_enable':
        bytes = [0xff, 0x43, params.enable === 'enable' ? 1 : 0];
        break;

      case 'clear_total_count':
        bytes = [0xff, 0x51, 0xff];
        break;

      default:
        throw new Error(`VS132: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS132 is uniquely identified by the counter channels (0x03/0x04 0xD2)
  // or the periodic counter (0x05 0xCC).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if ((ch === 0x03 || ch === 0x04) && ty === 0xd2) return true;
      if (ch === 0x05 && ty === 0xcc) return true;
    }
    return false;
  }

  // ── Private read helpers ─────────────────────────────────────────────────────

  private readUInt16LE(bytes: number[], i: number): number {
    return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
  }

  private readUInt32LE(bytes: number[], i: number): number {
    return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
  }
}