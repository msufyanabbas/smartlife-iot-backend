// src/modules/devices/codecs/milesight/am305l.codec.ts
/**
 * Milesight AM305L Codec
 * Ambience Monitoring Sensor — Temperature + Humidity + PIR + Illuminance + CO₂
 *
 * AM305L = AM304L + CO₂ channel + CO₂ alarm + CO₂ calibration
 * Inherits all AM304L decode/encode logic and adds:
 *
 * New telemetry channels:
 *   - 0x07 0x7D → co2 (uint16 LE, ppm, 400–5000)
 *
 * New anomaly channels:
 *   - 0xB7 0x7D → co2_collection_anomaly.type
 *
 * New alarm channel:
 *   - 0x87 0x7D → co2_alarm: { co2, alarm_type }
 *     alarm_type: 16=Polluted 2-level released, 17=Polluted 2-level,
 *                 18=Bad 1-level released, 19=Bad 1-level
 *
 * Historical data — both modes now include co2 field:
 *   - 0x20 0xCE → co2_type + co2 (2B each) appended after als_level
 *   - 0x21 0xCE → co2_type + co2 (2B each) appended after Lux
 *
 * New config channels (0xFF sub-commands):
 *   - 0x39 → co2_auto_background_calibration_settings
 *   - 0x87 → co2_altitude_calibration
 *   - 0x1A → co2_reset_calibration / co2_background_calibration
 *   - 0xEA case 2 → co2_calibration_settings
 *   - 0x18 case 5 → co2_collecting_enable
 *
 * New config channels (0xF9 sub-commands):
 *   - 0xC4 → co2_alarm_rule
 *
 * Based on official Milesight AM305L decoder/encoder v1.0.0
 */

