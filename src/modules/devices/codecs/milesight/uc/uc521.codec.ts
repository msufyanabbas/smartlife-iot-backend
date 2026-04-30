// src/modules/devices/codecs/milesight/uc521.codec.ts
// Milesight UC521 — Electric Valve Controller (motorized ball valve + dual pressure)
//
// Protocol: IPSO channel_id + channel_type — but several new channels vs UC511:
//
// Channel arrays:
//   valve_chns:             [0x03, 0x05] → valve_N_type + valve_N_opening (type 0xF6)
//   valve_pulse_chns:       [0x04, 0x06] → valve_N_pulse (type 0xC8)
//   gpio_chns:              [0x07, 0x08] → gpio_N (type 0x01, low/high)
//   pressure_chns:          [0x09, 0x0A] → pressure_N (type 0x7B, uint16 LE kPa)
//   pressure_alarm_chns:    [0x0B, 0x0C] → pressure_N_alarm_event (type 0xF5, 9B)
//   valve_exception_chns:   [0xB3, 0xB5] → valve_N_sensor_status (type 0xF6)
//   pressure_exception_chns:[0xB9, 0xBA] → pressure_N_sensor_status (type 0x7B)
//   valve_opening_duration: [0x0E, 0x0F] → valve_N_opening_duration (type 0x01)
//
// Special channels:
//   0x0D 0xE3 — valve_N_calibration_event (4B)
//   0xFF 0x2A — custom_message (length-prefixed ASCII)
//
// Key differences from UC511:
//   - Valve status uses 0xF6 type with valve_type + opening% (not binary open/close)
//   - 3-way valve: opening>100 means direction=right, opening%=value-100
//   - Dual pressure sensors (0x09/0x0A) instead of single
//   - Dual pressure alarms (0x0B/0x0C)
//   - Valve calibration events (0x0D 0xE3)
//   - report_interval in MINUTES (0xFF 0x8E 0x00 <uint16 LE>)
//   - sync_time trailing 0xFF (not 0x00 like UC511/UC50x!)
//   - Timezone encoding uses MINUTES (not hour×10) — UTC+8 = 480
//   - 0xF9 prefix for extended downlink commands (valve task, valve config, pressure config, etc.)
//   - 0xF8 prefix for extended responses WITH result byte
//   - collection interval per-pressure via 0xF9 0x68

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Channel arrays ────────────────────────────────────────────────────────────
const VALVE_CHNS             = [0x03, 0x05];
const VALVE_PULSE_CHNS       = [0x04, 0x06];
const GPIO_CHNS              = [0x07, 0x08];
const PRESSURE_CHNS          = [0x09, 0x0a];
const PRESSURE_ALARM_CHNS    = [0x0b, 0x0c];
const VALVE_EXCEPTION_CHNS   = [0xb3, 0xb5];
const PRESSURE_EXCEPT_CHNS   = [0xb9, 0xba];
const VALVE_DURATION_CHNS    = [0x0e, 0x0f];

function inArr(arr: number[], v: number): boolean { return arr.indexOf(v) !== -1; }

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u8(b: number[], i: number): number { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }

function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

function readAscii(b: number[], i: number, len: number): string {
  let s = '';
  for (let j = i; j < i + len && j < b.length; j++) {
    if (b[j] === 0) break;
    s += String.fromCharCode(b[j]);
  }
  return s;
}
function bytesToHex(b: number[]): string {
  return b.map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join('');
}
function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let c = 0; c < hex.length; c += 2) out.push(parseInt(hex.substr(c, 2), 16));
  return out;
}

