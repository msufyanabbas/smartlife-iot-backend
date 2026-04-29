// src/modules/devices/codecs/milesight/ws52x.codec.ts
// Milesight WS521 / WS523 / WS525 / WS526 — LoRaWAN Smart Portable Socket
//
// Protocol: IPSO channel_id + channel_type
//
// ── KEY DIFFERENCES FROM WS558 ────────────────────────────────────────────────
//   - Single socket (WS558 has 8 switches with bitmask)
//   - Socket channel: 0x08 0x70 (WS558 uses 0x08 0x31)
//   - Current field: 'current' in mA (WS558 uses 'total_current')
//   - Socket downlink: 0x08 <on_off(u8)> 0xFF 0xFF (4 bytes)
//   - Delay downlink:  0xFF 0x22 0x00 <u16_delay> <(0x01<<4)|on_off>
//   - child_lock_config: 0xFF 0x25 <u16: bit15=enable, bits14:0=lock_time_min>
//   - over_current_protection: 0xFF 0x30 <enable(u8)> <trip_current(u8, A)>
//   - current_alarm_config: 0xFF 0x24 <enable(u8)> <threshold(u8, A)>
//   - power_consumption_enable: 0xFF 0x26 <enable(u8)>
//   - reset_power_consumption: 0xFF 0x27 0xFF
//   - led_indicator_enable: 0xFF 0x2F <enable(u8)>
//   - report_attribute: 0xFF 0x2C 0xFF
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   Standard IPSO attributes: ipso_version, hardware_version, firmware_version,
//   tsl_version, sn (8B), lorawan_class, reset_event, device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x03 0x74 — voltage (uint16 LE /10, V)
//   0x04 0x80 — active_power (uint32 LE, W)
//   0x05 0x81 — power_factor (uint8, %)
//   0x06 0x83 — power_consumption (uint32 LE, Wh)
//   0x07 0xC9 — current (uint16 LE, mA)
//   0x08 0x70 — socket_status (bit0: 0=off, 1=on)
//
// ── Downlink commands ────────────────────────────────────────────────────────
//   0x08 <on_off> 0xFF 0xFF         — set_socket_status
//   0xFF 0x22 0x00 <u16> <data>     — set_socket_status_with_delay
//   0xFF 0x23 <task_id> 0xFF        — cancel_delay_task
//   0xFF 0x10 0xFF                  — reboot
//   0xFF 0x28 0xFF                  — report_status
//   0xFF 0x2C 0xFF                  — report_attribute
//   0xFF 0x03 <u16>                 — set_report_interval (seconds)
//   0xFF 0x30 <enable> <trip_current> — set_over_current_protection
//   0xFF 0x24 <enable> <threshold>  — set_current_alarm_config
//   0xFF 0x25 <u16>                 — set_child_lock_config (bit15=enable, bits14:0=lock_time_min)
//   0xFF 0x26 <enable>              — set_power_consumption_enable
//   0xFF 0x27 0xFF                  — reset_power_consumption
//   0xFF 0x2F <enable>              — set_led_indicator_enable
//
// ── canDecode fingerprint ─────────────────────────────────────────────────────
//   0x08 0x70 — socket_status (WS52x-exclusive, WS558 uses 0x08 0x31)

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

export class MilesightWS52xCodec extends BaseDeviceCodec {
  readonly codecId: string       = 'milesight-ws52x';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS521', 'WS523', 'WS525', 'WS526'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ───────────────────────────────────────────────────────────
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

      // ── Telemetry ─────────────────────────────────────────────────────────────

      // VOLTAGE (uint16 LE /10, V)
      else if (ch === 0x03 && ty === 0x74) {
        decoded.voltage = u16(bytes, i) / 10; i += 2;
      }
      // ACTIVE POWER (uint32 LE, W)
      else if (ch === 0x04 && ty === 0x80) {
        decoded.active_power = u32(bytes, i); i += 4;
      }
      // POWER FACTOR (uint8, %)
      else if (ch === 0x05 && ty === 0x81) {
        decoded.power_factor = bytes[i++] & 0xff;
      }
      // POWER CONSUMPTION (uint32 LE, Wh)
      else if (ch === 0x06 && ty === 0x83) {
        decoded.power_consumption = u32(bytes, i); i += 4;
      }
      // CURRENT (uint16 LE, mA)
      else if (ch === 0x07 && ty === 0xc9) {
        decoded.current = u16(bytes, i); i += 2;
      }
      // SOCKET STATUS (bit0: 0=off, 1=on)
      else if (ch === 0x08 && ty === 0x70) {
        decoded.socket_status = (bytes[i++] & 0x01) ? 'on' : 'off';
      }

