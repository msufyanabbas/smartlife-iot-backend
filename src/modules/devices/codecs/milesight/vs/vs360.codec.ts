// src/modules/devices/codecs/milesight/vs360.codec.ts
// Milesight VS360 — IR BreakBeam People Counter (dual-unit: main + node)
//
// Unique vs VS350/351:
//   0x01 0x75 — battery_main (uint8 %)
//   0x02 0x75 — battery_node (uint8 %)  ← unique fingerprint
//   0x03 0xF4 — event: event_type(1B) + event_status(1B)
//               event_type: 0=counting_anomaly, 1=node_device_without_response, 2=devices_misaligned
//               event_status: 0=alarm_release, 1=alarm
//   No temperature channel
//   hibernate_config 0x75 adds weekday bitmask byte (replaces VS351's 0xFF trailing byte)
//   counting_mode 0xFF (2=high_mode, 3=low_mode) — new
//   led_indicator_enable 0xFD — new
//   D2D modes: 1=someone_enter, 2=someone_leave, 3=counting_threshold_alarm only (no temp modes)
//   alarm config: only period (src=1) and cumulative (src=2), no temperature (src=3)
//
// Shared with VS350/351:
//   0x04 0xCC / 0x05 0xCC — total/period IN/OUT
//   0x84 0xCC / 0x85 0xCC — alarms
//   0x20 0xCE — history (same type0/type1 format)
//   0x0A 0xEF — timestamp
//   Downlinks: 0xFF 0x8E report_interval, 0xFF 0x68 history, 0xFF 0x69 retransmit,
//              0xFF 0x6A interval, 0xFF 0xBD timezone, 0xFF 0xA6/A8/A9 cumulative,
//              0xFF 0xED schedule, 0xFF 0x96 d2d, 0xFD 0x6B/6C/6D history fetch/stop

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Shared timezone map (reused from VS350) ───────────────────────────────────
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

// Weekday bitmask: bit1=monday … bit7=sunday
const WEEKDAY_BITS: Record<string, number> = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
};

