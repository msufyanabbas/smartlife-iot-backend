// src/modules/devices/codecs/milesight/ws503.codec.ts
// Milesight WS501 / WS502 / WS503 — LoRaWAN Smart Wall Switch (1/2/3 gang)
//
// Protocol: IPSO channel_id + channel_type
//
// ── FUNDAMENTALLY DIFFERENT FROM WS51x / WS52x ───────────────────────────────
//   - Wall switch (no power metering, no socket)
//   - Up to 3 gang switches (WS501=1, WS502=2, WS503=3)
//   - Switch status: 0xFF 0x29 — single packed byte
//     bits[2:0] = switch_1/2/3 state, bits[6:4] = switch_1/2/3 change flags
//   - SN uses type 0x08 with 6 bytes (not 0x16 with 8 bytes)
//   - LED mode (0=off, 1=on_inverted, 2=on_synced) — not a simple enable/disable
//   - No power metering channels whatsoever
//   - Function key event: 0xFF 0x2B (1B)
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x08 — sn (6B hex) ← note: 0x08 not 0x16, 6B not 8B
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0xFF 0x29 — switch status (1B packed):
//     bit0=switch_1, bit1=switch_2, bit2=switch_3 (0=off, 1=on)
//     bit4=switch_1_change, bit5=switch_2_change, bit6=switch_3_change
//   0xFF 0x2B — function_key_event (always 'yes' on trigger)
//
// ── Downlink commands ────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF                     — reboot
//   0xFF 0x28 0xFF                     — report_status
//   0xFF 0x2C 0xFF                     — report_attribute
//   0xFF 0x03 <u16>                    — set_report_interval (seconds, 60-64800)
//   0xFF 0x29 <data_byte>              — set_switch (packed: bits[6:4]=mask, bits[2:0]=state)
//   0xFF 0x22 <frame_count> <u16> <data> — set_delay_task
//   0xFF 0x23 <frame_count> 0xFF       — cancel_delay_task
//   0xFF 0x2F <mode>                   — set_led_mode (0=off,1=on_inverted,2=on_synced)
//   0xFF 0x25 <u16>                    — set_child_lock_config (bit15=enable, bits14:0=lock_time_min)
//
// ── canDecode fingerprint ────────────────────────────────────────────────────
//   0xFF 0x29 — switch status (WS50x-exclusive)
//   0xFF 0x2B — function key event (WS50x-exclusive)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

const LED_MODE: Record<number, string>  = { 0:'off', 1:'on_inverted', 2:'on_synced' };
const LED_MODE_INV: Record<string, number> = Object.fromEntries(Object.entries(LED_MODE).map(([k, v]) => [v, +k]));

const SWITCH_BITS: Record<string, number> = { switch_1: 0, switch_2: 1, switch_3: 2 };

