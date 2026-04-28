// src/modules/devices/codecs/milesight/vs370.codec.ts
// Milesight VS370 — Radar Human Presence Sensor (PIR + mmWave radar)
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
//   0x04 0x00 — illuminance (1B): 0=dim, 1=bright, 0xFE=disable
//
// Standard downlink responses (0xFF/0xFE):
//   0x10 — reboot
//   0x28 — report_status (0=plan, 1=periodic)
//   0x35 — d2d_key (8B hex)
//   0x4A — sync_time
//   0x84 — d2d_enable
//   0x8E — report_interval (skip byte 0 which is 0x01, uint16 LE)
//   0x8F — bluetooth_enable
//   0x96 — d2d_master_config (8B): mode(1)+enable(1)+lora_uplink(1)+cmd(2)+time(2)+time_enable(1)
//          modes: 0=occupied,1=vacant,2=bright,3=dim,4=occupied_bright,5=occupied_dim
//   0xBA — dst_config (10B)
//   0xBD — time_zone (int16 LE, minutes)
//
// Extended downlink (0xF9/0xF8):
//   0x3E — pir_sensitivity (0=low,1=medium,2=high)
//   0x3F — radar_sensitivity (0=low,1=medium,2=high)
//   0x40 — pir_idle_interval (uint8, minutes)
//   0x41 — pir_illuminance_threshold: enable(1)+upper(2)+lower(2)
//   0x42 — pir_window_time (0=2s,1=4s,2=6s,3=8s)
//   0x43 — pir_pulse_times (0=1_times,1=2_times,2=3_times,3=4_times)
//   0x44 — hibernate_config entry (6B): id-1(1)+enable(1)+start(2)+end(2)

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Timezone map ──────────────────────────────────────────────────────────────
const TZ_MAP: Record<number, string> = {
  [-720]: 'UTC-12', [-660]: 'UTC-11', [-600]: 'UTC-10', [-570]: 'UTC-9:30',
  [-540]: 'UTC-9',  [-480]: 'UTC-8',  [-420]: 'UTC-7',  [-360]: 'UTC-6',
  [-300]: 'UTC-5',  [-240]: 'UTC-4',  [-210]: 'UTC-3:30',[-180]: 'UTC-3',
  [-120]: 'UTC-2',  [-60]:  'UTC-1',     [0]: 'UTC',       [60]: 'UTC+1',
   [120]: 'UTC+2',  [180]: 'UTC+3',   [210]: 'UTC+3:30', [240]: 'UTC+4',
   [270]: 'UTC+4:30',[300]: 'UTC+5',  [330]: 'UTC+5:30', [345]: 'UTC+5:45',
   [360]: 'UTC+6',  [390]: 'UTC+6:30',[420]: 'UTC+7',    [480]: 'UTC+8',
   [540]: 'UTC+9',  [570]: 'UTC+9:30',[600]: 'UTC+10',   [630]: 'UTC+10:30',
   [660]: 'UTC+11', [720]: 'UTC+12',  [765]: 'UTC+12:45',[780]: 'UTC+13',
   [840]: 'UTC+14',
};
function tzName(v: number): string { return TZ_MAP[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, val] of Object.entries(TZ_MAP)) if (val === name) return parseInt(k);
  return 180;
}

const MONTH_MAP: Record<number, string> = {
  1: 'January', 2: 'February',  3: 'March',    4: 'April',
  5: 'May',     6: 'June',      7: 'July',      8: 'August',
  9: 'September',10: 'October', 11: 'November', 12: 'December',
};
const WEEK_MAP: Record<number, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday',
  5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};
function monthName(v: number): string { return MONTH_MAP[v] ?? 'unknown'; }
function weekName(v: number): string  { return WEEK_MAP[v]  ?? 'unknown'; }
function monthValue(name: string): number {
  for (const [k, v] of Object.entries(MONTH_MAP)) if (v === name) return parseInt(k);
  return 1;
}
function weekValue(name: string): number {
  for (const [k, v] of Object.entries(WEEK_MAP)) if (v === name) return parseInt(k);
  return 1;
}