      // ── Downlink responses (0xFF / 0xFE channel) ──────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
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
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2c: data.report_attribute = 'yes'; offset += 1; break;

      case 0x22:
        // skip first byte (task_id / reserved)
        data.delay_time    = u16(b, offset + 1);
        data.socket_status = (b[offset + 3] & 0x0f) ? 'on' : 'off';
        offset += 4; break;

      case 0x23:
        data.cancel_delay_task = b[offset] & 0xff;
        offset += 2; // skip reserved byte
        break;

      case 0x24:
        data.current_alarm_config = {
          enable:    b[offset] === 1 ? 'enable' : 'disable',
          threshold: b[offset + 1] & 0xff,
        }; offset += 2; break;

      case 0x25: {
        const raw = u16(b, offset);
        data.child_lock_config = {
          enable:    (raw >>> 15) & 0x01 ? 'enable' : 'disable',
          lock_time: raw & 0x7fff,
        }; offset += 2; break;
      }

      case 0x26: data.power_consumption_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x27: data.reset_power_consumption = 'yes'; offset += 1; break;
      case 0x2f: data.led_indicator_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0x30:
        data.over_current_protection = {
          enable:       b[offset] === 1 ? 'enable' : 'disable',
          trip_current: b[offset + 1] & 0xff,
        }; offset += 2; break;

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':            bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':     bytes = [0xff, 0x28, 0xff]; break;
      case 'report_attribute':  bytes = [0xff, 0x2c, 0xff]; break;
      case 'reset_power_consumption': bytes = [0xff, 0x27, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;

      // set_socket_status: 0x08 <on_off> 0xFF 0xFF
      case 'set_socket_status': {
        const on = params.socket_status === 'on' || params.socket_status === 1 ? 1 : 0;
        bytes = [0x08, on, 0xff, 0xff]; break;
      }

      // set_socket_status_with_delay: 0xFF 0x22 0x00 <u16_delay> <(0x01<<4)|on_off>
      case 'set_socket_status_with_delay': {
        const on       = params.socket_status === 'on' || params.socket_status === 1 ? 1 : 0;
        const delay    = params.delay_time ?? 0;
        const dataByte = (0x01 << 4) | on;
        bytes = [0xff, 0x22, 0x00, ...wu16(delay), dataByte]; break;
      }

      case 'cancel_delay_task':
        bytes = [0xff, 0x23, params.task_id ?? 0, 0xff]; break;

      case 'set_over_current_protection': {
        const p = params;
        bytes = [0xff, 0x30, p.enable === 'enable' ? 1 : 0, p.trip_current ?? 0]; break;
      }

      case 'set_current_alarm_config': {
        const p = params;
        bytes = [0xff, 0x24, p.enable === 'enable' ? 1 : 0, p.threshold ?? 0]; break;
      }

      case 'set_child_lock_config': {
        const p = params;
        const enableBit = p.enable === 'enable' ? 1 : 0;
        const lockTime  = p.lock_time ?? 0;
        const raw = ((enableBit & 0x01) << 15) | (lockTime & 0x7fff);
        bytes = [0xff, 0x25, ...wu16(raw)]; break;
      }

      case 'set_power_consumption_enable':
        bytes = [0xff, 0x26, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_led_indicator_enable':
        bytes = [0xff, 0x2f, params.enable === 'enable' ? 1 : 0]; break;

      default:
        throw new Error(`WS52x: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS52x uniquely identified by:
  //   0x08 0x70 — socket_status (WS52x-exclusive; WS558 uses 0x08 0x31)
  //   0x07 0xC9 — current in mA (also present in WS558 but named total_current there)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x08 && ty === 0x70) return true; // socket_status — unambiguous
    }
    return false;
  }
}