export class MilesightWS503Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws503';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS501', 'WS502', 'WS503'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS503',
    description:  'Smart Wall Switch (1–3 gang) — switch control, child lock, delay tasks',
    telemetryKeys: [
      { key: 'switch_1', label: 'Switch 1', type: 'string' as const, enum: ['on', 'off'] },
      { key: 'switch_2', label: 'Switch 2', type: 'string' as const, enum: ['on', 'off'] },
      { key: 'switch_3', label: 'Switch 3', type: 'string' as const, enum: ['on', 'off'] },
    ],
    commands: [
      { type: 'reboot',           label: 'Reboot Device',    params: [] },
      { type: 'report_status',    label: 'Report Status',    params: [] },
      { type: 'report_attribute', label: 'Report Attribute', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 1200, min: 60 }],
      },
      {
        type:   'set_switch',
        label:  'Set Switch',
        params: [
          { key: 'switch_1', label: 'Switch 1', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
          { key: 'switch_2', label: 'Switch 2', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
          { key: 'switch_3', label: 'Switch 3', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
        ],
      },
      {
        type:   'set_led_mode',
        label:  'Set LED Mode',
        params: [{ key: 'led_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Off', value: 'off' }, { label: 'On Inverted', value: 'on_inverted' }, { label: 'On Synced', value: 'on_synced' }] }],
      },
      {
        type:   'set_child_lock_config',
        label:  'Set Child Lock',
        params: [
          { key: 'enable',    label: 'Enable',             type: 'boolean' as const, required: true  },
          { key: 'lock_time', label: 'Lock Time (minutes)', type: 'number' as const, required: false, default: 0 },
        ],
      },
    ],
    uiComponents: [
      { type: 'toggle' as const, label: 'Switch 1', keys: ['switch_1'], command: 'set_switch' },
      { type: 'toggle' as const, label: 'Switch 2', keys: ['switch_2'], command: 'set_switch' },
      { type: 'toggle' as const, label: 'Switch 3', keys: ['switch_3'], command: 'set_switch' },
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

      // SN: 0xFF 0x08 — 6 bytes (WS50x uses 0x08, not 0x16 like other WS models)
      else if (ch === 0xff && ty === 0x08) {
        decoded.sn = bytes.slice(i, i + 6).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 6;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── SWITCH STATUS (0xFF 0x29) ─────────────────────────────────────────────
      // Packed byte: bits[2:0] = switch states, bits[6:4] = change flags
      else if (ch === 0xff && ty === 0x29) {
        const d = bytes[i++];
        decoded.switch_1        = (d >> 0) & 1 ? 'on' : 'off';
        decoded.switch_1_change = (d >> 4) & 1 ? 'yes' : 'no';
        decoded.switch_2        = (d >> 1) & 1 ? 'on' : 'off';
        decoded.switch_2_change = (d >> 5) & 1 ? 'yes' : 'no';
        decoded.switch_3        = (d >> 2) & 1 ? 'on' : 'off';
        decoded.switch_3_change = (d >> 6) & 1 ? 'yes' : 'no';
      }

      // ── FUNCTION KEY EVENT (0xFF 0x2B) ────────────────────────────────────────
      else if (ch === 0xff && ty === 0x2b) {
        decoded.function_key_event = 'yes'; i += 1;
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

      case 0x29: {
        const d = b[offset++] & 0xff;
        for (const [key, bit] of Object.entries(SWITCH_BITS)) {
          if ((d >> (bit + 4)) & 0x01) {
            data[key] = (d >> bit) & 0x01 ? 'on' : 'off';
          }
        }
        break;
      }

      case 0x22: {
        const frameCount = b[offset] & 0xff;
        const delayTime  = u16(b, offset + 1);
        const dataByte   = b[offset + 3] & 0xff;
        const task: Record<string, any> = { frame_count: frameCount, delay_time: delayTime };
        for (const [key, bit] of Object.entries(SWITCH_BITS)) {
          if ((dataByte >> (bit + 4)) & 0x01) task[key] = (dataByte >> bit) & 0x01 ? 'on' : 'off';
        }
        data.delay_task = task; offset += 4; break;
      }

      case 0x23: data.cancel_delay_task = b[offset] & 0xff; offset += 2; break;

      case 0x25: {
        const raw = u16(b, offset);
        data.child_lock_config = {
          enable:    (raw >>> 15) & 0x01 ? 'enable' : 'disable',
          lock_time: raw & 0x7fff,
        }; offset += 2; break;
      }

      case 0x2f: data.led_mode = LED_MODE[b[offset++]] ?? 'unknown'; break;

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':           bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':    bytes = [0xff, 0x28, 0xff]; break;
      case 'report_attribute': bytes = [0xff, 0x2c, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 1200)]; break;

      // set_switch: params may contain switch_1/2/3 with 'on'/'off'
      // Packed: bits[6:4]=mask, bits[2:0]=state
      case 'set_switch': {
        let data = 0;
        for (const [key, bit] of Object.entries(SWITCH_BITS)) {
          if (key in params) {
            data |= 1 << (bit + 4);
            if (params[key] === 'on' || params[key] === 1) data |= 1 << bit;
          }
        }
        bytes = [0xff, 0x29, data & 0xff]; break;
      }

      // set_delay_task: { frame_count, delay_time, switch_1?, switch_2?, switch_3? }
      case 'set_delay_task': {
        const p = params.delay_task ?? params;
        const frameCount = p.frame_count ?? 0;
        const delayTime  = p.delay_time ?? 0;
        let dataByte = 0;
        for (const [key, bit] of Object.entries(SWITCH_BITS)) {
          if (key in p) {
            dataByte |= 1 << (bit + 4);
            if (p[key] === 'on' || p[key] === 1) dataByte |= 1 << bit;
          }
        }
        bytes = [0xff, 0x22, frameCount & 0xff, ...wu16(delayTime), dataByte & 0xff]; break;
      }

      case 'cancel_delay_task':
        bytes = [0xff, 0x23, (params.cancel_delay_task ?? 0) & 0xff, 0xff]; break;

      case 'set_led_mode': {
        const mode = typeof params.led_mode === 'string'
          ? (LED_MODE_INV[params.led_mode] ?? 0)
          : (params.led_mode ?? 0);
        bytes = [0xff, 0x2f, mode & 0xff]; break;
      }

      case 'set_child_lock_config': {
        const enableBit = params.enable === 'enable' ? 1 : 0;
        const lockTime  = params.lock_time ?? 0;
        const raw = ((enableBit & 0x01) << 15) | (lockTime & 0x7fff);
        bytes = [0xff, 0x25, ...wu16(raw)]; break;
      }

      default:
        throw new Error(`WS503: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS50x identified by:
  //   0xFF 0x29 — switch status with packed change flags (WS50x-exclusive)
  //   0xFF 0x2B — function key event (WS50x-exclusive)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0xff && ty === 0x29) return true; // switch status — WS50x exclusive
      if (ch === 0xff && ty === 0x2b) return true; // function key event
    }
    return false;
  }
}