// ── UC521-specific timezone map (MINUTES not hour×10) ────────────────────────
// UC521 uses "hh*60+mm" convention: UTC+8 = 480, UTC-12 = -720
const UC521_TZ: Record<number, string> = {
  [-720]:'UTC-12',[-660]:'UTC-11',[-600]:'UTC-10',[-570]:'UTC-9:30',
  [-540]:'UTC-9', [-480]:'UTC-8', [-420]:'UTC-7', [-360]:'UTC-6',
  [-300]:'UTC-5', [-240]:'UTC-4', [-210]:'UTC-3:30',[-180]:'UTC-3',
  [-120]:'UTC-2', [-60]:'UTC-1',    [0]:'UTC',       [60]:'UTC+1',
  [120]:'UTC+2',  [180]:'UTC+3',  [210]:'UTC+3:30', [240]:'UTC+4',
  [270]:'UTC+4:30',[300]:'UTC+5', [330]:'UTC+5:30', [345]:'UTC+5:45',
  [360]:'UTC+6',  [390]:'UTC+6:30',[420]:'UTC+7',  [480]:'UTC+8',
  [540]:'UTC+9',  [570]:'UTC+9:30',[600]:'UTC+10', [630]:'UTC+10:30',
  [660]:'UTC+11', [720]:'UTC+12', [765]:'UTC+12:45',[780]:'UTC+13',
  [840]:'UTC+14',
};
function tzName(v: number): string { return UC521_TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(UC521_TZ)) if (n === name) return parseInt(k);
  return 480; // UTC+8
}

// ── Rule condition/action decoders shared with UC511 logic ───────────────────
const COND_TYPES: Record<number, string> = { 0:'none',1:'time',2:'d2d',3:'time or pulse threshold',4:'pulse threshold',5:'pressure threshold' };
const ACT_TYPES:  Record<number, string> = { 0:'none',1:'em valve control',2:'valve control',3:'report' };
const RPT_TYPES:  Record<number, string> = { 1:'valve 1',2:'valve 2',3:'custom message',4:'pressure threshold alarm' };
const REPEAT_MODES: Record<number, string> = { 0:'monthly',1:'daily',2:'weekly' };
const WEEKDAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function decodeRuleCondition(b: number[], i: number): Record<string, any> {
  const tv = b[i] & 0xff;
  const c: Record<string, any> = { type: COND_TYPES[tv] ?? 'unknown' };
  switch (tv) {
    case 1:
      c.start_time    = u32(b, i + 1);  c.end_time = u32(b, i + 5);
      c.repeat_enable = b[i + 9] === 1 ? 'enable' : 'disable';
      const rm        = b[i + 10] & 0xff;
      c.repeat_mode   = REPEAT_MODES[rm] ?? 'unknown';
      if (rm === 0 || rm === 1) c.repeat_step = u16(b, i + 11);
      else if (rm === 2) { const w: any = {}; WEEKDAYS.forEach((d, j) => { w[d] = ((b[i + 11] >>> j) & 1) ? 'enable' : 'disable'; }); c.repeat_week = w; }
      break;
    case 2: c.d2d_command = ('0' + (b[i + 2] & 0xff).toString(16)).slice(-2) + ('0' + (b[i + 1] & 0xff).toString(16)).slice(-2); break;
    case 3: c.valve_index = b[i + 1]; c.duration = u16(b, i + 2); c.pulse_threshold = u32(b, i + 4); break;
    case 4: c.valve_index = b[i + 1]; c.pulse_threshold = u32(b, i + 2); break;
    case 5: c.valve_index = b[i + 1]; c.valve_strategy = b[i + 2]; c.condition_type = b[i + 3]; c.threshold_min = u16(b, i + 4); c.threshold_max = u16(b, i + 6); break;
  }
  return c;
}