import { MilesightAM304LCodec } from './am304l.codec';
import {
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// Re-use helpers from parent via closure (they're defined at module level in am304l)
function u8(bytes: number[], i: number): number  { return bytes[i] & 0xff; }
function u16le(bytes: number[], i: number): number { return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff; }
function i16le(bytes: number[], i: number): number {
  const v = u16le(bytes, i);
  return v > 0x7fff ? v - 0x10000 : v;
}
function u32le(bytes: number[], i: number): number {
  return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
}
function hexStr(bytes: number[], i: number, len: number): string {
  return bytes.slice(i, i + len).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

export class MilesightAM305LCodec extends MilesightAM304LCodec {
  override readonly codecId: string          = 'milesight-am305l';
  override readonly supportedModels: string[] = ['AM305L'];

  // ── Decode ────────────────────────────────────────────────────────────────
  // Full override — AM305L has identical structure to AM304L but with extra
  // channels, so we decode everything here rather than calling super() and
  // trying to patch the result.

  override decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];

      switch (ch) {

        // ── 0xFF ─────────────────────────────────────────────────────────
        case 0xff: {
          const ty = bytes[i++];
          switch (ty) {
            case 0x0b: decoded.device_status   = u8(bytes, i++) === 1 ? 'on' : 'off'; break;
            case 0x01: decoded.ipso_version     = u8(bytes, i++); break;
            case 0x16: decoded.sn = hexStr(bytes, i, 8); i += 8; break;
            case 0xff: decoded.tsl_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`; i += 2; break;
            case 0xfe: decoded.request_tsl_config = u8(bytes, i++); break;
            case 0x09: decoded.hardware_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`; i += 2; break;
            case 0x0a: decoded.firmware_version = `v${u8(bytes, i)}.${u8(bytes, i + 1)}`; i += 2; break;
            case 0x0f: decoded.lorawan_class = u8(bytes, i++); break;
            case 0xf2: decoded.alarm_reporting_times     = u16le(bytes, i); i += 2; break;
            case 0xf5: decoded.alarm_deactivation_enable = u8(bytes, i++); break;
            case 0x2e: decoded.led_mode                  = u8(bytes, i++); break;

            case 0x25: {
              const bits = u8(bytes, i++);
              decoded.button_lock = { power_off: bits & 0x01, power_on: (bits >> 1) & 0x01 };
              break;
            }

            case 0x06: {
              const bits = u8(bytes, i++);
              const condMap: Record<number, string> = { 1: 'x<A', 2: 'x>B', 3: 'A<x<B', 4: 'x<A or x>B' };
              decoded.temperature_alarm_rule = {
                enable:                  (bits >> 6) & 0x01,
                condition:               condMap[bits & 0x07] ?? 'unknown',
                id:                      (bits >> 3) & 0x07,
                threshold_max:           i16le(bytes, i)     / 10,
                threshold_min:           i16le(bytes, i + 2) / 10,
                threshold_lock_time:     u16le(bytes, i + 4),
                threshold_continue_time: u16le(bytes, i + 6),
              };
              i += 8;
              break;
            }

            case 0x18: {
              const sensorId = u8(bytes, i++);
              const bits     = u8(bytes, i++);
              if (sensorId === 3) decoded.pir_enable                   = { enable: (bits >> 2) & 0x01 };
              if (sensorId === 4) decoded.illuminance_collecting_enable = { enable: (bits >> 3) & 0x01 };
              if (sensorId === 5) decoded.co2_collecting_enable         = { enable: (bits >> 4) & 0x01 };
              break;
            }

            case 0x95: decoded.pir_idle_interval = u16le(bytes, i); i += 2; break;

            case 0xea: {
              const bits = u8(bytes, i++);
              const id   = bits & 0x7f;
              const en   = (bits >> 7) & 0x01;
              if (id === 0) decoded.temperature_calibration_settings = { enable: en, value: i16le(bytes, i) / 10 };
              if (id === 1) decoded.humidity_calibration_settings     = { enable: en, value: i16le(bytes, i) / 2 };
              if (id === 2) decoded.co2_calibration_settings          = { enable: en, value: u16le(bytes, i) };
              i += 2;
              break;
            }

            case 0x39:
              decoded.co2_auto_background_calibration_settings = {
                enable:       u8(bytes, i++),
                target_value: u16le(bytes, i),
                period:       u16le(bytes, i + 2),
              };
              i += 4;
              break;

            case 0x87:
              decoded.co2_altitude_calibration = {
                enable: u8(bytes, i++),
                value:  u16le(bytes, i),
              };
              i += 2;
              break;

            case 0x1a: {
              const mode = u8(bytes, i++);
              if (mode === 0) decoded.co2_reset_calibration      = mode;
              if (mode === 3) decoded.co2_background_calibration = mode;
              break;
            }

            case 0x96: {
              const trigCond = u8(bytes, i++);
              const item: Record<string, any> = {
                trigger_condition:   trigCond,
                enable:              u8(bytes, i++),
                lora_uplink_enable:  u8(bytes, i++),
                control_command:     hexStr(bytes, i, 2),
                control_time_enable: u8(bytes, i + 2),
                control_time:        u16le(bytes, i + 3),
              };
              i += 5;
              if (!decoded.d2d_master_settings) decoded.d2d_master_settings = [];
              (decoded.d2d_master_settings as any[]).push(item);
              break;
            }

            case 0x68: decoded.data_storage_enable  = { enable: u8(bytes, i++) }; break;
            case 0x69: decoded.retransmission_enable = { enable: u8(bytes, i++) }; break;

            case 0x6a: {
              const type = u8(bytes, i++);
              const val  = u16le(bytes, i); i += 2;
              if (type === 0) decoded.retransmission_interval = { interval: val };
              else            decoded.retrival_interval       = { interval: val };
              break;
            }

            case 0x27: decoded.clear_historical_data = u8(bytes, i++); break;
            case 0x10: decoded.reboot                = u8(bytes, i++); break;
            case 0x4a: decoded.synchronize_time      = u8(bytes, i++); break;

            default: i++; break;
          }
          break;
        }

        // ── 0x01 — battery ────────────────────────────────────────────────
        case 0x01: {
          const ty = bytes[i++];
          if (ty === 0x75) { decoded.battery = u8(bytes, i++); decoded.batteryLevel = decoded.battery as number; }
          break;
        }

        // ── 0x03 — temperature ────────────────────────────────────────────
        case 0x03: {
          const ty = bytes[i++];
          if (ty === 0x67) { decoded.temperature = i16le(bytes, i) / 10; i += 2; }
          break;
        }

        // ── 0x04 — humidity ───────────────────────────────────────────────
        case 0x04: {
          const ty = bytes[i++];
          if (ty === 0x68) { decoded.humidity = u8(bytes, i++) / 2; }
          break;
        }

        // ── 0x05 — PIR ────────────────────────────────────────────────────
        case 0x05: {
          const ty = bytes[i++];
          if (ty === 0x9f) {
            const raw = u16le(bytes, i); i += 2;
            decoded.pir = { pir_status: (raw >> 15) & 0x01, pir_count: raw & 0x7fff };
          } else if (ty === 0x00) {
            decoded.pir_status_change = { status: u8(bytes, i++) };
            if (!decoded.pir) decoded.pir = { pir_status: 0, pir_count: 0 };
            (decoded.pir as any).pir_status = (decoded.pir_status_change as any).status;
          }
          break;
        }

        // ── 0x06 — illuminance ────────────────────────────────────────────
        case 0x06: {
          const ty = bytes[i++];
          if      (ty === 0xcb) { decoded.als_level = u8(bytes, i++); }
          else if (ty === 0x9d) { decoded.lux = u16le(bytes, i); i += 2; }
          break;
        }

        // ── 0x07 — CO₂ ───────────────────────────────────────────────────
        case 0x07: {
          const ty = bytes[i++];
          if (ty === 0x7d) { decoded.co2 = u16le(bytes, i); i += 2; }
          break;
        }

        // ── Anomaly channels ──────────────────────────────────────────────
        case 0xb3: { const ty = bytes[i++]; if (ty === 0x67) decoded.temperature_collection_anomaly = { type: u8(bytes, i++) }; break; }
        case 0xb4: { const ty = bytes[i++]; if (ty === 0x68) decoded.humidity_collection_anomaly    = { type: u8(bytes, i++) }; break; }
        case 0xb6: {
          const ty = bytes[i++];
          if      (ty === 0xcb) decoded.illuminace_collection_anomaly = { type: u8(bytes, i++) };
          else if (ty === 0x9d) decoded.lux_collection_anomaly        = { type: u8(bytes, i++) };
          break;
        }
        // CO₂ anomaly — new in AM305L
        case 0xb7: { const ty = bytes[i++]; if (ty === 0x7d) decoded.co2_collection_anomaly = { type: u8(bytes, i++) }; break; }

        // ── Alarm events ──────────────────────────────────────────────────
        case 0x83: {
          const ty = bytes[i++];
          if (ty === 0x67) {
            const temp = i16le(bytes, i) / 10;
            decoded.temperature_alarm = { temperature: temp, alarm_type: u8(bytes, i + 2) };
            decoded.temperature = temp;
            i += 3;
          }
          break;
        }
        case 0x86: {
          const ty = bytes[i++];
          if (ty === 0x9d) {
            const luxVal = u16le(bytes, i);
            decoded.lux_alarm = { lux: luxVal, alarm_type: u8(bytes, i + 2) };
            decoded.lux = luxVal;
            i += 3;
          }
          break;
        }
        // CO₂ alarm — new in AM305L
        case 0x87: {
          const ty = bytes[i++];
          if (ty === 0x7d) {
            const co2Val = u16le(bytes, i);
            decoded.co2_alarm = { co2: co2Val, alarm_type: u8(bytes, i + 2) };
            decoded.co2 = co2Val;
            i += 3;
          }
          break;
        }

        // ── Historical data (level mode) — 0x20 0xCE ─────────────────────
        // AM305L adds co2_type + co2 at the end
        case 0x20: {
          const ty = bytes[i++];
          if (ty === 0xce) {
            const rec: Record<string, any> = {
              timestamp:        u32le(bytes, i),
              temperature_type: u8(bytes, i + 4),
              temperature:      i16le(bytes, i + 5) / 10,
              humidity_type:    u8(bytes, i + 7),
              humidity:         u8(bytes, i + 8) / 2,
            };
            const pirBits    = u8(bytes, i + 9);
            rec.pir_type     = (pirBits >> 6) & 0x01;
            rec.pir_status   =  pirBits & 0x3f;
            rec.pir_count    = u16le(bytes, i + 10);
            rec.als_level_type = u8(bytes, i + 12);
            rec.als_level      = u16le(bytes, i + 13);
            rec.co2_type       = u8(bytes, i + 15);   // AM305L addition
            rec.co2            = u16le(bytes, i + 16); // AM305L addition
            i += 18;
            if (!decoded.historical_data) decoded.historical_data = [];
            (decoded.historical_data as any[]).push(rec);
          }
          break;
        }

        // ── Historical data (lux mode) — 0x21 0xCE ───────────────────────
        // AM305L adds co2_type + co2 at the end
        case 0x21: {
          const ty = bytes[i++];
          if (ty === 0xce) {
            const rec: Record<string, any> = {
              timestamp:        u32le(bytes, i),
              temperature_type: u8(bytes, i + 4),
              temperature:      i16le(bytes, i + 5) / 10,
              humidity_type:    u8(bytes, i + 7),
              humidity:         u8(bytes, i + 8) / 2,
            };
            const pirBits    = u8(bytes, i + 9);
            rec.pir_type     = (pirBits >> 6) & 0x01;
            rec.pir_status   =  pirBits & 0x3f;
            rec.pir_count    = u16le(bytes, i + 10);
            rec.lux_type     = u8(bytes, i + 12);
            rec.lux          = u16le(bytes, i + 13);
            rec.co2_type     = u8(bytes, i + 15);    // AM305L addition
            rec.co2          = u16le(bytes, i + 16); // AM305L addition
            i += 18;
            if (!decoded.historical_data_lux) decoded.historical_data_lux = [];
            (decoded.historical_data_lux as any[]).push(rec);
          }
          break;
        }

        // ── 0xF9 — config blocks ──────────────────────────────────────────
        case 0xf9: {
          const ty = bytes[i++];
          switch (ty) {
            case 0xbd:
              decoded.reporting_interval = { unit: u8(bytes, i++), interval: u16le(bytes, i) };
              i += 2;
              break;
            case 0xbe:
              decoded.collecting_interval = { id: u8(bytes, i++), unit: u8(bytes, i++), interval: u16le(bytes, i) };
              i += 2;
              break;
            case 0xc0: {
              const sensorId = u8(bytes, i++);
              const val      = u8(bytes, i++);
              if (sensorId === 0) decoded.temperature_unit = { unit: val };
              else                decoded.illuminance_mode = { mode: val };
              break;
            }
            // CO₂ alarm rule — new in AM305L
            case 0xc4:
              decoded.co2_alarm_rule = {
                enable:       u8(bytes, i++),
                mode:         u8(bytes, i++),
                level1_value: u16le(bytes, i),
                level2_value: u16le(bytes, i + 2),
              };
              i += 4;
              break;
            case 0xbc: {
              const type = u8(bytes, i++);
              const en   = u8(bytes, i++);
              if (type === 0) decoded.pir_trigger_report = { enable: en };
              else            decoded.pir_idle_report    = { enable: en };
              break;
            }
            case 0xbf:
              decoded.illuminance_alarm_rule = {
                enable:       u8(bytes, i++),
                dim_value:    u16le(bytes, i),
                bright_value: u16le(bytes, i + 2),
              };
              i += 4;
              break;
            case 0x63: {
              const en     = u8(bytes, i++);
              const loraEn = u8(bytes, i++);
              const bits   = u16le(bytes, i); i += 2;
              decoded.d2d_sending = {
                enable: en, lora_uplink_enable: loraEn,
                temperature_enable: bits & 0x01,
                humidity_enable:    (bits >> 1) & 0x01,
              };
              break;
            }
            case 0x66: decoded.d2d_master_enable = u8(bytes, i++); break;
            default: i++; break;
          }
          break;
        }

        // ── 0xFD — historical data retrieval commands ─────────────────────
        case 0xfd: {
          const ty = bytes[i++];
          if      (ty === 0x6b) { decoded.retrival_historical_data_by_time       = { time: u32le(bytes, i) }; i += 4; }
          else if (ty === 0x6c) { decoded.retrival_historical_data_by_time_range = { start_time: u32le(bytes, i), end_time: u32le(bytes, i + 4) }; i += 8; }
          else if (ty === 0x6d) { decoded.stop_historical_data_retrival           = u8(bytes, i++); }
          break;
        }

        default:
          i = bytes.length;
          break;
      }
    }

    return decoded;
  }

  // ── Encode ────────────────────────────────────────────────────────────────
  // Extends parent encode() with CO₂-specific commands

  override encode(command: { type: string; params?: any }): EncodedCommand {
    const p = command.params ?? {};

    switch (command.type) {

      case 'set_co2_collecting':
        // sensor_id=5 for CO₂, bit4 = enable
        return { fPort: 85, data: this.bytesToHex([0xff, 0x18, 0x05, p.enable ? 0x10 : 0x00]), confirmed: false };

      case 'set_co2_alarm_rule': {
        const l1 = p.level1_value ?? 5000;
        const l2 = p.level2_value ?? 400;
        if (l1 < 400 || l1 > 5000) throw new Error('level1_value must be 400–5000 ppm');
        if (l2 < 400 || l2 > 5000) throw new Error('level2_value must be 400–5000 ppm');
        const bytes = [0xf9, 0xc4, p.enable ? 1 : 0, p.mode ?? 2,
          l1 & 0xff, (l1 >> 8) & 0xff, l2 & 0xff, (l2 >> 8) & 0xff];
        return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
      }

      case 'set_co2_calibration': {
        const val = p.value ?? 0;
        if (val < -4600 || val > 4600) throw new Error('co2 calibration value must be -4600–4600 ppm');
        const valU = val < 0 ? val + 0x10000 : val;
        const bytes = [0xff, 0xea, (p.enable ? 1 << 7 : 0) | 2, valU & 0xff, (valU >> 8) & 0xff];
        return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
      }

      case 'set_co2_auto_background_calibration': {
        const target = p.target_value ?? 400;
        const period = p.period ?? 168;
        const bytes  = [0xff, 0x39, p.enable ? 1 : 0,
          target & 0xff, (target >> 8) & 0xff,
          period & 0xff, (period >> 8) & 0xff];
        return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
      }

      case 'set_co2_altitude_calibration': {
        const val = p.value ?? 0;
        if (val < 0 || val > 5000) throw new Error('altitude value must be 0–5000 m');
        const bytes = [0xff, 0x87, p.enable ? 1 : 0, val & 0xff, (val >> 8) & 0xff];
        return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
      }

      case 'co2_reset_calibration':
        return { fPort: 85, data: this.bytesToHex([0xff, 0x1a, 0x00]), confirmed: false };

      case 'co2_background_calibration':
        return { fPort: 85, data: this.bytesToHex([0xff, 0x1a, 0x03]), confirmed: false };

      default:
        // Delegate all AM304L commands (reboot, intervals, PIR, alarms, etc.)
        return super.encode(command);
    }
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // AM305L is uniquely identified by the CO₂ channel 0x07 0x7D
  // (AM304L never has this channel)

  override canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x07 && ty === 0x7d) return true; // CO₂ — AM305L exclusive

      // Also accept AM304L fingerprints — a device reporting CO₂ will also
      // have PIR / ALS channels on the same frame
      if (ch === 0x05 && ty === 0x9f) return false; // Let AM304L handle if no CO₂
      if (ch === 0x06 && ty === 0xcb) return false;

      if (ch === 0x01 && ty === 0x75) { i += 3; continue; }
      if (ch === 0x03 && ty === 0x67) { i += 4; continue; }
      if (ch === 0x04 && ty === 0x68) { i += 3; continue; }
      if (ch === 0xff) { i += 3; continue; }

      break;
    }

    return false;
  }
}