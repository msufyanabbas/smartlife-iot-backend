// src/modules/devices/codecs/milesight/ts301.codec.ts
// Milesight TS301 — Dual-channel Temperature & Magnet Sensor (PT100/NTC + magnet)
//
// Protocol: IPSO channel_id + channel_type
//
// Telemetry:
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//   0x01 0x75 — battery (uint8 %)
//   0x03 0x67 — temperature_chn1 (int16 LE /10, °C)
//   0x04 0x67 — temperature_chn2 (int16 LE /10, °C)
//   0x03 0x00 — magnet_chn1 (1B, 0=close, 1=open)
//   0x04 0x00 — magnet_chn2 (1B)
//   0x83 0x67 — temperature_chn1 + alarm (3B)
//   0x84 0x67 — temperature_chn2 + alarm (3B)
//   0x93 0xD7 — temperature_chn1 + mutation/100 + alarm (5B)
//   0x94 0xD7 — temperature_chn2 + mutation/100 + alarm (5B)
//   0x20 0xCE — history: ts(4B) + chn_mask(1B) + data — variable length
//               chn_mask nibbles: [7:4]=chn1_event, [3:0]=chn2_event
//               event codes per nibble: 0=none, 1=threshold alarm, 2=alarm release,
//               3=mutation alarm, 4=period report, 5=magnet alarm, 6=magnet period
//               each active channel contributes 4B of data (int16 temp or uint16 magnet)
//
// Key protocol notes:
//   - report_interval in MINUTES via 0xFF 0x8E 0x00 <uint16 LE>
//   - timezone uses hour×10 encoding (same as TS101)
//   - alarm config 0xFF 0x06: bit7=alarm_release_enable, bit6=enable, bits[5:3]=alarm_type,
//     bits[2:0]=condition  (TS301 adds bit7 for alarm_release vs TS101 which lacks it)
//     alarm_type: 1=temperature threshold (0x01<<3), 3=temperature mutation (0x03<<3)
//   - calibration 0xFF 0xEA: data byte bit[6:0]=idx (0 for chn1), bit7=enable; val×10
//   - magnet_throttle 0xFF 0x91 0x01 <uint32 LE ms>
//   - child_lock 0xFF 0x25 <enable> 0x00
//   - mutation alarm uses 0x93/0x94 0xD7, mutation value /100 (same as TS101)
//   - history data length varies by mask: 4B per active channel (2 temp or 2 magnet)

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

// ── Timezone map (hour×10 units) ─────────────────────────────────────────────
const TZ: Record<number, string> = {
  [-120]:'UTC-12',[-110]:'UTC-11',[-100]:'UTC-10',[-95]:'UTC-9:30',
  [-90]:'UTC-9',  [-80]:'UTC-8',  [-70]:'UTC-7',  [-60]:'UTC-6',
  [-50]:'UTC-5',  [-40]:'UTC-4',  [-35]:'UTC-3:30',[-30]:'UTC-3',
  [-20]:'UTC-2',  [-10]:'UTC-1',   [0]:'UTC',       [10]:'UTC+1',
   [20]:'UTC+2',   [30]:'UTC+3',  [35]:'UTC+3:30', [40]:'UTC+4',
   [45]:'UTC+4:30',[50]:'UTC+5',  [55]:'UTC+5:30', [57]:'UTC+5:45',
   [60]:'UTC+6',   [65]:'UTC+6:30',[70]:'UTC+7',   [80]:'UTC+8',
   [90]:'UTC+9',   [95]:'UTC+9:30',[100]:'UTC+10', [105]:'UTC+10:30',
  [110]:'UTC+11', [120]:'UTC+12', [127]:'UTC+12:45',[130]:'UTC+13',
  [140]:'UTC+14',
};
function tzName(v: number): string { return TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(TZ)) if (n === name) return parseInt(k);
  return 80;
}

// ── History channel event codes ───────────────────────────────────────────────
const HIST_EVENT: Record<number, string> = {
  0:'none', 1:'temperature threshold alarm', 2:'temperature threshold alarm release',
  3:'temperature mutation alarm', 4:'temperature period report',
  5:'magnet alarm', 6:'magnet period report',
};
const ALARM_MAP: Record<number, string> = { 0:'threshold_alarm_release', 1:'threshold_alarm', 2:'mutation_alarm' };