export class MilesightVS360Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs360';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS360'];
  readonly protocol        = 'lorawan' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/vs-series/vs351/vs351.png';

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

      // ── Battery main (0x01 0x75) ──────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery_main  = bytes[i] & 0xff;
        decoded.batteryLevel  = decoded.battery_main;
        i += 1;
      }

      // ── Battery node (0x02 0x75) — VS360 unique ───────────────────────────
      else if (ch === 0x02 && ty === 0x75) {
        decoded.battery_node = bytes[i] & 0xff; i += 1;
      }

      // ── Event (0x03 0xF4) — VS360 unique ─────────────────────────────────
      else if (ch === 0x03 && ty === 0xf4) {
        const eventTypeMap: Record<number, string> = {
          0: 'counting_anomaly', 1: 'node_device_without_response', 2: 'devices_misaligned',
        };
        const eventStatusMap: Record<number, string> = { 0: 'alarm_release', 1: 'alarm' };
        const entry = {
          type:   eventTypeMap[bytes[i]]     ?? 'unknown',
          status: eventStatusMap[bytes[i + 1]] ?? 'unknown',
        };
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry);
        i += 2;
      }

      // ── Total IN/OUT (0x04 0xCC) ──────────────────────────────────────────
      else if (ch === 0x04 && ty === 0xcc) {
        decoded.total_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // ── Period IN/OUT (0x05 0xCC) ─────────────────────────────────────────
      else if (ch === 0x05 && ty === 0xcc) {
        decoded.period_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // ── Timestamp (0x0A 0xEF) ─────────────────────────────────────────────
      else if (ch === 0x0a && ty === 0xef) {
        decoded.timestamp = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // ── Total IN/OUT alarm (0x84 0xCC) ────────────────────────────────────
      else if (ch === 0x84 && ty === 0xcc) {
        decoded.total_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.total_count_alarm = bytes[i + 4] === 1 ? 'threshold_alarm' : 'alarm_release';
        i += 5;
      }

      // ── Period IN/OUT alarm (0x85 0xCC) ───────────────────────────────────
      else if (ch === 0x85 && ty === 0xcc) {
        decoded.period_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.period_count_alarm = bytes[i + 4] === 1 ? 'threshold_alarm' : 'alarm_release';
        i += 5;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        const type = bytes[i + 4];
        const entry: Record<string, any> = { timestamp: ts };
        if (type === 0) {
          entry.period_in  = ((bytes[i + 6] << 8) | bytes[i + 5]) & 0xffff;
          entry.period_out = ((bytes[i + 8] << 8) | bytes[i + 7]) & 0xffff;
          i += 9;
        } else if (type === 1) {
          entry.period_in  = ((bytes[i +  6] << 8) | bytes[i +  5]) & 0xffff;
          entry.period_out = ((bytes[i +  8] << 8) | bytes[i +  7]) & 0xffff;
          entry.total_in   = ((bytes[i + 10] << 8) | bytes[i +  9]) & 0xffff;
          entry.total_out  = ((bytes[i + 12] << 8) | bytes[i + 11]) & 0xffff;
          i += 13;
        } else {
          i += 5;
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
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
    const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };

    switch (ty) {
      case 0x06: {
        const byte0 = bytes[offset] & 0xff;
        const cond  = condMap[byte0 & 0x07] ?? 'unknown';
        const src   = (byte0 >>> 3) & 0x07;
        if (src === 1) {
          data.people_period_alarm_config = {
            condition: cond, threshold_out: u16(offset + 1), threshold_in: u16(offset + 3),
          };
        } else if (src === 2) {
          data.people_cumulative_alarm_config = {
            condition: cond, threshold_out: u16(offset + 1), threshold_in: u16(offset + 3),
          };
        }
        offset += 9; break;
      }
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x28:
        data.report_status = 'yes'; offset += 1; break;
      case 0x35:
        data.d2d_key = bytes.slice(offset, offset + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        offset += 8; break;
      case 0x4a:
        data.sync_time = 'yes'; offset += 1; break;
      case 0x68:
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69:
        data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const t = bytes[offset] & 0xff;
        if (t === 0) data.retransmit_interval = u16(offset + 1);
        else         data.resend_interval     = u16(offset + 1);
        offset += 3; break;
      }
      case 0x6d:
        data.stop_transmit = 'yes'; offset += 1; break;
      case 0x75: {
        // hibernate_config: enable(1) + start(2) + end(2) + weekdays bitmask(1) = 6B
        const wdByte = bytes[offset + 5] & 0xff;
        const weekdays: Record<string, string> = {};
        for (const [day, bit] of Object.entries(WEEKDAY_BITS)) {
          weekdays[day] = ((wdByte >>> bit) & 1) === 1 ? 'enable' : 'disable';
        }
        data.hibernate_config = {
          enable:     bytes[offset] === 1 ? 'enable' : 'disable',
          start_time: u16(offset + 1),
          end_time:   u16(offset + 3),
          weekdays,
        };
        offset += 6; break;
      }
      case 0x84:
        data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e:
        data.report_interval = u16(offset + 1); offset += 3; break;
      case 0x96: {
        const modeMap: Record<number, string> = {
          1: 'someone_enter', 2: 'someone_leave', 3: 'counting_threshold_alarm',
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
      case 0xa6:
        data.reset_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xa8: {
        const t = bytes[offset] & 0xff;
        if (t === 0x01) data.reset_cumulative_in  = 'yes';
        else            data.reset_cumulative_out = 'yes';
        offset += 1; break;
      }
      case 0xa9:
        data.report_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xbd:
        data.time_zone = tzName(i16(offset)); offset += 2; break;
      case 0xed: {
        const wdMap: Record<number, string> = { 0: 'everyday', 1: 'sunday', 2: 'monday', 3: 'tuesday', 4: 'wednesday', 5: 'thursday', 6: 'friday', 7: 'saturday' };
        data.reset_cumulative_schedule_config = {
          weekday: wdMap[bytes[offset]] ?? 'unknown',
          hour:    bytes[offset + 1] & 0xff,
          minute:  bytes[offset + 2] & 0xff,
        };
        offset += 3; break;
      }
      case 0xfc: {
        const modeMap: Record<number, string> = { 2: 'high_mode', 3: 'low_mode' };
        data.counting_mode = modeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0xfd:
        data.led_indicator_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      default:
        offset += 1; break;
    }
    return { data, offset };
  }

  private handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x10: {
        const typeMap: Record<number, string> = { 0: 'period', 1: 'immediately' };
        data.report_type = typeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      default:
        offset += 1; break;
    }
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
    const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
    const hexBytes = (hex: string) => { const o: number[] = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
    const d2dCmd  = (cmd: string) => [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];

    switch (type) {
      case 'reboot':         bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':  bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':      bytes = [0xff, 0x4a, 0xff]; break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        bytes = [0xff, 0x8e, 0x00, ...u16(v)]; break;
      }

      case 'set_report_type': {
        const m: Record<string, number> = { period: 0, immediately: 1 };
        bytes = [0xf9, 0x10, m[params.report_type ?? 'period'] ?? 0]; break;
      }

      case 'set_time_zone': {
        bytes = [0xff, 0xbd, ...i16(tzValue(params.time_zone ?? 'UTC+3'))]; break;
      }

      case 'set_report_cumulative_enable':
        bytes = [0xff, 0xa9, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_reset_cumulative_enable':
        bytes = [0xff, 0xa6, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_reset_cumulative_schedule': {
        const wdMap: Record<string, number> = { everyday: 0, sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7 };
        const wd  = wdMap[params.weekday ?? 'everyday'] ?? 0;
        const hr  = params.hour   ?? 0;
        const min = params.minute ?? 0;
        bytes = [0xff, 0xed, wd, hr, min]; break;
      }

      case 'reset_cumulative_in':  bytes = [0xff, 0xa8, 0x01]; break;
      case 'reset_cumulative_out': bytes = [0xff, 0xa8, 0x02]; break;

      case 'set_counting_mode': {
        const modeMap: Record<string, number> = { high_mode: 2, low_mode: 3 };
        const v = modeMap[params.counting_mode ?? 'high_mode'] ?? 2;
        bytes = [0xff, 0xfc, v]; break;
      }

      case 'set_led_indicator_enable':
        bytes = [0xff, 0xfd, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_hibernate_config': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const start  = params.start_time ?? 0;
        const end    = params.end_time   ?? 0;
        // build weekday bitmask
        let wdByte = 0;
        const weekdays = params.weekdays ?? {};
        for (const [day, bit] of Object.entries(WEEKDAY_BITS)) {
          if (weekdays[day] === 'enable') wdByte |= (1 << bit);
        }
        bytes = [0xff, 0x75, enable, ...u16(start), ...u16(end), wdByte]; break;
      }

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexBytes(key)]; break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = {
          someone_enter: 1, someone_leave: 2, counting_threshold_alarm: 3,
        };
        const mode       = modeMap[params.mode ?? 'someone_enter'] ?? 1;
        const enable     = params.enable             === 'enable' ? 1 : 0;
        const loraUplink = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd        = params.d2d_cmd ?? '0000';
        const time       = params.time ?? 0;
        const timeEnable = params.time_enable === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [0xff, 0x96, mode, enable, loraUplink, ...d2dCmd(cmd), ...u16(time), timeEnable]; break;
      }

      case 'set_people_period_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x01 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte, ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0), 0, 0, 0, 0]; break;
      }

      case 'set_people_cumulative_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x02 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte, ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0), 0, 0, 0, 0]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('retransmit_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x00, ...u16(v)]; break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 60;
        if (v < 30 || v > 1200) throw new Error('resend_interval must be 30–1200');
        bytes = [0xff, 0x6a, 0x01, ...u16(v)]; break;
      }

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = end === 0
          ? [0xfd, 0x6b, ...u32(start)]
          : [0xfd, 0x6c, ...u32(start), ...u32(end)];
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff]; break;

      default:
        throw new Error(`VS360: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS360 is uniquely identified by:
  //   0x02 0x75 — battery_node (no other VS series has this)
  //   0x03 0xF4 — event channel

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x02 && ty === 0x75) return true; // battery_node: VS360 unique
      if (ch === 0x03 && ty === 0xf4) return true; // event: VS360 unique
    }
    return false;
  }
}