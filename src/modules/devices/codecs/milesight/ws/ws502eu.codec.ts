// src/modules/devices/codecs/milesight/ws502eu.codec.ts
// Milesight WS502_EU — LoRaWAN Smart Wall Switch (EU 868 MHz band, 2-gang, with power metering)
//
// ── HYBRID PROTOCOL ──────────────────────────────────────────────────────────
//   WS502_EU combines:
//   - CN-style switch channel (0x08 0x29, individual switch downlink)
//   - WS52x-style power metering (voltage/10, active_power, power_factor, etc.)
//
// ── COMPARISON WITH RELATED MODELS ───────────────────────────────────────────
//   vs WS503/WS502 (original): different switch channel (0x08 0x29 not 0xFF 0x29)
//   vs WS503_CN:               adds power metering; no rule_config/timezone/sync_time
//   vs WS52x (WS521/523/525):  different switch channel (0x08 0x29 not 0x08 0x70)
//                               individual switch downlink, not socket on/off
//   vs WS51x:                  no temperature; different switch channel
//
// ── Protocol key points ───────────────────────────────────────────────────────
//   - Switch uplink: 0x08 0x29 — 2 switches, same packed byte as WS503_CN
//   - Switch downlink: 0x08 <data> 0xFF — individual, same as WS503_CN
//   - cancel_delay_task trailing byte: 0x00 (like WS503_CN, not 0xFF)
//   - clear_power_consumption: 0xFF 0x27 0xFF (NOT 0x01 like WS503v4!)
//   - power_consumption_enable: 0xFF 0x26 <enable>
//   - SN: 0xFF 0x16, 8 bytes
//   - Voltage: uint16/10, V (standard divisor unlike WS503v4 which has no /10)
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (8B, 0xFF 0x16), lorawan_class, reset_event, device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x03 0x74 — voltage (uint16 LE /10, V)
//   0x04 0x80 — active_power (uint32 LE, W)
//   0x05 0x81 — power_factor (uint8, %)
//   0x06 0x83 — power_consumption (uint32 LE, Wh)
//   0x07 0xC9 — current (uint16 LE, mA)
//   0x08 0x29 — switch_1/2 status + change flags (same packed byte as WS503_CN)
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0x08 <data> 0xFF                 — set_switch (individual, same as WS503_CN)
//   0xFF 0x22 <frame_count> <u16> <data> — set_delay_task (switches 1+2)
//   0xFF 0x23 <frame_count> 0x00     — cancel_delay_task (0x00 trailing!)
//   0xFF 0x10 0xFF                   — reboot
//   0xFF 0x28 0xFF                   — report_status
//   0xFF 0x2C 0xFF                   — report_attribute
//   0xFF 0x03 <u16>                  — set_report_interval (seconds)
//   0xFF 0x2F <mode>                 — set_led_mode (0=off,1=on_inverted,2=on_synced)
//   0xFF 0x5E <enable>               — set_reset_button_enable
//   0xFF 0x25 <u16>                  — set_child_lock_config (bit15=enable, bits14:0=lock_time)
//   0xFF 0x26 <enable>               — set_power_consumption_enable
//   0xFF 0x27 0xFF                   — clear_power_consumption (0xFF trailing, not 0x01!)
//
// ── canDecode fingerprint ─────────────────────────────────────────────────────
//   0x08 0x29 + power metering channels (0x03/0x04/0x05/0x06/0x07) = WS502_EU
//   (0x08 0x29 alone = WS503_CN family; adding power metering = WS502_EU)
//   WS502_EU must be listed BEFORE WS503_CN in ALL_CODECS.

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }

export class MilesightWS502EUCodec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws502-eu';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS502-EU'];
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

      // ── Power metering (standard WS52x-style, voltage /10) ────────────────────
      else if (ch === 0x03 && ty === 0x74) { decoded.voltage          = u16(bytes, i) / 10; i += 2; }
      else if (ch === 0x04 && ty === 0x80) { decoded.active_power     = u32(bytes, i); i += 4; }
      else if (ch === 0x05 && ty === 0x81) { decoded.power_factor     = bytes[i++] & 0xff; }
      else if (ch === 0x06 && ty === 0x83) { decoded.power_consumption = u32(bytes, i); i += 4; }
      else if (ch === 0x07 && ty === 0xc9) { decoded.current          = u16(bytes, i); i += 2; }

      // ── SWITCH STATUS (0x08 0x29) ─────────────────────────────────────────────
      // Same packed byte as WS503_CN — bits[1:0]=switch states, bits[5:4]=change flags
      else if (ch === 0x08 && ty === 0x29) {
        const d = bytes[i++];
        decoded.switch_1        = (d >> 0) & 1 ? 'on' : 'off';
        decoded.switch_1_change = (d >> 4) & 1 ? 'yes' : 'no';
        decoded.switch_2        = (d >> 1) & 1 ? 'on' : 'off';
        decoded.switch_2_change = (d >> 5) & 1 ? 'yes' : 'no';
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────────
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
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2c: data.report_attribute = 'yes'; offset += 1; break;

      case 0x22: {
        const frameCount = b[offset] & 0xff;
        const delayTime  = u16(b, offset + 1);
        const d = b[offset + 3] & 0xff;
        const task: Record<string, any> = { frame_count: frameCount, delay_time: delayTime };
        if ((d >> 4) & 1) task.switch_1 = (d >> 0) & 1 ? 'on' : 'off';
        if ((d >> 5) & 1) task.switch_2 = (d >> 1) & 1 ? 'on' : 'off';
        data.delay_task = task; offset += 4; break;
      }

      case 0x23: data.cancel_delay_task = b[offset] & 0xff; offset += 2; break;

      case 0x25: {
        const raw = u16(b, offset);
        data.child_lock_config = { enable: (raw >>> 15) & 1 ? 'enable' : 'disable', lock_time: raw & 0x7fff };
        offset += 2; break;
      }

      case 0x26: data.power_consumption_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x27: data.clear_power_consumption  = 'yes'; offset += 1; break;

      case 0x2f: {
        const ledMap: Record<number, string> = { 0:'off', 1:'on_inverted', 2:'on_synced' };
        data.led_mode = ledMap[b[offset]] ?? 'unknown'; offset += 1; break;
      }

      case 0x5e: data.reset_button_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;

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
      // clear_power_consumption uses 0xFF trailing (not 0x01 like WS503v4)
      case 'clear_power_consumption': bytes = [0xff, 0x27, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 1200)]; break;

      // Individual switch: 0x08 <data> 0xFF
      // data = (mask<<4) | ctrl, mask = 1<<(id-1), ctrl = on_off<<(id-1)
      case 'set_switch': {
        const id  = params.switch_id ?? 1; // 1 or 2
        const on  = params.state === 'on' || params.state === 1 ? 1 : 0;
        const mask = 0x01 << (id - 1);
        const ctrl = on << (id - 1);
        const data = ((mask & 0x03) << 4) | (ctrl & 0x03);
        bytes = [0x08, data & 0xff, 0xff]; break;
      }

      case 'set_delay_task': {
        const p = params.delay_task ?? params;
        const frameCount = p.frame_count ?? 0;
        const delayTime  = p.delay_time ?? 0;
        let data = 0;
        if ('switch_1' in p) { data |= 1 << 4; if (p.switch_1 === 'on' || p.switch_1 === 1) data |= 1 << 0; }
        if ('switch_2' in p) { data |= 1 << 5; if (p.switch_2 === 'on' || p.switch_2 === 1) data |= 1 << 1; }
        bytes = [0xff, 0x22, frameCount & 0xff, ...wu16(delayTime), data & 0xff]; break;
      }

      // cancel_delay_task trailing byte is 0x00 (same as WS503_CN)
      case 'cancel_delay_task':
        bytes = [0xff, 0x23, (params.cancel_delay_task ?? 0) & 0xff, 0x00]; break;

      case 'set_led_mode': {
        const modeMap: Record<string, number> = { off:0, on_inverted:1, on_synced:2 };
        bytes = [0xff, 0x2f, modeMap[params.led_mode ?? 'off'] ?? 0]; break;
      }

      case 'set_reset_button_enable':
        bytes = [0xff, 0x5e, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_child_lock_config': {
        const en  = params.enable === 'enable' ? 1 : 0;
        const raw = ((en & 1) << 15) | ((params.lock_time ?? 0) & 0x7fff);
        bytes = [0xff, 0x25, ...wu16(raw)]; break;
      }

      case 'set_power_consumption_enable':
        bytes = [0xff, 0x26, params.enable === 'enable' ? 1 : 0]; break;

      default:
        throw new Error(`WS502EU: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS502_EU has BOTH:
  //   0x08 0x29 — CN-style switch channel
  //   power metering channels (0x03/0x04/0x05/0x06/0x07)
  // WS503_CN has 0x08 0x29 but NO power metering.
  // WS502_EU must be registered BEFORE WS503_CN in ALL_CODECS.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasSwitch = false;
    let hasPower  = false;
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x08 && ty === 0x29) hasSwitch = true;
      if ((ch === 0x03 && ty === 0x74) || (ch === 0x04 && ty === 0x80) ||
          (ch === 0x07 && ty === 0xc9) || (ch === 0x06 && ty === 0x83)) hasPower = true;
      if (hasSwitch && hasPower) return true;
    }
    return false;
  }
}