export class MilesightTS301Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ts301';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS301'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Temperature, Magnet & Vibration Sensor';
  readonly modelFamily     = 'TS301';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/ts-series/ts301/ts301.png';

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ──────────────────────────────────────────────────────────

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
        const cm: Record<number, string> = { 0:'Class A',1:'Class B',2:'Class C',3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Temperature channels (0x03/0x04 0x67) ────────────────────────────────
      else if ((ch === 0x03 || ch === 0x04) && ty === 0x67) {
        const chn = ch - 0x02; // ch3→1, ch4→2
        decoded[`temperature_chn${chn}`] = i16(bytes, i) / 10; i += 2;
      }

      // ── Magnet channels (0x03/0x04 0x00) ─────────────────────────────────────
      else if ((ch === 0x03 || ch === 0x04) && ty === 0x00) {
        const chn = ch - 0x02;
        decoded[`magnet_chn${chn}`] = bytes[i] === 1 ? 'open' : 'close'; i += 1;
      }

      // ── Temperature threshold alarm (0x83/0x84 0x67) ─────────────────────────
      else if ((ch === 0x83 || ch === 0x84) && ty === 0x67) {
        const chn = ch - 0x80 - 0x02; // 0x83→1, 0x84→2
        decoded[`temperature_chn${chn}`]       = i16(bytes, i) / 10;
        decoded[`temperature_chn${chn}_alarm`] = ALARM_MAP[bytes[i + 2] & 0xff] ?? 'unknown';
        i += 3;
      }

      // ── Temperature mutation alarm (0x93/0x94 0xD7) — mutation /100 ──────────
      else if ((ch === 0x93 || ch === 0x94) && ty === 0xd7) {
        const chn = ch - 0x90 - 0x02; // 0x93→1, 0x94→2
        decoded[`temperature_chn${chn}`]        = i16(bytes, i) / 10;
        decoded[`temperature_chn${chn}_change`] = i16(bytes, i + 2) / 100;
        decoded[`temperature_chn${chn}_alarm`]  = ALARM_MAP[bytes[i + 4] & 0xff] ?? 'unknown';
        i += 5;
      }

      // ── History (0x20 0xCE) — variable length ────────────────────────────────
      // Format: ts(4B) + chn_mask(1B) + data(variable)
      // chn_mask: bits[7:4]=chn1_event, bits[3:0]=chn2_event
      // Each active (non-zero) channel contributes 4B of data:
      //   - temp events (1-4): int16 LE temperature × 2B padded to 4B
      //   - magnet events (5-6): uint16 LE magnet × 2B padded to 4B
      // Note: decoder reads exactly 4B per active channel
      else if (ch === 0x20 && ty === 0xce) {
        const ts      = u32(bytes, i);
        const mask    = bytes[i + 4] & 0xff;
        const chn1ev  = (mask >>> 4) & 0x0f;
        const chn2ev  = mask & 0x0f;
        const entry: Record<string, any> = { timestamp: ts };
        let di = i + 5; // data starts here

        if (chn1ev !== 0) {
          entry[`temperature_chn1_event`] = HIST_EVENT[chn1ev] ?? 'unknown';
          if (chn1ev >= 1 && chn1ev <= 4) {
            entry.temperature_chn1 = i16(bytes, di) / 10;
          } else {
            entry.magnet_chn1 = bytes[di] === 1 ? 'open' : 'close';
          }
          di += 4;
        }
        if (chn2ev !== 0) {
          entry[`temperature_chn2_event`] = HIST_EVENT[chn2ev] ?? 'unknown';
          if (chn2ev >= 1 && chn2ev <= 4) {
            entry.temperature_chn2 = i16(bytes, di) / 10;
          } else {
            entry.magnet_chn2 = bytes[di] === 1 ? 'open' : 'close';
          }
          di += 4;
        }
        i = di;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Downlink responses (0xFF / 0xFE) ─────────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data); i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const condMap: Record<number, string> = { 0:'disable',1:'below',2:'above',3:'between',4:'outside',5:'mutation' };

    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x06: {
        // alarm config byte: bit7=alarm_release_enable, bit6=enable, bits[5:3]=alarm_type, bits[2:0]=condition
        const ctrl         = b[offset] & 0xff;
        const condVal      = ctrl & 0x07;
        const alarmType    = (ctrl >>> 3) & 0x07;  // 1=temp threshold, 3=temp mutation
        const enableBit    = (ctrl >>> 6) & 1;
        const releaseBit   = (ctrl >>> 7) & 1;
        if (condVal === 5 || alarmType === 3) {
          data.temperature_mutation_alarm_config = {
            enable:               enableBit === 1 ? 'enable' : 'disable',
            alarm_release_enable: releaseBit === 1 ? 'enable' : 'disable',
            mutation:             i16(b, offset + 3) / 10,
          };
        } else {
          data.temperature_alarm_config = {
            enable:               enableBit === 1 ? 'enable' : 'disable',
            alarm_release_enable: releaseBit === 1 ? 'enable' : 'disable',
            condition:            condMap[condVal] ?? 'unknown',
            threshold_min:        i16(b, offset + 1) / 10,
            threshold_max:        i16(b, offset + 3) / 10,
          };
        }
        offset += 9; break;
      }
      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x17: data.time_zone     = tzName(i16(b, offset)); offset += 2; break;
      case 0x25: data.child_lock    = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break; // skip trailing 0x00 counted in caller
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2d: data.display_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x4a: data.sync_time     = 'yes'; offset += 1; break;
      case 0x68: data.history_enable      = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: data.retransmit_enable   = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const sub = b[offset] & 0xff;
        if (sub === 0) data.retransmit_interval = u16(b, offset + 1);
        else           data.resend_interval     = u16(b, offset + 1);
        offset += 3; break;
      }
      case 0x6d: data.stop_transmit = 'yes'; offset += 1; break;
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break;
      case 0x91: data.magnet_throttle = u32(b, offset + 1); offset += 5; break; // skip sub-type byte
      case 0xe9: data.time_display              = b[offset] === 1 ? '24_hour' : '12_hour'; offset += 1; break;
      case 0xea: {
        const ctrl  = b[offset] & 0xff;
        const enBit = (ctrl >>> 7) & 1;
        data.temperature_calibration_settings = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: i16(b, offset + 1) / 10 };
        offset += 3; break;
      }
      case 0xeb: data.temperature_unit_display = b[offset] === 1 ? 'fahrenheit' : 'celsius'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];
    const condMap: Record<string, number> = { disable:0, below:1, above:2, between:3, outside:4 };

    switch (type) {
      case 'reboot':                  bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      case 'set_report_interval':     bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 10)]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;
      case 'set_time_zone':           bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_time_display':        bytes = [0xff, 0xe9, params.time_display === '24_hour' ? 1 : 0]; break;
      case 'set_temperature_unit_display': bytes = [0xff, 0xeb, params.temperature_unit_display === 'fahrenheit' ? 1 : 0]; break;
      case 'set_display_enable':      bytes = [0xff, 0x2d, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_child_lock':          bytes = [0xff, 0x25, params.enable === 'enable' ? 1 : 0, 0x00]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_retransmit_enable':   bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_interval': bytes = [0xff, 0x6a, 0x00, ...wu16(params.retransmit_interval ?? 300)]; break;
      case 'set_resend_interval':     bytes = [0xff, 0x6a, 0x01, ...wu16(params.resend_interval ?? 300)]; break;
      case 'set_magnet_throttle':     bytes = [0xff, 0x91, 0x01, ...wu32(params.magnet_throttle ?? 0)]; break;

      case 'set_temperature_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        const idx    = params.idx ?? 0; // channel index (0 for chn1)
        const ctrl   = ((enBit << 7) | (idx & 0x7f)) & 0xff;
        bytes = [0xff, 0xea, ctrl, ...wi16(Math.round((params.calibration_value ?? 0) * 10))]; break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0; const end = params.end_time ?? 0;
        bytes = end === 0 ? [0xfd, 0x6b, ...wu32(start)] : [0xfd, 0x6c, ...wu32(start), ...wu32(end)]; break;
      }

      case 'set_temperature_alarm_config': {
        const condVal    = condMap[params.condition ?? 'below'] ?? 1;
        const enableBit  = params.enable === 'enable' ? 1 : 0;
        const releaseBit = params.alarm_release_enable === 'enable' ? 1 : 0;
        // alarm_type=1 (temperature threshold): bits[5:3] = 0x01 << 3 = 0x08
        const ctrl       = condVal | (1 << 3) | (enableBit << 6) | (releaseBit << 7);
        const minRaw     = Math.round((params.threshold_min ?? 0) * 10);
        const maxRaw     = Math.round((params.threshold_max ?? 0) * 10);
        bytes = [0xff, 0x06, ctrl & 0xff, ...wi16(minRaw), ...wi16(maxRaw), 0, 0, 0, 0]; break;
      }

      case 'set_temperature_mutation_alarm_config': {
        // condition=5 (mutation), alarm_type=3: bits[5:3] = 0x03 << 3 = 0x18
        const enableBit  = params.enable === 'enable' ? 1 : 0;
        const releaseBit = params.alarm_release_enable === 'enable' ? 1 : 0;
        const ctrl       = 5 | (3 << 3) | (enableBit << 6) | (releaseBit << 7);
        const mutRaw     = Math.round((params.mutation ?? 0) * 10);
        bytes = [0xff, 0x06, ctrl & 0xff, 0, 0, ...wi16(mutRaw), 0, 0, 0, 0]; break;
      }

      default:
        throw new Error(`TS301: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // TS301 is uniquely identified by:
  //   0x04 0x67 — temperature_chn2 (dual channel)
  //   0x84 0x67 — temperature_chn2 threshold alarm
  //   0x94 0xD7 — temperature_chn2 mutation alarm
  //   0x03 0x00 or 0x04 0x00 — magnet status

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x04 && ty === 0x67) return true;  // chn2 temperature
      if (ch === 0x84 && ty === 0x67) return true;  // chn2 threshold alarm
      if (ch === 0x94 && ty === 0xd7) return true;  // chn2 mutation alarm
      if ((ch === 0x03 || ch === 0x04) && ty === 0x00) return true; // magnet
    }
    return false;
  }
}