export class MilesightVS370Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs370';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS370'];
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

      // ── Battery (0x01 0x75) ───────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── Occupancy (0x03 0x00) — 0=vacant, 1=occupied ─────────────────────
      else if (ch === 0x03 && ty === 0x00) {
        decoded.occupancy = bytes[i] === 1 ? 'occupied' : 'vacant'; i += 1;
      }

      // ── Illuminance (0x04 0x00) — 0=dim, 1=bright, 0xFE=disable ──────────
      else if (ch === 0x04 && ty === 0x00) {
        const v = bytes[i] & 0xff;
        const illumMap: Record<number, string> = { 0: 'dim', 1: 'bright', 0xfe: 'disable' };
        decoded.illuminance = illumMap[v] ?? 'unknown';
        i += 1;
      }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleStdDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF9 / 0xF8) ─────────────────────────
      else if (ch === 0xf9 || ch === 0xf8) {
        const result = this.handleExtDownlink(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleStdDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;
    const i16 = (o: number) => { const v = u16(o); return v > 0x7fff ? v - 0x10000 : v; };

    switch (ty) {
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x28: {
        const statusMap: Record<number, string> = { 0: 'plan', 1: 'periodic' };
        data.report_status = statusMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x35:
        data.d2d_key = bytes.slice(offset, offset + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        offset += 8; break;
      case 0x4a:
        data.sync_time = 'yes'; offset += 1; break;
      case 0x84:
        data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e:
        // skip first byte (0x01 sub-type), read uint16 LE
        data.report_interval = u16(offset + 1); offset += 3; break;
      case 0x8f:
        data.bluetooth_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x96: {
        const modeMap: Record<number, string> = {
          0: 'occupied', 1: 'vacant', 2: 'bright', 3: 'dim',
          4: 'occupied_bright', 5: 'occupied_dim',
        };
        const cfg: Record<string, any> = {
          mode:               modeMap[bytes[offset]] ?? 'unknown',
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
      case 0xba: {
        // dst_config: 10 bytes
        // [0]=enable [1]=offset(int8) [2]=start_month [3]=start_week(nibbles: num|day)
        // [4..5]=start_time(uint16) [6]=end_month [7]=end_week [8..9]=end_time(uint16)
        const enableVal = bytes[offset] & 0xff;
        const cfg: Record<string, any> = {
          enable: enableVal === 1 ? 'enable' : 'disable',
          offset: bytes[offset + 1] > 0x7f ? bytes[offset + 1] - 0x100 : bytes[offset + 1],
        };
        if (enableVal === 1) {
          cfg.start_month    = monthName(bytes[offset + 2]);
          const sw           = bytes[offset + 3] & 0xff;
          cfg.start_week_num = sw >> 4;
          cfg.start_week_day = weekName(sw & 0x0f);
          cfg.start_time     = u16(offset + 4);
          cfg.end_month      = monthName(bytes[offset + 6]);
          const ew           = bytes[offset + 7] & 0xff;
          cfg.end_week_num   = ew >> 4;
          cfg.end_week_day   = weekName(ew & 0x0f);
          cfg.end_time       = u16(offset + 8);
        }
        data.dst_config = cfg;
        offset += 10; break;
      }
      case 0xbd:
        data.time_zone = tzName(i16(offset)); offset += 2; break;
      default:
        offset += 1; break;
    }
    return { data, offset };
  }

  private handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;

    switch (ty) {
      case 0x3e: {
        const sensMap: Record<number, string> = { 0: 'low', 1: 'medium', 2: 'high' };
        data.pir_sensitivity = sensMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x3f: {
        const sensMap: Record<number, string> = { 0: 'low', 1: 'medium', 2: 'high' };
        data.radar_sensitivity = sensMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x40:
        data.pir_idle_interval = bytes[offset] & 0xff; offset += 1; break;
      case 0x41:
        data.pir_illuminance_threshold = {
          enable:      bytes[offset] === 1 ? 'enable' : 'disable',
          upper_limit: u16(offset + 1),
          lower_limit: u16(offset + 3),
        };
        offset += 5; break;
      case 0x42: {
        const wtMap: Record<number, string> = { 0: '2s', 1: '4s', 2: '6s', 3: '8s' };
        data.pir_window_time = wtMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x43: {
        const ptMap: Record<number, string> = { 0: '1_times', 1: '2_times', 2: '3_times', 3: '4_times' };
        data.pir_pulse_times = ptMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x44: {
        // id-1(1) + enable(1) + start_time(2) + end_time(2) = 6B
        const cfg: Record<string, any> = {
          id:         (bytes[offset] & 0xff) + 1, // stored as 0-based
          enable:     bytes[offset + 1] === 1 ? 'enable' : 'disable',
          start_time: ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff,
          end_time:   ((bytes[offset + 5] << 8) | bytes[offset + 4]) & 0xffff,
        };
        if (!data.hibernate_config) data.hibernate_config = [];
        data.hibernate_config.push(cfg);
        offset += 6; break;
      }
      default:
        offset += 1; break;
    }

    // 0xF8 carries result flag
    if (code === 0xf8) {
      const rv = bytes[offset++] & 0xff;
      if (rv !== 0) {
        const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
        const req = { ...data };
        return {
          data: { device_response_result: { channel_type: ty, result: resultMap[rv] ?? 'unknown', request: req } },
          offset,
        };
      }
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const i16 = (v: number) => { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; };
    const hexBytes = (hex: string) => { const o: number[] = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
    const d2dCmd  = (cmd: string) => [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];

    switch (type) {

      case 'reboot': bytes = [0xff, 0x10, 0xff]; break;
      case 'sync_time': bytes = [0xff, 0x4a, 0xff]; break;

      case 'report_status': {
        const m: Record<string, number> = { plan: 0, periodic: 1 };
        bytes = [0xff, 0x28, m[params.report_status ?? 'plan'] ?? 0]; break;
      }

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        // note: sub-type byte is 0x01 (not 0x00 like VS350/360)
        bytes = [0xff, 0x8e, 0x01, ...u16(v)]; break;
      }

      case 'set_pir_idle_interval': {
        const v = params.pir_idle_interval ?? 3;
        if (v < 1 || v > 60) throw new Error('pir_idle_interval must be 1–60 minutes');
        bytes = [0xf9, 0x40, v & 0xff]; break;
      }

      case 'set_time_zone':
        bytes = [0xff, 0xbd, ...i16(tzValue(params.time_zone ?? 'UTC+3'))]; break;

      case 'set_dst_config': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const offsetVal = params.offset ?? 60;
        const i8 = (v: number) => v < 0 ? v + 0x100 : v;
        if (!enable) {
          bytes = [0xff, 0xba, 0, i8(offsetVal), 0, 0, 0, 0, 0, 0, 0, 0]; break;
        }
        const sm  = monthValue(params.start_month    ?? 'March');
        const swd = weekValue(params.start_week_day  ?? 'Sunday');
        const swn = params.start_week_num ?? 2;
        const st  = params.start_time     ?? 120;
        const em  = monthValue(params.end_month      ?? 'October');
        const ewd = weekValue(params.end_week_day    ?? 'Sunday');
        const ewn = params.end_week_num   ?? 1;
        const et  = params.end_time       ?? 120;
        bytes = [
          0xff, 0xba,
          1, i8(offsetVal),
          sm,
          ((swn & 0x0f) << 4) | (swd & 0x0f),
          ...u16(st),
          em,
          ((ewn & 0x0f) << 4) | (ewd & 0x0f),
          ...u16(et),
        ];
        break;
      }

      case 'set_pir_window_time': {
        const m: Record<string, number> = { '2s': 0, '4s': 1, '6s': 2, '8s': 3 };
        bytes = [0xf9, 0x42, m[params.pir_window_time ?? '2s'] ?? 0]; break;
      }

      case 'set_pir_pulse_times': {
        const m: Record<string, number> = { '1_times': 0, '2_times': 1, '3_times': 2, '4_times': 3 };
        bytes = [0xf9, 0x43, m[params.pir_pulse_times ?? '1_times'] ?? 0]; break;
      }

      case 'set_pir_sensitivity': {
        const m: Record<string, number> = { low: 0, medium: 1, high: 2 };
        bytes = [0xf9, 0x3e, m[params.pir_sensitivity ?? 'medium'] ?? 1]; break;
      }

      case 'set_radar_sensitivity': {
        const m: Record<string, number> = { low: 0, medium: 1, high: 2 };
        bytes = [0xf9, 0x3f, m[params.radar_sensitivity ?? 'medium'] ?? 1]; break;
      }

      case 'set_pir_illuminance_threshold': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const upper  = params.upper_limit ?? 700;
        const lower  = params.lower_limit ?? 300;
        if (upper < 1 || upper > 8000) throw new Error('upper_limit must be 1–8000');
        if (lower < 1 || lower > 8000) throw new Error('lower_limit must be 1–8000');
        bytes = [0xf9, 0x41, enable, ...u16(upper), ...u16(lower)]; break;
      }

      case 'set_bluetooth_enable':
        bytes = [0xff, 0x8f, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexBytes(key)]; break;
      }

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = {
          occupied: 0, vacant: 1, bright: 2, dim: 3, occupied_bright: 4, occupied_dim: 5,
        };
        const mode       = modeMap[params.mode ?? 'occupied'] ?? 0;
        const enable     = params.enable             === 'enable' ? 1 : 0;
        const loraUplink = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd        = params.d2d_cmd ?? '0000';
        const time       = params.time ?? 0;
        const timeEnable = params.time_enable === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [0xff, 0x96, mode, enable, loraUplink, ...d2dCmd(cmd), ...u16(time), timeEnable]; break;
      }

      case 'set_hibernate_config': {
        const id     = params.id ?? 1;
        const enable = params.enable === 'enable' ? 1 : 0;
        const start  = params.start_time ?? 0;
        const end    = params.end_time   ?? 0;
        if (id < 1 || id > 2) throw new Error('hibernate_config.id must be 1 or 2');
        if (start < 0 || start > 1440) throw new Error('start_time must be 0–1440');
        if (end   < 0 || end   > 1440) throw new Error('end_time must be 0–1440');
        bytes = [0xf9, 0x44, (id - 1) & 0xff, enable, ...u16(start), ...u16(end)]; break;
      }

      default:
        throw new Error(`VS370: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS370 is uniquely identified by:
  //   0x03 0x00 + 0x04 0x00 combination — occupancy AND illuminance with 0x00 type
  //   Note: VS340/341 also have 0x03 0x00 but NOT 0x04 0x00 together
  //   illuminance 0x04 0x00 with 0xFE=disable value further distinguishes this

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasOccupancy = false;
    let hasIlluminance = false;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x03 && ty === 0x00) hasOccupancy  = true;
      if (ch === 0x04 && ty === 0x00) hasIlluminance = true;
    }
    return hasOccupancy && hasIlluminance;
  }
}