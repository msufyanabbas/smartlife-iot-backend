// src/modules/devices/codecs/milesight/vs340.codec.ts
// Milesight VS340 — Desk & Seat Occupancy Sensor (PIR + Thermopile)
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
//   0x03 0x00 — occupancy (1B): 0=vacant, 1=occupied
//
// Downlink responses (0xFF/0xFE prefix):
//   0x10 — reboot
//   0x28 — query_device_status
//   0x2F — led_indicator_enable
//   0x35 — d2d_key (8B hex)
//   0x84 — d2d_enable
//   0x8E — report_interval (skip byte 0, uint16 LE, minutes)
//   0x95 — vacancy_reporting_interval (uint16 LE, seconds)
//   0x96 — d2d_master_config entry (8B)
//   0x98 — pir_collect_settings (enable + uint16 count, skip 2B)
//   0x99 — thermopile_collect_settings (enable + uint16/10 sep + uint8/10 thresh_l + uint8/10 thresh_h)
//   0xB2 — thermopile_negative_threshold (int8)
//
// Downlink commands:
//   reboot, query_device_status, set_report_interval, set_led_indicator_enable,
//   set_vacancy_reporting_interval, set_pir_collect_settings,
//   set_d2d_master_config, set_d2d_enable, set_d2d_key,
//   set_thermopile_collect_settings, set_thermopile_negative_threshold

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightVS340Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-vs340';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS340'];
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

      // OCCUPANCY (0x03 0x00) — 0=vacant, 1=occupied
      else if (ch === 0x03 && ty === 0x00) {
        decoded.occupancy = bytes[i] === 1 ? 'occupied' : 'vacant'; i += 1;
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
    const u8  = (o: number) => bytes[o] & 0xff;
    const i8  = (o: number) => { const v = u8(o); return v > 0x7f ? v - 0x100 : v; };

    switch (ty) {
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x28:
        data.query_device_status = 'yes'; offset += 1; break;
      case 0x2f:
        data.led_indicator_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x35:
        data.d2d_key = bytes.slice(offset, offset + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        offset += 8; break;
      case 0x84:
        data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e:
        // skip first byte (sub-type 0x00), read uint16 LE
        data.report_interval = u16(offset + 1); offset += 3; break;
      case 0x95:
        data.vacancy_reporting_interval = u16(offset); offset += 2; break;
      case 0x96: {
        const modeMap: Record<number, string> = { 1: 'occupied', 2: 'vacant' };
        const cfg: Record<string, any> = {
          mode:               modeMap[u8(offset)] ?? 'unknown',
          enable:             bytes[offset + 1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset + 2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            ('0' + (bytes[offset + 4] & 0xff).toString(16)).slice(-2) +
                              ('0' + (bytes[offset + 3] & 0xff).toString(16)).slice(-2),
          time:               u16(offset + 5),
          time_enable:        bytes[offset + 7] === 1 ? 'enable' : 'disable',
        };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(cfg);
        offset += 8; break;
      }
      case 0x98:
        data.pir_collect_settings = {
          enable: bytes[offset] === 1 ? 'enable' : 'disable',
          count:  u16(offset + 1),
        };
        offset += 5; break; // skip 2 reserved bytes after count
      case 0x99:
        data.thermopile_collect_settings = {
          enable:      bytes[offset] === 1 ? 'enable' : 'disable',
          separate:    u16(offset + 1) / 10,
          threshold_l: u8(offset + 3) / 10,
          threshold_h: u8(offset + 4) / 10,
        };
        offset += 5; break;
      case 0xb2:
        data.thermopile_negative_threshold = i8(offset); offset += 1; break;
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
    const i8  = (v: number) => [v < 0 ? v + 0x100 : v];
    const d2dCmd = (cmd: string) => [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];
    const hexToBytes = (hex: string) => {
      const out: number[] = [];
      for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
      return out;
    };

    switch (type) {

      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'query_device_status':
        bytes = [0xff, 0x28, 0xff];
        break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        bytes = [0xff, 0x8e, 0x00, ...u16(v)];
        break;
      }

      case 'set_led_indicator_enable':
        bytes = [0xff, 0x2f, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_vacancy_reporting_interval': {
        const v = params.vacancy_reporting_interval ?? 10;
        if (v < 0 || v > 100) throw new Error('vacancy_reporting_interval must be 0–100 seconds');
        bytes = [0xff, 0x95, ...u16(v)];
        break;
      }

      case 'set_pir_collect_settings': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const count  = params.count ?? 1;
        if (count < 1 || count > 5) throw new Error('pir_collect_settings.count must be 1–5');
        // encoder: enable(1B) + count(uint16 LE) + 0x0D(uint16 LE)
        bytes = [0xff, 0x98, enable, ...u16(count), 0x0d, 0x00];
        break;
      }

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = { occupied: 1, vacant: 2 };
        const mode       = modeMap[params.mode ?? 'occupied'] ?? 1;
        const enable     = params.enable             === 'enable' ? 1 : 0;
        const loraUplink = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd        = params.d2d_cmd ?? '0000';
        const time       = params.time ?? 0;
        const timeEnable = params.time_enable === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [0xff, 0x96, mode, enable, loraUplink, ...d2dCmd(cmd), ...u16(time), timeEnable];
        break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0];
        break;

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexToBytes(key)];
        break;
      }

      case 'set_thermopile_collect_settings': {
        const enable  = params.enable === 'enable' ? 1 : 0;
        const sep     = params.separate    ?? 0;
        const threshL = params.threshold_l ?? 0;
        const threshH = params.threshold_h ?? 0;
        if (threshL < 0 || threshL > 25.5) throw new Error('threshold_l must be 0–25.5');
        if (threshH < 0 || threshH > 25.5) throw new Error('threshold_h must be 0–25.5');
        bytes = [
          0xff, 0x99,
          enable,
          ...u16(Math.round(sep * 10)),
          Math.round(threshL * 10) & 0xff,
          Math.round(threshH * 10) & 0xff,
        ];
        break;
      }

      case 'set_thermopile_negative_threshold': {
        const v = params.thermopile_negative_threshold ?? -10;
        if (v < -128 || v > -1) throw new Error('thermopile_negative_threshold must be -128 to -1');
        bytes = [0xff, 0xb2, ...i8(v)];
        break;
      }

      default:
        throw new Error(`VS340: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS340 is uniquely identified by:
  //   0x03 0x00 — occupancy (vacant/occupied)
  // Note: 0x03 0x00 is unique to VS340 — no other Milesight device uses this
  // channel+type combination.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0x03 && bytes[i + 1] === 0x00) return true;
    }
    return false;
  }
}

// ── VS341 — thin subclass (identical protocol to VS340) ───────────────────────
export class MilesightVS341Codec extends MilesightVS340Codec {
  override readonly codecId: string          = 'milesight-vs341';
  override readonly supportedModels: string[] = ['VS341'];
}