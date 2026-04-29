// src/modules/devices/codecs/milesight/ws303.codec.ts
// Milesight WS303 — LoRaWAN Mini Leak Detection Sensor
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x00 — leakage_status (uint8: 0=normal, 1=leak)
//
// Attributes (0xFF channel):
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (0xFF 0x16, 8B), lorawan_class, reset_event, device_status
//
// Downlink commands & responses (0xFF / 0xFE channel):
//   0xFF 0x10 0xFF                    — reboot
//   0xFF 0x28 0xFF                    — query_device_status
//   0xFF 0x03 <u16>                   — set_report_interval (seconds)
//   0xFF 0x7E <enable> <u16_interval> <u16_count> — set_leakage_alarm_config (5 data bytes)
//   0xFF 0x3E <enable>                — set_buzzer_enable
//   0xFF 0x7F <enable>                — set_find_device_enable
//   0xFF 0x80 <u16>                   — set_find_device_time (seconds)
//   0xFF 0x3D 0xFF                    — stop_alarming
//   0xFF 0x81 0x01 <data>             — set_lora_report_settings (leakage=0x01; data bit0=lora,bit1=d2d)
//   0xFF 0x84 <enable>                — set_d2d_enable
//   0xFF 0x83 <mode> <cmd2B>          — set_d2d_master_config (mode: 0=normal,1=leakage)
//
// canDecode fingerprint: 0x01 0x75 (battery) + 0x03 0x00 (leakage) — unique to WS303

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function d2dEncode(cmd: string): number[] {
  if (!cmd || cmd.length !== 4) cmd = '0000';
  return [parseInt(cmd.slice(2, 4), 16), parseInt(cmd.slice(0, 2), 16)];
}
function d2dDecode(b: number[], i: number): string {
  return ('0' + (b[i + 1] & 0xff).toString(16)).slice(-2) + ('0' + (b[i] & 0xff).toString(16)).slice(-2);
}

export class MilesightWS303Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ws303';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS303'];
  readonly protocol        = 'lorawan' as const;

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
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Telemetry ─────────────────────────────────────────────────────────
      // Battery: 0x01 0x75 — same channel as WS101
      else if (ch === 0x01 && ty === 0x75) { decoded.battery = bytes[i++] & 0xff; }

      // Leakage status: 0x03 0x00 — unique to WS303
      else if (ch === 0x03 && ty === 0x00) {
        decoded.leakage_status = bytes[i++] === 1 ? 'leak' : 'normal';
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────
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
      case 0x3d: data.stop_alarming = 'yes'; offset += 1; break;

      case 0x3e: data.buzzer_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x7e:
        data.leakage_alarm_config = {
          enable:         b[offset] === 1 ? 'enable' : 'disable',
          alarm_interval: u16(b, offset + 1),
          alarm_count:    u16(b, offset + 3),
        };
        offset += 5; break;

      case 0x7f: data.find_device_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x80: data.find_device_time = u16(b, offset); offset += 2; break;

      case 0x81: {
        // byte[0] = alarm type (0x01 = leakage), byte[1] = settings bitmask
        const flags = b[offset + 1] & 0xff;
        data.lora_report_settings = {
          lora_uplink_enable: (flags >> 0) & 1 ? 'enable' : 'disable',
          d2d_uplink_enable:  (flags >> 1) & 1 ? 'enable' : 'disable',
        };
        offset += 2; break;
      }

      case 0x83: {
        const modeMap: Record<number, string> = { 0:'normal', 1:'leakage' };
        const entry = { mode: modeMap[b[offset]] ?? 'unknown', d2d_command: d2dDecode(b, offset + 1) };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(entry);
        offset += 3; break;
      }

      case 0x84: data.d2d_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':               bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status':  bytes = [0xff, 0x28, 0xff]; break;
      case 'stop_alarming':        bytes = [0xff, 0x3d, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 300)]; break;

      case 'set_buzzer_enable':
        bytes = [0xff, 0x3e, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_find_device_enable':
        bytes = [0xff, 0x7f, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_find_device_time':
        bytes = [0xff, 0x80, ...wu16(params.find_device_time ?? 60)]; break;

      case 'set_leakage_alarm_config': {
        const en       = params.enable === 'enable' ? 1 : 0;
        const interval = params.alarm_interval ?? 60;
        const count    = params.alarm_count ?? 2;
        bytes = [0xff, 0x7e, en, ...wu16(interval), ...wu16(count)]; break;
      }

      case 'set_lora_report_settings': {
        const lora = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const d2d  = params.d2d_uplink_enable  === 'enable' ? 1 : 0;
        const flags = (lora << 0) | (d2d << 1);
        bytes = [0xff, 0x81, 0x01, flags]; break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = { normal:0, leakage:1 };
        const mode = modeMap[params.mode ?? 'normal'] ?? 0;
        bytes = [0xff, 0x83, mode, ...d2dEncode(params.d2d_command ?? '0000')]; break;
      }

      default:
        throw new Error(`WS303: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS303 fingerprint: 0x01 0x75 (battery) + 0x03 0x00 (leakage status)
  // 0x01 0x75 alone also appears in WS101 — leakage channel 0x03 0x00 is the unique marker.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x03 && bytes[i + 1] === 0x00) return true;
    }
    return false;
  }
}