// src/modules/devices/codecs/milesight/ws51x.codec.ts
// Milesight WS515 / WS516 / WS517 — LoRaWAN Smart Wall Socket
//
// Protocol: IPSO channel_id + channel_type
//
// ── KEY DIFFERENCES FROM WS52x ────────────────────────────────────────────────
//   - Wall socket form factor (WS52x is portable plug)
//   - Adds temperature sensor: 0x09 0x67 (with sentinels 0xFFFD/0xFFFF)
//   - Adds temperature threshold alarm: 0x89 0x67 (v2.1+)
//   - Adds temperature mutation alarm: 0x99 0x67 (v1.9, deprecated v2.1)
//   - Socket downlink: 0x08 <on_off> 0xFF — only 3 bytes (WS52x uses 4)
//   - Delay downlink: 0xFF 0x22 <frame_count> <u16_delay> <data_byte>
//     (WS52x has 0x00 as first byte, WS51x uses frame_count 0-255)
//   - led_indicator_enable: 0xFF 0x2F <u16> (WS52x uses u8)
//   - Adds led_indicator_reserve: 0xFF 0xA5 <enable>
//   - Adds overload_current_protection: 0xFF 0x8D <enable> (v2.1+)
//   - Adds temperature_calibration_settings: 0xFF 0xAB <enable> <i16×10> (v1.9+)
//   - Adds temperature_alarm_config: 0xFF 0x06 <data> <i16×10 min> <i16×10 max> <u16 interval> <u16 times>
//     data byte: (alarm_type=1 << 3) | condition
//   - Adds d2d_command: 0xFF 0x34 0x00 <2B command>
//   - temperature_alarm values: threshold_alarm_release/threshold_alarm/overheat_alarm/mutation_alarm
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   Standard: ipso_version, hardware_version, firmware_version, tsl_version,
//   sn (8B), lorawan_class, reset_event, device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x03 0x74 — voltage (uint16 LE /10, V)
//   0x04 0x80 — active_power (uint32 LE, W)
//   0x05 0x81 — power_factor (uint8, %)
//   0x06 0x83 — power_consumption (uint32 LE, Wh)
//   0x07 0xC9 — current (uint16 LE, mA)
//   0x08 0x70 — socket_status (bit0: 0=off, 1=on)
//   0x09 0x67 — temperature (int16 LE /10, °C) + sentinels 0xFFFD/0xFFFF
//   0x89 0x67 — temperature + temperature_alarm (int16/10 + 1B)  [v2.1+]
//   0x99 0x67 — temperature + temperature_mutation + temperature_alarm (int16/10 × 2 + 1B) [v1.9, deprecated]
//
// ── Downlink commands ────────────────────────────────────────────────────────
//   0x08 <on_off> 0xFF              — set_socket_status (3 bytes)
//   0xFF 0x22 <frame_count> <u16> <data> — set_delay_task
//   0xFF 0x23 <task_id> 0xFF        — cancel_delay_task
//   0xFF 0x10 0xFF                  — reboot
//   0xFF 0x28 0xFF                  — report_status
//   0xFF 0x03 <u16>                 — set_report_interval (seconds)
//   0xFF 0x24 <enable> <threshold>  — set_current_alarm_config
//   0xFF 0x30 <enable> <trip_current> — set_over_current_protection
//   0xFF 0x8D <enable>              — set_overload_current_protection
//   0xFF 0x25 <u16>                 — set_child_lock_config
//   0xFF 0x26 <enable>              — set_power_consumption_enable
//   0xFF 0x27 0xFF                  — reset_power_consumption
//   0xFF 0x2F <u16>                 — set_led_indicator_enable (uint16!)
//   0xFF 0xA5 <enable>              — set_led_indicator_reserve
//   0xFF 0xAB <enable> <i16×10>     — set_temperature_calibration
//   0xFF 0x06 <data> <i16×10> <i16×10> <u16> <u16> — set_temperature_alarm_config
//   0xFF 0x34 0x00 <2B>             — set_d2d_command

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

const CONDITION_MAP: Record<number, string> = { 0:'disable', 1:'below', 2:'above', 3:'between', 4:'outside' };
const CONDITION_INV: Record<string, number> = Object.fromEntries(Object.entries(CONDITION_MAP).map(([k, v]) => [v, +k]));

const TEMP_ALARM_MAP: Record<number, string> = {
  0: 'threshold alarm release',
  1: 'threshold alarm',
  2: 'overheat alarm',
  3: 'mutation alarm',
};
const SENSOR_STATUS: Record<number, string> = { 0:'normal', 1:'over range alarm', 2:'read failed' };

