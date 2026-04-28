// src/modules/devices/codecs/milesight/ts101.codec.ts
// Milesight TS101 — Insertion Temperature Sensor
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
//   0x03 0x67 — temperature (int16 LE /10, °C)          ← normal reading
//   0x83 0x67 — temperature + temperature_alarm (3B)    ← threshold alarm
//   0x93 0xD7 — temperature + mutation + alarm (5B)     ← mutation alarm
//   0x20 0xCE — history: ts(4B) + temperature(2B)
//
// Downlink commands (hour×10 timezone, same as UC300/UC50x):
//   0xFF 0x10  — reboot
//   0xFF 0x28  — query_device_status
//   0xFF 0x4A 0x00 — sync_time
//   0xFF 0x02  — set_collection_interval (uint16 LE, seconds)
//   0xFF 0x03  — set_report_interval (uint16 LE, seconds)
//   0xFF 0x17  — set_time_zone (int16 LE, hour×10)
//   0xFF 0x06  — set_temperature_alarm_config / mutation alarm
//               data byte: bits[2:0]=condition, bits[5:3]=alarm_type, bit6=enable
//               alarm_type: 1=temperature threshold, 2=temperature mutation
//   0xFF 0xAB  — set_temperature_calibration (enable + int16/10)
//   0xFF 0x68  — set_history_enable
//   0xFF 0x27  — clear_history
//   0xFF 0x69  — set_retransmit_enable
//   0xFF 0x6A 0x00 — set_retransmit_interval (uint16 LE)
//   0xFF 0x6A 0x01 — set_resend_interval (uint16 LE)
//   0xFD 0x6B  — fetch_history (start only)
//   0xFD 0x6C  — fetch_history (start + end)
//   0xFD 0x6D  — stop_transmit

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

// ── Timezone map (hour×10 units) ──────────────────────────────────────────────
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