function decodeRuleAction(b: number[], i: number): Record<string, any> {
  const tv = b[i] & 0xff;
  const a: Record<string, any> = { type: ACT_TYPES[tv] ?? 'unknown' };
  switch (tv) {
    case 1: case 2:
      a.valve_index = b[i + 1]; a.valve_opening = b[i + 2];
      a.time_enable  = b[i + 3] === 1 ? 'enable' : 'disable';
      a.duration     = u32(b, i + 4);
      a.pulse_enable = b[i + 8] === 1 ? 'enable' : 'disable';
      a.pulse_threshold = u32(b, i + 9); break;
    case 3:
      a.report_type    = RPT_TYPES[b[i + 1] & 0xff] ?? 'unknown';
      a.report_content = readAscii(b, i + 2, 8);
      a.report_counts  = b[i + 11] & 0xff;
      a.threshold_release_enable = b[i + 12] === 1 ? 'enable' : 'disable'; break;
  }
  return a;
}

// ── Codec class ───────────────────────────────────────────────────────────────

export class MilesightUC521Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc521';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC521'];
  readonly modelFamily?: string = 'UC521';
  readonly protocol        = 'lorawan' as const;
  readonly category       = 'Electric Controller' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc521/uc521.png';

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
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event  = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Valve status (0x03/0x05 0xF6) — valve_type + opening% ────────────────
      // type=0 (2-way): opening 0-100%
      // type=1 (3-way): opening 0-100 = left direction; opening 101-200 = right direction, actual%=value-100
      else if (inArr(VALVE_CHNS, ch) && ty === 0xf6) {
        const id       = VALVE_CHNS.indexOf(ch) + 1;
        const vtype    = bytes[i] & 0xff;
        const vopening = bytes[i + 1] & 0xff;
        const typeMap: Record<number, string> = { 0: '2_way_ball_valve', 1: '3_way_ball_valve' };
        decoded[`valve_${id}_type`] = typeMap[vtype] ?? 'unknown';
        if (vtype === 0) {
          decoded[`valve_${id}_opening`] = vopening;
        } else {
          // 3-way: >100 = right direction
          if (vopening > 100) {
            decoded[`valve_${id}_opening`]   = vopening - 100;
            decoded[`valve_${id}_direction`] = 'right';
          } else {
            decoded[`valve_${id}_opening`]   = vopening;
            decoded[`valve_${id}_direction`] = 'left';
          }
        }
        i += 2;
      }

      // ── Valve pulse (0x04/0x06 0xC8) ─────────────────────────────────────────
      else if (inArr(VALVE_PULSE_CHNS, ch) && ty === 0xc8) {
        const id = VALVE_PULSE_CHNS.indexOf(ch) + 1;
        decoded[`valve_${id}_pulse`] = u32(bytes, i); i += 4;
      }

      // ── GPIO (0x07/0x08 0x01) — low/high ─────────────────────────────────────
      else if (inArr(GPIO_CHNS, ch) && ty === 0x01) {
        const id = ch - GPIO_CHNS[0] + 1;
        decoded[`gpio_${id}`] = bytes[i] === 1 ? 'high' : 'low'; i += 1;
      }

      // ── Pressure (0x09/0x0A 0x7B) — uint16 LE kPa ────────────────────────────
      else if (inArr(PRESSURE_CHNS, ch) && ty === 0x7b) {
        const id = PRESSURE_CHNS.indexOf(ch) + 1;
        decoded[`pressure_${id}`] = u16(bytes, i); i += 2;
      }

      // ── Pressure alarm (0x0B/0x0C 0xF5) — 9B ────────────────────────────────
      // source(1) + condition(1) + min(2) + max(2) + pressure(2) + alarm(1)
      else if (inArr(PRESSURE_ALARM_CHNS, ch) && ty === 0xf5) {
        const id = PRESSURE_ALARM_CHNS.indexOf(ch) + 1;
        const srcMap: Record<number, string>  = { 0:'every change',1:'valve 1 opening',2:'valve 2 opening',3:'valve 1 opening or valve 2 opening' };
        const condMap: Record<number, string> = { 0:'none',1:'below',2:'above',3:'between',4:'outside' };
        const srcVal   = bytes[i] & 0xff;
        const condVal  = bytes[i + 1] & 0xff;
        const minVal   = u16(bytes, i + 2);
        const maxVal   = u16(bytes, i + 4);
        const pVal     = u16(bytes, i + 6);
        const alarmVal = bytes[i + 8] & 0xff;
        const event: Record<string, any> = {
          source:    srcMap[srcVal] ?? 'unknown',
          condition: condMap[condVal] ?? 'unknown',
          pressure:  pVal,
          alarm:     alarmVal === 1 ? 'pipe pressure threshold alarm' : 'pipe pressure threshold alarm release',
        };
        if (condVal === 1 || condVal === 3 || condVal === 4) event.threshold_min = minVal;
        if (condVal === 2 || condVal === 3 || condVal === 4) event.threshold_max = maxVal;
        decoded[`pressure_${id}`]            = pVal;
        decoded[`pressure_${id}_alarm_event`] = event;
        i += 9;
      }

      // ── Valve calibration event (0x0D 0xE3) — 4B ─────────────────────────────
      else if (ch === 0x0d && ty === 0xe3) {
        const vIdx  = (bytes[i] & 0xff) + 1;
        decoded[`valve_${vIdx}_calibration_event`] = {
          source_value: bytes[i + 1] & 0xff,
          target_value: bytes[i + 2] & 0xff,
          result:       bytes[i + 3] === 1 ? 'success' : 'failed',
        };
        i += 4;
      }

      // ── Valve sensor status (0xB3/0xB5 0xF6) — 2B ────────────────────────────
      else if (inArr(VALVE_EXCEPTION_CHNS, ch) && ty === 0xf6) {
        const id = VALVE_EXCEPTION_CHNS.indexOf(ch) + 1;
        const typeMap: Record<number, string>   = { 0:'2_way_ball_valve',1:'3_way_ball_valve' };
        const statusMap: Record<number, string> = { 0:'low battery power',1:'shutdown after getting io feedback',2:'incorrect opening time',3:'timeout',4:'valve stall' };
        decoded[`valve_${id}_type`]          = typeMap[bytes[i] & 0xff] ?? 'unknown';
        decoded[`valve_${id}_sensor_status`] = statusMap[bytes[i + 1] & 0xff] ?? 'unknown';
        i += 2;
      }

      // ── Pressure sensor exception (0xB9/0xBA 0x7B) — 1B ─────────────────────
      else if (inArr(PRESSURE_EXCEPT_CHNS, ch) && ty === 0x7b) {
        const id = PRESSURE_EXCEPT_CHNS.indexOf(ch) + 1;
        decoded[`pressure_${id}_sensor_status`] = bytes[i] === 1 ? 'read error' : 'unknown'; i += 1;
      }

      // ── Valve opening duration (0x0E/0x0F 0x01) — 1B, seconds ───────────────
      else if (inArr(VALVE_DURATION_CHNS, ch) && ty === 0x01) {
        const id = VALVE_DURATION_CHNS.indexOf(ch) + 1;
        decoded[`valve_${id}_opening_duration`] = bytes[i] & 0xff; i += 1;
      }

      // ── Custom message (0xFF 0x2A) — length-prefixed ASCII ───────────────────
      else if (ch === 0xff && ty === 0x2a) {
        const len = bytes[i] & 0xff;
        decoded.custom_message = readAscii(bytes, i + 1, len);
        i += len + 1;
      }

      // ── Downlink responses (0xFF/0xFE) ───────────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended responses (0xF8=with result byte, 0xF9=without) ─────────────
      else if (ch === 0xf8 || ch === 0xf9) {
        const result = this.handleDownlinkExt(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const RULE_BITS = Array.from({length: 16}, (_, j) => `rule_${j + 1}`);
    switch (ty) {
      case 0x10: data.reboot       = 'yes'; offset += 1; break;
      case 0x1e: data.class_a_response_time = u32(b, offset); offset += 4; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x35: data.d2d_key       = bytesToHex(b.slice(offset, offset + 8)); offset += 8; break;
      case 0x46: data.gpio_jitter_time = b[offset] & 0xff; offset += 1; break;
      case 0x4a: data.sync_time     = 'yes'; offset += 1; break;
      case 0x4b: {
        const op = b[offset] & 0xff;
        const mask = u16(b, offset + 1);
        if (op === 0) { data.batch_read_rules = {}; RULE_BITS.forEach((k, j) => { data.batch_read_rules[k] = ((mask >>> j) & 1) ? 'yes' : 'no'; }); }
        else if (op === 1) { data.batch_enable_rules = {}; RULE_BITS.forEach((k, j) => { data.batch_enable_rules[k] = ((mask >>> j) & 1) ? 'enable' : 'disable'; }); }
        else if (op === 2) { data.batch_remove_rules = {}; RULE_BITS.forEach((k, j) => { data.batch_remove_rules[k] = ((mask >>> j) & 1) ? 'yes' : 'no'; }); }
        else if (op === 3) { const ri = b[offset + 1] & 0xff; data[`rule_${ri}_enable`] = b[offset + 2] === 1 ? 'enable' : 'disable'; }
        else if (op === 4) { const ri = b[offset + 1] & 0xff; data[`rule_${ri}_remove`] = 'yes'; }
        offset += 3; break;
      }
      case 0x4e: { const vi = b[offset] & 0xff; data[`clear_valve_${vi}_pulse`] = 'yes'; offset += 2; break; }
      case 0x52: {
        const modeMap: Record<number, string> = { 1:'hardware',2:'software' };
        data.valve_filter_config = { mode: modeMap[b[offset + 1] & 0xff] ?? 'unknown', time: u16(b, offset + 2) };
        offset += 4; break;
      }
      case 0x53: { const ri = b[offset] & 0xff; if (!data.query_rule_config) data.query_rule_config = {}; data.query_rule_config[`rule_${ri}`] = 'yes'; offset += 1; break; }
      case 0x55: {
        const rc = { id: b[offset] & 0xff, enable: b[offset + 1] === 1 ? 'enable' : 'disable', condition: decodeRuleCondition(b, offset + 2), action: decodeRuleAction(b, offset + 15) };
        if (!data.rules_config) data.rules_config = [];
        data.rules_config.push(rc); offset += 29; break;
      }
      case 0x84: data.d2d_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break; // skip type byte
      case 0x92: { const vi = b[offset] & 0xff; data[`valve_${vi}_pulse`] = u32(b, offset + 1); offset += 5; break; }
      case 0xbd: data.time_zone = tzName(i16(b, offset)); offset += 2; break;
      case 0xf3: data.response_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleDownlinkExt(code: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const typeMap: Record<number, string> = { 0:'2_way_ball_valve',1:'3_way_ball_valve' };

    switch (ty) {
      case 0x19: { // valve task
        const ctrl = b[offset] & 0xff;
        const vi   = (ctrl & 0x01) + 1;
        const tce  = (ctrl >>> 7) & 1; // time_control_enable
        const vpe  = (ctrl >>> 6) & 1; // valve_pulse_control_enable
        const vt: Record<string, any> = {
          time_control_enable:        tce === 1 ? 'enable' : 'disable',
          valve_pulse_control_enable: vpe === 1 ? 'enable' : 'disable',
          task_id:     b[offset + 1] & 0xff,
          valve_opening: b[offset + 2] & 0xff,
        };
        let off = offset + 3;
        if (tce === 1) { vt.time  = u16(b, off); off += 2; }
        if (vpe === 1) { vt.pulse = u32(b, off); off += 4; }
        data[`valve_${vi}_task`] = vt;
        offset = off; break;
      }
      case 0x1a: { // valve config
        const ctrl = b[offset] & 0xff;
        const vi   = ((ctrl >>> 7) & 1) + 1;
        const vc: Record<string, any> = {
          valve_type:                      typeMap[(ctrl >>> 6) & 1] ?? 'unknown',
          auto_calibration_enable:         ((ctrl >>> 5) & 1) === 1 ? 'enable' : 'disable',
          report_after_calibration_enable: ((ctrl >>> 4) & 1) === 1 ? 'enable' : 'disable',
          stall_strategy:                  ((ctrl >>> 3) & 1) === 1 ? 'keep' : 'close',
          open_time_1:     b[offset + 1] & 0xff,
          open_time_2:     b[offset + 2] & 0xff,
          stall_current:   u16(b, offset + 3),
          stall_time:      u16(b, offset + 5),
          protect_time:    b[offset + 7] & 0xff,
          close_delay_time: b[offset + 8] & 0xff,
          open_delay_time:  b[offset + 9] & 0xff,
        };
        data[`valve_${vi}_config`] = vc;
        offset += 10; break;
      }
      case 0x5b: { // pressure calibration
        const pi  = b[offset] & 0xff;
        data[`pressure_${pi}_calibration_settings`] = {
          enable:            b[offset + 1] === 1 ? 'enable' : 'disable',
          calibration_value: i16(b, offset + 2),
        };
        offset += 4; break;
      }
      case 0x68: { // pressure collection interval
        const pi = b[offset] & 0xff;
        data[`pressure_${pi}_collection_interval`] = {
          enable:              b[offset + 1] === 1 ? 'enable' : 'disable',
          collection_interval: u16(b, offset + 2),
        };
        offset += 4; break;
      }
      case 0x6e: data.wiring_switch_enable      = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6f: data.valve_change_report_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x70: { // query_valve_opening_duration response
        const vi = b[offset] & 0xff;
        if (!data.query_valve_opening_duration) data.query_valve_opening_duration = {};
        data.query_valve_opening_duration[`valve_${vi}`] = 'yes';
        offset += 1; break;
      }
      case 0x71: { // gpio type
        const gi = b[offset] & 0xff;
        const gtMap: Record<number, string> = { 0:'counter',1:'feedback' };
        data[`gpio_${gi}_type`] = gtMap[b[offset + 1] & 0xff] ?? 'unknown';
        offset += 2; break;
      }
      case 0x72: data.query_device_config               = 'yes'; offset += 1; break;
      case 0x73: data.query_pressure_calibration_settings = 'yes'; offset += 1; break;
      case 0x74: data.query_gpio_type                   = 'yes'; offset += 1; break;
      case 0x75: data.query_valve_config                = 'yes'; offset += 1; break;
      case 0x76: { // pressure config
        const pi = b[offset] & 0xff;
        const unitMap: Record<number, string>       = { 0:'kPa',1:'Bar',2:'MPa' };
        const modeMap: Record<number, string>       = { 0:'standard',1:'custom' };
        const sigMap: Record<number, string>        = { 0:'voltage',1:'current' };
        data[`pressure_${pi}_config`] = {
          enable:              b[offset + 1] === 1 ? 'enable' : 'disable',
          collection_interval: u16(b, offset + 2),
          display_unit:        unitMap[b[offset + 4] & 0xff] ?? 'unknown',
          mode:                modeMap[b[offset + 5] & 0xff] ?? 'unknown',
          signal_type:         sigMap[b[offset + 6] & 0xff] ?? 'unknown',
          osl:                 u16(b, offset + 7),
          osh:                 u16(b, offset + 9),
          power_supply_time:   u16(b, offset + 11),
          range_min:           u16(b, offset + 13),
          range_max:           u16(b, offset + 15),
        };
        offset += 17; break;
      }
      case 0x77: data.query_pressure_config = 'yes'; offset += 1; break;
      default: offset += 1; break;
    }

    // 0xF8 prefix includes a trailing result byte
    if (code === 0xf8) {
      const rv = b[offset] & 0xff;
      offset += 1;
      if (rv !== 0) {
        const resultMap: Record<number, string> = { 0:'success',1:'forbidden',2:'invalid parameter' };
        const req = { ...data }; Object.keys(data).forEach(k => delete data[k]);
        data.device_response_result = { channel_type: ty, result: resultMap[rv] ?? 'unknown', request: req };
      }
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':                  bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      // UC521: sync_time uses trailing 0xFF (different from UC511 which uses 0x00)
      case 'sync_time':               bytes = [0xff, 0x4a, 0xff]; break;
      // UC521: report_interval in MINUTES via 0xFF 0x8E 0x00 <uint16>
      case 'set_report_interval':     bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 20)]; break;
      case 'set_time_zone':           bytes = [0xff, 0xbd, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_d2d_enable':          bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_d2d_key':             bytes = [0xff, 0x35, ...hexToBytes(params.d2d_key ?? '0000000000000000')]; break;
      case 'set_response_enable':     bytes = [0xff, 0xf3, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_class_a_response_time': bytes = [0xff, 0x1e, ...wu32(params.class_a_response_time ?? 0)]; break;
      case 'set_gpio_jitter_time':    bytes = [0xff, 0x46, params.gpio_jitter_time & 0xff]; break;
      case 'set_valve_filter_config': {
        const modeMap: Record<string, number> = { hardware: 1, software: 2 };
        bytes = [0xff, 0x52, 0x00, modeMap[params.mode] ?? 1, ...wu16(params.time ?? 10)]; break;
      }
      case 'batch_read_rules':   { const m = this.encodeRuleMask(params, 'yes'); bytes = [0xff, 0x4b, 0x00, ...wu16(m)]; break; }
      case 'batch_enable_rules': { const m = this.encodeRuleMask(params, 'enable'); bytes = [0xff, 0x4b, 0x01, ...wu16(m)]; break; }
      case 'batch_remove_rules': { const m = this.encodeRuleMask(params, 'yes'); bytes = [0xff, 0x4b, 0x02, ...wu16(m)]; break; }
      case 'enable_rule':   bytes = [0xff, 0x4b, 0x03, params.rule_index & 0xff, params.enable === 'enable' ? 1 : 0]; break;
      case 'remove_rule':   bytes = [0xff, 0x4b, 0x04, params.rule_index & 0xff, 0x00]; break;
      case 'query_rule_config': bytes = [0xff, 0x53, params.rule_index & 0xff]; break;
      case 'set_valve_pulse': bytes = [0xff, 0x92, params.index & 0xff, ...wu32(params.pulse ?? 0)]; break;
      case 'clear_valve_pulse': bytes = [0xff, 0x4e, params.index & 0xff, 0x00]; break;

      // 0xF9-prefixed commands
      case 'set_valve_task': {
        const p  = params;
        const vi = (p.valve_index ?? 1) - 1; // 0-based in wire format
        const tce = 'time'  in p ? 1 : 0;
        const vpe = 'pulse' in p ? 1 : 0;
        const ctrl = (tce << 7) | (vpe << 6) | vi;
        const base = [0xf9, 0x19, ctrl & 0xff, p.task_id ?? 0, p.valve_opening ?? 0];
        const ext: number[] = [];
        if (tce) ext.push(...wu16(p.time ?? 0));
        if (vpe) ext.push(...wu32(p.pulse ?? 0));
        bytes = [...base, ...ext]; break;
      }
      case 'set_valve_config': {
        const p  = params;
        const vi = (p.valve_index ?? 1) - 1; // 0-based
        const typeMap: Record<string, number>  = { '2_way_ball_valve': 0, '3_way_ball_valve': 1 };
        const stallMap: Record<string, number> = { close: 0, keep: 1 };
        const ctrl = (vi << 7) | ((typeMap[p.valve_type] ?? 0) << 6) |
          ((p.auto_calibration_enable === 'enable' ? 1 : 0) << 5) |
          ((p.report_after_calibration_enable === 'enable' ? 1 : 0) << 4) |
          ((stallMap[p.stall_strategy] ?? 0) << 3);
        bytes = [0xf9, 0x1a, ctrl & 0xff, p.open_time_1 ?? 0, p.open_time_2 ?? 0,
          ...wu16(p.stall_current ?? 0), ...wu16(p.stall_time ?? 0),
          p.protect_time ?? 0, p.close_delay_time ?? 0, p.open_delay_time ?? 0]; break;
      }
      case 'set_pressure_calibration': {
        bytes = [0xf9, 0x5b, params.pressure_index & 0xff,
          params.enable === 'enable' ? 1 : 0, ...wi16(params.calibration_value ?? 0)]; break;
      }
      case 'set_pressure_collection_interval': {
        bytes = [0xf9, 0x68, params.pressure_index & 0xff,
          params.enable === 'enable' ? 1 : 0, ...wu16(params.collection_interval ?? 300)]; break;
      }
      case 'set_wiring_switch_enable':      bytes = [0xf9, 0x6e, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_valve_change_report_enable': bytes = [0xf9, 0x6f, params.enable === 'enable' ? 1 : 0]; break;
      case 'query_valve_opening_duration': {
        const out: number[] = [];
        if (params.valve_1 === 'yes') out.push(0xf9, 0x70, 0x01);
        if (params.valve_2 === 'yes') out.push(0xf9, 0x70, 0x02);
        bytes = out; break;
      }
      case 'set_gpio_type': bytes = [0xf9, 0x71, params.index & 0xff, params.gpio_type === 'feedback' ? 1 : 0]; break;
      case 'query_device_config':                bytes = [0xf9, 0x72, 0xff]; break;
      case 'query_pressure_calibration_settings': bytes = [0xf9, 0x73, 0xff]; break;
      case 'query_gpio_type':                    bytes = [0xf9, 0x74, 0xff]; break;
      case 'query_valve_config':                 bytes = [0xf9, 0x75, 0xff]; break;
      case 'query_pressure_config':              bytes = [0xf9, 0x77, 0xff]; break;
      case 'set_pressure_config': {
        const p  = params;
        const pi = p.pressure_index & 0xff;
        const unitMap: Record<string, number> = { kPa: 0, Bar: 1, MPa: 2 };
        const modeMap: Record<string, number> = { standard: 0, custom: 1 };
        const sigMap:  Record<string, number> = { voltage: 0, current: 1 };
        bytes = [0xf9, 0x76, pi, p.enable === 'enable' ? 1 : 0,
          ...wu16(p.collection_interval ?? 1000),
          unitMap[p.display_unit] ?? 0, modeMap[p.mode] ?? 0, sigMap[p.signal_type] ?? 0,
          ...wu16(p.osl ?? 0), ...wu16(p.osh ?? 0),
          ...wu16(p.power_supply_time ?? 0), ...wu16(p.range_min ?? 0), ...wu16(p.range_max ?? 0)]; break;
      }
      default: throw new Error(`UC521: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  private encodeRuleMask(params: any, trueVal: string): number {
    let mask = 0;
    for (let j = 1; j <= 16; j++) { if (params[`rule_${j}`] === trueVal) mask |= (1 << (j - 1)); }
    return mask;
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC521 is uniquely identified by:
  //   0x03/0x05 0xF6 — valve channels with 0xF6 type (unique to UC521)
  //   0x09/0x0A 0x7B — dual pressure channels
  //   0x0B/0x0C 0xF5 — dual pressure alarm channels
  //   0x0D 0xE3      — valve calibration event

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (inArr(VALVE_CHNS, ch) && ty === 0xf6) return true;     // valve 0xF6 type
      if (inArr(PRESSURE_CHNS, ch) && ty === 0x7b) return true;  // dual pressure
      if (inArr(PRESSURE_ALARM_CHNS, ch) && ty === 0xf5) return true;
      if (ch === 0x0d && ty === 0xe3) return true;               // calibration event
    }
    return false;
  }
}