export class MilesightWS51xCodec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws51x';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS515', 'WS516', 'WS517'];
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
      else if (ch === 0x03 && ty === 0x74) { decoded.voltage = u16(bytes, i) / 10; i += 2; }

      // ACTIVE POWER (uint32 LE, W)
      else if (ch === 0x04 && ty === 0x80) { decoded.active_power = u32(bytes, i); i += 4; }

      // POWER FACTOR (uint8, %)
      else if (ch === 0x05 && ty === 0x81) { decoded.power_factor = bytes[i++] & 0xff; }

      // POWER CONSUMPTION (uint32 LE, Wh)
      else if (ch === 0x06 && ty === 0x83) { decoded.power_consumption = u32(bytes, i); i += 4; }

      // CURRENT (uint16 LE, mA)
      else if (ch === 0x07 && ty === 0xc9) { decoded.current = u16(bytes, i); i += 2; }

      // SOCKET STATUS (bit0: 0=off, 1=on)
      else if (ch === 0x08 && ty === 0x70) { decoded.socket_status = bytes[i++] & 0x01 ? 'on' : 'off'; }

      // TEMPERATURE — normal (int16/10) or sensor error sentinel
      else if (ch === 0x09 && ty === 0x67) {
        const raw = u16(bytes, i); i += 2;
        if (raw === 0xfffd) {
          decoded.temperature_sensor_status = SENSOR_STATUS[1];
        } else if (raw === 0xffff) {
          decoded.temperature_sensor_status = SENSOR_STATUS[2];
        } else {
          decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        }
      }

      // TEMPERATURE THRESHOLD ALARM (v2.1+): int16/10 + alarm_byte
      else if (ch === 0x89 && ty === 0x67) {
        decoded.temperature       = i16(bytes, i) / 10;
        decoded.temperature_alarm = TEMP_ALARM_MAP[bytes[i + 2]] ?? 'unknown';
        i += 3;
      }

      // TEMPERATURE MUTATION ALARM (v1.9, deprecated v2.1): int16/10 × 2 + alarm_byte
      else if (ch === 0x99 && ty === 0x67) {
        decoded.temperature          = i16(bytes, i) / 10;
        decoded.temperature_mutation = i16(bytes, i + 2) / 10;
        decoded.temperature_alarm    = TEMP_ALARM_MAP[3]; // always 'mutation alarm'
        i += 5;
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

      case 0x06: {
        // Temperature alarm config response
        const d = b[offset] & 0xff;
        data.temperature_alarm_config = {
          condition:      CONDITION_MAP[d & 0x07] ?? 'unknown',
          threshold_min:  i16(b, offset + 1) / 10,
          threshold_max:  i16(b, offset + 3) / 10,
          alarm_interval: u16(b, offset + 5),
          alarm_times:    u16(b, offset + 7),
        }; offset += 9; break;
      }

      case 0x22: {
        const frameCount = b[offset] & 0xff;
        const delayTime  = u16(b, offset + 1);
        const dataByte   = b[offset + 3] & 0xff;
        const task: Record<string, any> = { frame_count: frameCount, delay_time: delayTime };
        // bit4=socket mask, bit0=socket state
        if ((dataByte >> 4) & 0x01) task.socket_status = dataByte & 0x01 ? 'on' : 'off';
        data.delay_task = task;
        offset += 4; break;
      }

      case 0x23: data.cancel_delay_task = b[offset] & 0xff; offset += 2; break;

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
      case 0x27: data.reset_power_consumption  = 'yes'; offset += 1; break;

      case 0x2f:
        // led_indicator_enable is u16 in WS51x (u8 in WS52x)
        data.led_indicator_enable = u16(b, offset) === 1 ? 'enable' : 'disable';
        offset += 2; break;

      case 0x30:
        data.over_current_protection = {
          enable:       b[offset] === 1 ? 'enable' : 'disable',
          trip_current: b[offset + 1] & 0xff,
        }; offset += 2; break;

      case 0x34:
        // skip first byte (0x00), then 2-byte D2D command (byte-swapped hex string)
        data.d2d_command =
          ('0' + (b[offset + 2] & 0xff).toString(16)).slice(-2) +
          ('0' + (b[offset + 1] & 0xff).toString(16)).slice(-2);
        offset += 3; break;

      case 0x8d:
        data.overload_current_protection = {
          enable: b[offset] === 1 ? 'enable' : 'disable',
        }; offset += 1; break;

      case 0xa5: data.led_indicator_reserve = b[offset++] === 1 ? 'enable' : 'disable'; break;

      case 0xab:
        data.temperature_calibration_settings = {
          enable:            b[offset] === 1 ? 'enable' : 'disable',
          calibration_value: i16(b, offset + 1) / 10,
        }; offset += 3; break;

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':                    bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':             bytes = [0xff, 0x28, 0xff]; break;
      case 'reset_power_consumption':   bytes = [0xff, 0x27, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;

      // set_socket_status: 0x08 <on_off> 0xFF — 3 bytes (WS51x specific)
      case 'set_socket_status': {
        const on = params.socket_status === 'on' || params.socket_status === 1 ? 1 : 0;
        bytes = [0x08, on, 0xff]; break;
      }

      // set_delay_task: 0xFF 0x22 <frame_count> <u16_delay> <data_byte>
      // data_byte: (socket_mask << 4) | socket_state
      case 'set_delay_task': {
        const p = params.delay_task ?? params;
        const frameCount = p.frame_count ?? 0;
        const delayTime  = p.delay_time ?? 0;
        let dataByte = 0;
        if ('socket_status' in p) {
          dataByte |= 1 << 4;
          if (p.socket_status === 'on' || p.socket_status === 1) dataByte |= 1;
        }
        bytes = [0xff, 0x22, frameCount & 0xff, ...wu16(delayTime), dataByte & 0xff]; break;
      }

      case 'cancel_delay_task':
        bytes = [0xff, 0x23, params.cancel_delay_task ?? 0, 0xff]; break;

      case 'set_current_alarm_config': {
        const p = params;
        bytes = [0xff, 0x24, p.enable === 'enable' ? 1 : 0, p.threshold ?? 0]; break;
      }

      case 'set_over_current_protection': {
        const p = params;
        bytes = [0xff, 0x30, p.enable === 'enable' ? 1 : 0, p.trip_current ?? 0]; break;
      }

      case 'set_overload_current_protection':
        bytes = [0xff, 0x8d, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_child_lock_config': {
        const p = params;
        const enableBit = p.enable === 'enable' ? 1 : 0;
        const lockTime  = p.lock_time ?? 0;
        const raw = ((enableBit & 0x01) << 15) | (lockTime & 0x7fff);
        bytes = [0xff, 0x25, ...wu16(raw)]; break;
      }

      case 'set_power_consumption_enable':
        bytes = [0xff, 0x26, params.enable === 'enable' ? 1 : 0]; break;

      // led_indicator_enable encodes as uint16 in WS51x
      case 'set_led_indicator_enable':
        bytes = [0xff, 0x2f, ...wu16(params.enable === 'enable' ? 1 : 0)]; break;

      case 'set_led_indicator_reserve':
        bytes = [0xff, 0xa5, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_temperature_calibration': {
        const p = params;
        bytes = [
          0xff, 0xab, p.enable === 'enable' ? 1 : 0,
          ...wi16(Math.round((p.calibration_value ?? 0) * 10)),
        ]; break;
      }

      case 'set_temperature_alarm_config': {
        const p = params;
        const condVal  = CONDITION_INV[p.condition ?? 'disable'] ?? 0;
        const dataByte = (1 << 3) | condVal; // alarm_type=1
        bytes = [
          0xff, 0x06, dataByte,
          ...wi16(Math.round((p.threshold_min ?? 0) * 10)),
          ...wi16(Math.round((p.threshold_max ?? 0) * 10)),
          ...wu16(p.alarm_interval ?? 0),
          ...wu16(p.alarm_times ?? 0),
        ]; break;
      }

      case 'set_d2d_command': {
        // d2d_command is a 4-char hex string e.g. "0000"
        const cmd = params.d2d_command ?? '0000';
        if (cmd.length !== 4) throw new Error('d2d_command must be a 4-char hex string');
        // Encoded byte-swapped: bytes [1]=cmd[0..1], bytes [0]=cmd[2..3]
        bytes = [
          0xff, 0x34, 0x00,
          parseInt(cmd.substring(2, 4), 16),
          parseInt(cmd.substring(0, 2), 16),
        ]; break;
      }

      default:
        throw new Error(`WS51x: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS51x shares 0x08 0x70 socket channel with WS52x.
  // Distinguished by temperature channels unique to WS51x:
  //   0x09 0x67 — temperature (also used by CT/TS sensors but in a different protocol)
  //   0x89 0x67 — temperature alarm (WS51x-exclusive in the WS family)
  //   0x99 0x67 — temperature mutation alarm (WS51x-exclusive)
  // In practice, canDecode should be called with metadata to resolve WS51x vs WS52x
  // when only power metering channels are present. We fingerprint on temperature.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasSocket = false;
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x89 && ty === 0x67) return true; // temp alarm — WS51x exclusive in WS family
      if (ch === 0x99 && ty === 0x67) return true; // temp mutation — WS51x exclusive
      if (ch === 0x09 && ty === 0x67) return true; // temperature present — WS51x has it, WS52x doesn't
      if (ch === 0x08 && ty === 0x70) hasSocket = true;
    }
    // If only socket+power channels present, WS52x is the better match
    // (canDecode on WS52x will also return true — let ALL_CODECS ordering decide)
    return hasSocket; // fallback: both match; ordering resolves which wins
  }
}