export class MilesightTS101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ts101';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS101'];
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

      // ── Battery (0x01 0x75) ───────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Temperature (0x03 0x67) — int16 LE /10, normal reading ───────────
      else if (ch === 0x03 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10; i += 2;
      }

      // ── Temperature with threshold alarm (0x83 0x67) — int16 + alarm byte ─
      else if (ch === 0x83 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10;
        const alarmMap: Record<number, string> = { 0:'threshold alarm release', 1:'threshold alarm', 2:'mutation alarm' };
        decoded.temperature_alarm = alarmMap[bytes[i + 2] & 0xff] ?? 'unknown';
        i += 3;
      }

      // ── Temperature mutation alarm (0x93 0xD7) — int16 + int16/100 + alarm ─
      // [i..i+1]=temperature, [i+2..i+3]=mutation /100, [i+4]=alarm_type
      else if (ch === 0x93 && ty === 0xd7) {
        decoded.temperature          = i16(bytes, i) / 10;
        decoded.temperature_mutation = i16(bytes, i + 2) / 100;
        const alarmMap: Record<number, string> = { 0:'threshold alarm release', 1:'threshold alarm', 2:'mutation alarm' };
        decoded.temperature_alarm    = alarmMap[bytes[i + 4] & 0xff] ?? 'unknown';
        i += 5;
      }

      // ── History (0x20 0xCE) — ts(4B) + temperature(2B) ───────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const entry = { timestamp: u32(bytes, i), temperature: i16(bytes, i + 4) / 10 };
        i += 6;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x03: data.report_interval     = u16(b, offset); offset += 2; break;
      case 0x06: {
        // alarm config: bits[2:0]=condition, bits[5:3]=alarm_type, bit6=enable
        const ctrl      = b[offset] & 0xff;
        const condType  = ctrl & 0x07;
        const alarmType = (ctrl >>> 3) & 0x07;
        const enable    = ((ctrl >>> 6) & 1) === 1 ? 'enable' : 'disable';
        const condMap: Record<number, string> = { 0:'disable',1:'below',2:'above',3:'between',4:'outside' };
        if (alarmType === 1) {
          data.temperature_alarm_config = {
            enable,
            condition:     condMap[condType] ?? 'unknown',
            threshold_min: i16(b, offset + 1) / 10,
            threshold_max: i16(b, offset + 3) / 10,
          };
        } else if (alarmType === 2) {
          data.temperature_mutation_alarm_config = {
            enable,
            mutation: i16(b, offset + 3) / 10,
          };
        }
        offset += 9; break;
      }
      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x17: data.time_zone           = tzName(i16(b, offset)); offset += 2; break;
      case 0x27: data.clear_history       = 'yes'; offset += 1; break;
      case 0x28: data.query_device_status = 'yes'; offset += 1; break;
      case 0x4a: data.sync_time           = 'yes'; offset += 1; break;
      case 0x68: data.history_enable      = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: data.retransmit_enable   = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const sub = b[offset] & 0xff;
        if (sub === 0) data.retransmit_interval = u16(b, offset + 1);
        else           data.resend_interval     = u16(b, offset + 1);
        offset += 3; break;
      }
      case 0xab:
        data.temperature_calibration_settings = {
          enable:            b[offset] === 1 ? 'enable' : 'disable',
          calibration_value: i16(b, offset + 1) / 10,
        };
        offset += 3; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':                  bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status':     bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 60)]; break;
      case 'set_report_interval':     bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 600)]; break;
      case 'set_time_zone':           bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_retransmit_enable':   bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_interval': bytes = [0xff, 0x6a, 0x00, ...wu16(params.retransmit_interval ?? 600)]; break;
      case 'set_resend_interval':     bytes = [0xff, 0x6a, 0x01, ...wu16(params.resend_interval ?? 600)]; break;

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = end === 0
          ? [0xfd, 0x6b, ...wu32(start)]
          : [0xfd, 0x6c, ...wu32(start), ...wu32(end)];
        break;
      }

      case 'set_temperature_alarm_config': {
        const condMap: Record<string, number> = { disable:0, below:1, above:2, between:3, outside:4 };
        const condVal    = condMap[params.condition ?? 'below'] ?? 1;
        const enableBit  = params.enable === 'enable' ? 1 : 0;
        const ctrl       = condVal | (1 << 3) | (enableBit << 6); // alarm_type=1 (temperature)
        const minRaw     = Math.round((params.threshold_min ?? 0) * 10);
        const maxRaw     = Math.round((params.threshold_max ?? 0) * 10);
        bytes = [0xff, 0x06, ctrl & 0xff, ...wi16(minRaw), ...wi16(maxRaw), 0, 0, 0, 0]; break;
      }

      case 'set_temperature_mutation_alarm_config': {
        const enableBit  = params.enable === 'enable' ? 1 : 0;
        const ctrl       = 5 | (2 << 3) | (enableBit << 6); // condition=5 (mutation), alarm_type=2
        const mutRaw     = Math.round((params.mutation ?? 0) * 10);
        bytes = [0xff, 0x06, ctrl & 0xff, 0, 0, ...wi16(mutRaw), 0, 0, 0, 0]; break;
      }

      case 'set_temperature_calibration': {
        const enableBit = params.enable === 'enable' ? 1 : 0;
        const calRaw    = Math.round((params.calibration_value ?? 0) * 10);
        bytes = [0xff, 0xab, enableBit, ...wi16(calRaw)]; break;
      }

      default:
        throw new Error(`TS101: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // TS101 is uniquely identified by:
  //   0x03 0x67 — temperature on channel 3 (WT series uses different channels)
  //   0x83 0x67 — temperature alarm channel
  //   0x93 0xD7 — temperature mutation alarm channel

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x03 && ty === 0x67) return true;
      if (ch === 0x83 && ty === 0x67) return true;
      if (ch === 0x93 && ty === 0xd7) return true;
    }
    return false;
  }
}