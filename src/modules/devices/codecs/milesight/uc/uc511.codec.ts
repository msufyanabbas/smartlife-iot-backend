// src/modules/devices/codecs/milesight/uc511.codec.ts
// Milesight UC511/UC512 — Solenoid Valve Controller
//
// Protocol: IPSO channel_id + channel_type
//
// Telemetry channels:
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//   0x01 0x75 — battery (uint8 %)
//   0x03 0x01 — valve_1 (1B: 0=close, 1=open, 0xFF=delay control result)
//   0x04 0xC8 — valve_1_pulse (uint32 LE)
//   0x05 0x01 — valve_2 (1B: 0=close, 1=open, 0xFF=delay control result)
//   0x06 0xC8 — valve_2_pulse (uint32 LE)
//   0x07 0x01 — gpio_1 (1B: 0=off, 1=on)
//   0x08 0x01 — gpio_2 (1B: 0=off, 1=on)
//   0x09 0x7B — pressure (uint16 LE, kPa)
//   0xB9 0x7B — pressure_sensor_status (1B)
//   0xFF 0x12 — custom_message (ASCII to end of payload)
//   0x20 0xCE — history entry (9B): ts(4)+status(1)+pulse(4)
//   0x21 0xCE — history pipe pressure (6B): ts(4)+pressure(2)
//   0x0B 0xF5 — pressure_threshold_alarm (9B)
//   0xF8 0xA4 — lorawan_class_switch_response (8B)
//   0xF8 0xA5 — query_valve_task_status_response (2B)
//   0xF8 0xA8 — set_ai_collection_config_response (9B)
//   0xF9 0xA7 — schedule_device_config_response (3B)
//   0xF9 0xA8 — set_ai_collection_config (7B)
//   0x0E 0xAF — valve_1_task_status (3B)
//   0x0F 0xAF — valve_2_task_status (3B)
//   0xF8 0xAF — read_schedule_config_response (3B)
//   0xF0 ??  — multicast_command_response (10B)
//   0xFE/0xFF — downlink responses (delegated to handler)
//
// Downlink commands:
//   0xFF 0x10 — reboot
//   0xFF 0x28 — report_status
//   0xFF 0x4A 0x00 — sync_time
//   0xFF 0x02 — set_collection_interval (uint16 LE)
//   0xFF 0x03 — set_report_interval (uint16 LE)
//   0xFF 0x69 — set_retransmit_enable
//   0xFF 0x6A 0x00 — set_retransmit_interval (uint16 LE)
//   0xFF 0x6A 0x01 — set_resend_interval (uint16 LE)
//   0xFF 0x17 — set_time_zone (int16 LE)
//   0xFF 0x3B — set_sync_time_type
//   0xFF 0x35 — set_d2d_key (8B)
//   0xFF 0x84 — set_d2d_enable
//   0xFF 0xF3 — set_response_enable
//   0xFF 0x1E — set_class_a_response_time (uint32 LE)
//   0xFF 0x92 0x01/02 — set_valve_pulse (uint32 LE)
//   0xFF 0x1D — set_valve_task (ctrl+sequence_id+duration+pulse/start_time)
//   0xFF 0x4B — batch_rules (read/enable/remove/single)
//   0xFF 0x4C — query_rule_config
//   0xFF 0x4D — set_rule_config (legacy hw v2+)
//   0xFF 0x55 — set_new_rule_config (hw v4+)
//   0xFF 0x4E — clear_valve_pulse
//   0xFF 0x52 — set_pulse_filter_config
//   0xFF 0x46 — set_gpio_jitter_time
//   0xFF 0x4F — set_valve_power_supply_config
//   0xFF 0xAB — set_pressure_calibration
//   0xFF 0x68 — set_history_enable
//   0xFF 0x27 — clear_history
//   0xFD 0x6B/0x6C — fetch_history
//   0xFD 0x6D — stop_transmit
//   0xF9 0xA4 — set_lorawan_class_switch
//   0xF9 0xA5 — query_valve_task_status
//   0xF9 0xA6 — set_schedule_device_config
//   0xF9 0xA8 — set_ai_collection_config
//   0xF9 0xAF — read_schedule_config
//   0xF0 — multicast_command

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u8(b: number[], i: number): number { return b[i] & 0xff; }
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u24(b: number[], i: number): number { return ((b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) & 0xffffff; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function i32(b: number[], i: number): number { const v = u32(b, i); return v > 0x7fffffff ? v - 0x100000000 : v; }

function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu24(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

function readAscii(b: number[], i: number, len: number): string {
  let s = '';
  for (let j = i; j < i + len && j < b.length; j++) {
    if (b[j] !== 0) s += String.fromCharCode(b[j]);
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

// ── Rule condition decoder ────────────────────────────────────────────────────
const CONDITION_TYPES: Record<number, string> = {
  0: 'none', 1: 'time', 2: 'd2d', 3: 'time_or_pulse_threshold',
  4: 'pulse_threshold', 5: 'pressure_threshold',
};
const REPEAT_MODES: Record<number, string> = { 0: 'monthly', 1: 'daily', 2: 'weekly' };
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function decodeRuleCondition(b: number[], i: number): Record<string, any> {
  const typeVal = b[i] & 0xff;
  const condition: Record<string, any> = { type: CONDITION_TYPES[typeVal] ?? 'unknown' };
  switch (typeVal) {
    case 1: // time
      condition.start_time    = u32(b, i + 1);
      condition.end_time      = u32(b, i + 5);
      condition.repeat_enable = b[i + 9] === 1 ? 'enable' : 'disable';
      const rmv               = b[i + 10] & 0xff;
      condition.repeat_mode   = REPEAT_MODES[rmv] ?? 'unknown';
      if (rmv === 0 || rmv === 1) condition.repeat_step = u16(b, i + 11);
      else if (rmv === 2) {
        const week: Record<string, string> = {};
        WEEKDAYS.forEach((d, j) => { week[d] = ((b[i + 11] >>> j) & 1) === 1 ? 'enable' : 'disable'; });
        condition.repeat_week = week;
      }
      break;
    case 2: // d2d
      condition.d2d_command = ('0' + (b[i + 2] & 0xff).toString(16)).slice(-2) +
                              ('0' + (b[i + 1] & 0xff).toString(16)).slice(-2);
      break;
    case 3: // time_or_pulse_threshold
      condition.valve_index      = b[i + 1] & 0xff;
      condition.duration         = u16(b, i + 2);
      condition.pulse_threshold  = u32(b, i + 4);
      break;
    case 4: // pulse_threshold
      condition.valve_index      = b[i + 1] & 0xff;
      condition.pulse_threshold  = u32(b, i + 2);
      break;
    case 5: // pressure_threshold
      condition.source           = b[i + 1] & 0xff;
      condition.mode             = b[i + 2] & 0xff;
      condition.threshold_min    = u16(b, i + 3);
      condition.threshold_max    = u16(b, i + 5);
      break;
  }
  return condition;
}

// ── Rule action decoder ───────────────────────────────────────────────────────
const ACTION_TYPES: Record<number, string> = { 0: 'none', 1: 'em_valve_control', 2: 'valve_control', 3: 'report' };
const REPORT_TYPES: Record<number, string> = { 1: 'valve_1', 2: 'valve_2', 3: 'custom_message', 4: 'threshold_alarm' };

function decodeRuleAction(b: number[], i: number): Record<string, any> {
  const typeVal = b[i] & 0xff;
  const action: Record<string, any> = { type: ACTION_TYPES[typeVal] ?? 'unknown' };
  switch (typeVal) {
    case 1:
    case 2:
      action.valve_index    = b[i + 1] & 0xff;
      action.valve_opening  = b[i + 2] & 0xff;
      action.time_enable    = b[i + 3] === 1 ? 'enable' : 'disable';
      action.duration       = u32(b, i + 4);
      action.pulse_enable   = b[i + 8] === 1 ? 'enable' : 'disable';
      action.pulse_threshold = u32(b, i + 9);
      break;
    case 3:
      action.report_type    = REPORT_TYPES[b[i + 1] & 0xff] ?? 'unknown';
      action.report_content = readAscii(b, i + 2, 8);
      action.continue_count = b[i + 11] & 0xff;
      action.release_enable = b[i + 12] === 1 ? 'enable' : 'disable';
      break;
  }
  return action;
}

// ── Main codec ────────────────────────────────────────────────────────────────

export class MilesightUC511Codec extends BaseDeviceCodec {
  readonly codecId: string       = 'milesight-uc511';
  readonly manufacturer: string   = 'Milesight';
  readonly supportedModels: string[] = ['UC511', 'UC512'];
  readonly protocol      = 'lorawan';
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc511/uc511-v3.png';
  readonly category = 'Valve Controller';
  readonly modelFamily?: string = 'UC511';

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
        decoded.battery = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── Valve 1 (0x03 0x01) ───────────────────────────────────────────────
      // value=0xFF means delay control result (success)
      else if (ch === 0x03 && ty === 0x01) {
        const v = bytes[i] & 0xff;
        if (v === 0xff) decoded.valve_1_result = 'success';
        else decoded.valve_1 = v === 1 ? 'open' : 'close';
        i += 1;
      }

      // ── Valve 1 pulse (0x04 0xC8) ─────────────────────────────────────────
      else if (ch === 0x04 && ty === 0xc8) {
        decoded.valve_1_pulse = u32(bytes, i); i += 4;
      }

      // ── Valve 2 (0x05 0x01) ───────────────────────────────────────────────
      else if (ch === 0x05 && ty === 0x01) {
        const v = bytes[i] & 0xff;
        if (v === 0xff) decoded.valve_2_result = 'success';
        else decoded.valve_2 = v === 1 ? 'open' : 'close';
        i += 1;
      }

      // ── Valve 2 pulse (0x06 0xC8) ─────────────────────────────────────────
      else if (ch === 0x06 && ty === 0xc8) {
        decoded.valve_2_pulse = u32(bytes, i); i += 4;
      }

      // ── GPIO 1 (0x07 0x01) ────────────────────────────────────────────────
      else if (ch === 0x07 && ty === 0x01) {
        decoded.gpio_1 = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── GPIO 2 (0x08 0x01) ────────────────────────────────────────────────
      else if (ch === 0x08 && ty === 0x01) {
        decoded.gpio_2 = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── Pipe pressure (0x09 0x7B) — uint16 LE, kPa ───────────────────────
      else if (ch === 0x09 && ty === 0x7b) {
        decoded.pressure = u16(bytes, i); i += 2;
      }

      // ── Pressure sensor status (0xB9 0x7B) ───────────────────────────────
      else if (ch === 0xb9 && ty === 0x7b) {
        decoded.pressure_sensor_status = bytes[i] === 1 ? 'sensor error' : 'sensor normal'; i += 1;
      }

      // ── Custom message (0xFF 0x12) — ASCII to end ─────────────────────────
      else if (ch === 0xff && ty === 0x12) {
        decoded.custom_message = readAscii(bytes, i, bytes.length - i);
        i = bytes.length;
      }

      // ── History valve (0x20 0xCE) — 9B ───────────────────────────────────
      // ts(4) + status(1) + pulse(4)
      // status bits: bit0=valve_status, bit1=mode(0=counter/1=gpio), bit2=gpio, bit4=index
      else if (ch === 0x20 && ty === 0xce) {
        const ts     = u32(bytes, i);
        const sv     = bytes[i + 4] & 0xff;
        const status = (sv & 0x01) === 1 ? 'open' : 'close';
        const mode   = (sv >>> 1) & 0x01;
        const gpio   = (sv >>> 2) & 0x01;
        const idx    = ((sv >>> 4) & 0x01) === 0 ? 1 : 2;
        const pulse  = u32(bytes, i + 5);
        const entry: Record<string, any> = { timestamp: ts, mode: mode === 0 ? 'counter' : 'gpio' };
        if (mode === 0) {
          entry[`valve_${idx}`]       = status;
          entry[`valve_${idx}_pulse`] = pulse;
        } else {
          entry[`valve_${idx}`]       = status;
          entry[`gpio_${idx}`]        = gpio === 1 ? 'on' : 'off';
        }
        i += 9;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── History pipe pressure (0x21 0xCE) — 6B ───────────────────────────
      else if (ch === 0x21 && ty === 0xce) {
        const entry: Record<string, any> = { timestamp: u32(bytes, i), pressure: u16(bytes, i + 4) };
        i += 6;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Pressure threshold alarm (0x0B 0xF5) — 9B ────────────────────────
      else if (ch === 0x0b && ty === 0xf5) {
        const valveStrategyMap: Record<number, string> = { 0: 'always', 1: 'valve 1 open', 2: 'valve 2 open', 3: 'valve 1 open or valve 2 open' };
        const mathCondMap: Record<number, string>      = { 0: 'none', 1: 'less than', 2: 'greater than', 3: 'between', 4: 'outside' };
        decoded.pressure_threshold_alarm = {
          valve_strategy:   valveStrategyMap[bytes[i] & 0xff]      ?? 'unknown',
          threshold_type:   mathCondMap[bytes[i + 1] & 0xff]       ?? 'unknown',
          threshold_min:    u16(bytes, i + 2),
          threshold_max:    u16(bytes, i + 4),
          current_pressure: u16(bytes, i + 6),
          alarm_status:     bytes[i + 8] === 1 ? 'trigger alarm' : 'release alarm',
        };
        i += 9;
      }

      // ── LoRaWAN class switch response (0xF8 0xA4) — 8B ───────────────────
      else if (ch === 0xf8 && ty === 0xa4) {
        const classTypeMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB', 255: 'cancel' };
        const codeMap: Record<number, string> = { 0: 'success', 1: 'not allowed', 2: 'invalid parameter', 16: 'continuous is 0', 17: 'continuous exceeds maximum', 18: 'instruction expired', 255: 'other error' };
        decoded.lorawan_class_switch_response = {
          timestamp:  u32(bytes, i),
          continuous: u16(bytes, i + 4),
          class_type: classTypeMap[bytes[i + 6] & 0xff] ?? 'unknown',
          code:       codeMap[bytes[i + 8] & 0xff]      ?? 'unknown',
        };
        i += 8;
      }

      // ── Query valve task status response (0xF8 0xA5) — 2B ─────────────────
      else if (ch === 0xf8 && ty === 0xa5) {
        const codeMap: Record<number, string> = { 0: 'success', 1: 'not allowed', 2: 'valve index out of range' };
        decoded.query_valve_task_status_response = {
          valve_index: (bytes[i] & 0xff) + 1,
          code:        codeMap[bytes[i + 1] & 0xff] ?? 'unknown',
        };
        i += 2;
      }

      // ── Schedule device config response (0xF9 0xA7) — 3B ─────────────────
      else if (ch === 0xf9 && ty === 0xa7) {
        const codeMap: Record<number, string> = { 0: 'success', 1: 'task not found', 2: 'expired', 3: 'time invalid', 4: 'channel invalid', 5: 'frequency invalid', 6: 'unsupported', 7: 'time not reached', 8: 'memory full', 9: 'already exists', 255: 'other error' };
        decoded.schedule_device_config_response = {
          id:   bytes[i] & 0xff,
          type: bytes[i + 1] & 0xff,
          code: codeMap[bytes[i + 2] & 0xff] ?? 'unknown',
        };
        i += 3;
      }

      // ── AI collection config readback (0xF9 0xA8) — 7B ───────────────────
      else if (ch === 0xf9 && ty === 0xa8) {
        decoded.set_ai_collection_config = {
          id:                       bytes[i] & 0xff,
          enable:                   bytes[i + 1] === 1 ? 'enable' : 'disable',
          collect_nonirrigation:    u16(bytes, i + 2),
          collect_irrigation:       u16(bytes, i + 4),
          open_delay_collect_time:  bytes[i + 6] & 0xff,
        };
        i += 7;
      }

      // ── Valve task status (0x0E/0x0F 0xAF) — 3B ──────────────────────────
      else if ((ch === 0x0e || ch === 0x0f) && ty === 0xaf) {
        const taskMap: Record<number, string> = { 0: 'free task', 1: 'normal local plan', 2: 'force local plan', 3: 'rain stop plan', 4: 'IPSO temporary control plan' };
        const statusName = ch === 0x0e ? 'valve_1_task_status' : 'valve_2_task_status';
        decoded[statusName] = {
          task_status: taskMap[bytes[i] & 0xff]      ?? 'unknown',
          real_status: bytes[i + 1] === 1 ? 'valve is currently open' : 'valve is currently closed',
          cmd_status:  bytes[i + 2] === 1 ? 'valve is currently commanded to open' : 'valve is currently commanded to close',
        };
        i += 3;
      }

      // ── Read schedule config response (0xF8 0xAF) — 3B ───────────────────
      else if (ch === 0xf8 && ty === 0xaf) {
        const codeMap: Record<number, string> = { 0: 'success', 1: 'not allowed', 2: 'task not found' };
        decoded.read_schedule_config_response = {
          id:   bytes[i] & 0xff,
          type: bytes[i + 1] & 0xff,
          code: codeMap[bytes[i + 2] & 0xff] ?? 'unknown',
        };
        i += 3;
      }

      // ── Multicast command response (0xF0) ─────────────────────────────────
      else if (ch === 0xf0) {
        const codeMap: Record<number, string> = { 0: 'execute successfully', 1: 'not allowed', 2: 'service not supported', 255: 'other error' };
        decoded.multicast_command_response = {
          eui:  bytesToHex(bytes.slice(i + 1, i + 9)),
          code: codeMap[bytes[i + 9] & 0xff] ?? 'unknown',
        };
        i += 10;
      }

      // ── Rule engine readback (0xFE 0x55) ─────────────────────────────────
      // Sent from device as confirmation: rule_id(1) + enable(1) + condition(13) + action(13) = 28B
      else if (ch === 0xfe && ty === 0x55) {
        const rule: Record<string, any> = {
          id:        bytes[i] & 0xff,
          enable:    bytes[i + 1] === 1 ? 'enable' : 'disable',
          condition: decodeRuleCondition(bytes, i + 2),
          action:    decodeRuleAction(bytes, i + 15),
        };
        if (!decoded.rules_config) decoded.rules_config = [];
        decoded.rules_config.push(rule);
        i += 28;
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────
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
    const RULE_BITS = ['rule_1','rule_2','rule_3','rule_4','rule_5','rule_6','rule_7','rule_8','rule_9','rule_10','rule_11','rule_12','rule_13','rule_14','rule_15','rule_16'];

    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x03: data.report_interval     = u16(b, offset); offset += 2; break;
      case 0x17: data.time_zone           = tzName(i16(b, offset)); offset += 2; break;
      case 0x1e: data.class_a_response_time = u32(b, offset); offset += 4; break;
      case 0x1d: { // valve_task response
        const ctrl = b[offset] & 0xff;
        const valveTask: Record<string, any> = {};
        const b3 = (ctrl >>> 3) & 1; const b4 = (ctrl >>> 4) & 1;
        const specialMode = b3 ^ b4;
        const indexMap: Record<number, string> = { 0:'valve 1',1:'valve 2',2:'valve 3',3:'valve 4',4:'valve 5',5:'valve 6',6:'valve 7',7:'all valves' };
        valveTask.valve_index  = indexMap[ctrl & 0x07] ?? 'unknown';
        valveTask.valve_status = ((ctrl >>> 5) & 1) === 1 ? 'open' : 'close';
        valveTask.sequence_id  = b[offset + 1] & 0xff;
        offset += 2;
        if (specialMode === 1) {
          valveTask.rain_stop_plan = b3 === 0 ? 'enable' : 'disable';
          valveTask.duration       = u24(b, offset); offset += 3;
          valveTask.start_time     = u32(b, offset); offset += 4;
        } else {
          valveTask.time_rule_enable  = ((ctrl >>> 7) & 1) === 1 ? 'enable' : 'disable';
          valveTask.duration          = u24(b, offset); offset += 3;
          valveTask.pulse_rule_enable = ((ctrl >>> 6) & 1) === 1 ? 'enable' : 'disable';
          valveTask.valve_pulse       = u32(b, offset); offset += 4;
        }
        data.valve_task = valveTask; break;
      }
      case 0x27: data.clear_history    = 'yes'; offset += 1; break;
      case 0x28: data.report_status    = 'yes'; offset += 1; break;
      case 0x35: data.d2d_key          = bytesToHex(b.slice(offset, offset + 8)); offset += 8; break;
      case 0x3b: {
        const stMap: Record<number, string> = { 1: 'v1.0.2', 2: 'v1.0.3', 3: 'v1.1.0' };
        data.sync_time_type = stMap[b[offset] & 0xff] ?? 'unknown'; offset += 1; break;
      }
      case 0x46: data.gpio_jitter_time = b[offset] & 0xff; offset += 1; break;
      case 0x4a: data.sync_time        = 'yes'; offset += 1; break;
      case 0x4b: { // batch rule ops
        const opType = b[offset] & 0xff;
        const maskRaw = u16(b, offset + 1);
        if (opType === 0) {
          data.batch_read_rules = {};
          RULE_BITS.forEach((k, j) => { data.batch_read_rules[k] = ((maskRaw >>> j) & 1) === 1 ? 'yes' : 'no'; });
        } else if (opType === 1) {
          data.batch_enable_rules = {};
          RULE_BITS.forEach((k, j) => { data.batch_enable_rules[k] = ((maskRaw >>> j) & 1) === 1 ? 'enable' : 'disable'; });
        } else if (opType === 2) {
          data.batch_remove_rules = {};
          RULE_BITS.forEach((k, j) => { data.batch_remove_rules[k] = ((maskRaw >>> j) & 1) === 1 ? 'yes' : 'no'; });
        } else if (opType === 3) {
          const ri = b[offset + 1] & 0xff;
          data[`rule_${ri}_enable`] = b[offset + 2] === 1 ? 'enable' : 'disable';
        } else if (opType === 4) {
          const ri = b[offset + 1] & 0xff;
          data[`rule_${ri}_remove`] = 'yes';
        }
        offset += 3; break;
      }
      case 0x4c: { // query_rule_config response
        const ri = b[offset] & 0xff;
        if (!data.query_rule_config) data.query_rule_config = {};
        data.query_rule_config[`rule_${ri}`] = 'yes';
        offset += 1; break;
      }
      case 0x4d: { // legacy rule config
        const rc: Record<string, any> = {};
        rc.id            = b[offset] & 0xff;
        const d          = b[offset + 1] & 0xff;
        rc.enable        = ((d >>> 7) & 1) === 1 ? 'enable' : 'disable';
        rc.valve_status  = ((d >>> 6) & 1) === 1 ? 'close' : 'open';
        rc.valve_2_enable = ((d >>> 1) & 1) === 1 ? 'enable' : 'disable';
        rc.valve_1_enable = (d & 1) === 1 ? 'enable' : 'disable';
        rc.start_hour    = b[offset + 2] & 0xff;
        rc.start_min     = b[offset + 3] & 0xff;
        rc.end_hour      = b[offset + 4] & 0xff;
        rc.end_min       = b[offset + 5] & 0xff;
        if (!data.rules_config) data.rules_config = [];
        data.rules_config.push(rc);
        offset += 6; break;
      }
      case 0x4e: { // clear_valve_pulse response
        const vi = b[offset] & 0xff;
        data[`clear_valve_${vi}_pulse`] = 'yes';
        offset += 2; break;
      }
      case 0x4f: { // valve_power_supply_config response
        data.valve_power_supply_config = {
          counts:              b[offset] & 0xff,
          control_pulse_time:  u16(b, offset + 1),
          power_time:          u16(b, offset + 3),
        };
        offset += 5; break;
      }
      case 0x52: { // pulse_filter_config response
        const filterModeMap: Record<number, string> = { 1: 'hardware', 2: 'software' };
        data.pulse_filter_config = {
          mode: filterModeMap[b[offset + 1] & 0xff] ?? 'unknown',
          time: u16(b, offset + 2),
        };
        offset += 4; break;
      }
      case 0x53:
      case 0x55: { // new rule config readback
        const rule: Record<string, any> = {
          id:        b[offset] & 0xff,
          enable:    b[offset + 1] === 1 ? 'enable' : 'disable',
          condition: decodeRuleCondition(b, offset + 2),
          action:    decodeRuleAction(b, offset + 15),
        };
        if (!data.rules_config) data.rules_config = [];
        data.rules_config.push(rule);
        offset += 29; break;
      }
      case 0x68: data.history_enable    = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: data.retransmit_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const sub = b[offset] & 0xff;
        if (sub === 0) data.retransmit_interval = u16(b, offset + 1);
        else           data.resend_interval     = u16(b, offset + 1);
        offset += 3; break;
      }
      case 0x84: data.d2d_enable       = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x92: {
        const vi = b[offset] & 0xff;
        data[`valve_${vi}_pulse`] = u32(b, offset + 1);
        offset += 5; break;
      }
      case 0xab:
        data.pressure_calibration_settings = {
          enable:            b[offset] === 1 ? 'enable' : 'disable',
          calibration_value: i16(b, offset + 1),
        };
        offset += 3; break;
      case 0xf3: data.response_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
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
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 60)]; break;
      case 'set_report_interval':     bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 60)]; break;
      case 'set_retransmit_enable':   bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_interval': bytes = [0xff, 0x6a, 0x00, ...wu16(params.retransmit_interval ?? 60)]; break;
      case 'set_resend_interval':     bytes = [0xff, 0x6a, 0x01, ...wu16(params.resend_interval ?? 60)]; break;
      case 'set_time_zone':           bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_sync_time_type':      bytes = [0xff, 0x3b, params.sync_time_type ?? 2]; break;
      case 'set_d2d_enable':          bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_response_enable':     bytes = [0xff, 0xf3, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_class_a_response_time': bytes = [0xff, 0x1e, ...wu32(params.class_a_response_time ?? 0)]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0xff]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_gpio_jitter_time':    bytes = [0xff, 0x46, params.gpio_jitter_time & 0xff]; break;

      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        bytes = [0xff, 0x35, ...hexToBytes(key)]; break;
      }
      case 'set_valve_pulse': {
        const idx = params.index ?? 1; // 1 or 2
        bytes = [0xff, 0x92, idx & 0xff, ...wu32(params.pulse ?? 0)]; break;
      }
      case 'clear_valve_pulse': {
        const idx = params.index ?? 1;
        bytes = [0xff, 0x4e, idx & 0xff, 0x00]; break;
      }
      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = end === 0
          ? [0xfd, 0x6b, ...wu32(start)]
          : [0xfd, 0x6c, ...wu32(start), ...wu32(end)];
        break;
      }
      case 'set_valve_task': {
        const p           = params;
        const indexMap: Record<string, number> = { 'valve 1':0,'valve 2':1,'valve 3':2,'valve 4':3,'valve 5':4,'valve 6':5,'valve 7':6,'all valves':7 };
        const idxVal      = indexMap[p.valve_index ?? 'valve 1'] ?? 0;
        const statusVal   = p.valve_status === 'open' ? 1 : 0;
        const sequenceId  = p.sequence_id ?? 0;
        let ctrl          = idxVal | (statusVal << 5);
        if ('rain_stop_plan' in p) {
          const rsp = p.rain_stop_plan === 'enable' ? 1 : 0;
          ctrl |= (rsp === 1 ? 0 : 1) << 3;
          ctrl |= (rsp === 1 ? 1 : 0) << 4;
          bytes = [0xff, 0x1d, ctrl & 0xff, sequenceId, ...wu24(p.duration ?? 0), ...wu32(p.start_time ?? 0)];
        } else {
          ctrl |= ((p.time_rule_enable === 'enable' ? 1 : 0) << 7);
          ctrl |= ((p.pulse_rule_enable === 'enable' ? 1 : 0) << 6);
          bytes = [0xff, 0x1d, ctrl & 0xff, sequenceId, ...wu24(p.duration ?? 0), ...wu32(p.valve_pulse ?? 0)];
        }
        break;
      }
      case 'batch_read_rules':   { const m = this.encodeRuleMask(params, 'yes'); bytes = [0xff, 0x4b, 0x00, ...wu16(m)]; break; }
      case 'batch_enable_rules': { const m = this.encodeRuleMask(params, 'enable'); bytes = [0xff, 0x4b, 0x01, ...wu16(m)]; break; }
      case 'batch_remove_rules': { const m = this.encodeRuleMask(params, 'yes'); bytes = [0xff, 0x4b, 0x02, ...wu16(m)]; break; }
      case 'enable_rule':  bytes = [0xff, 0x4b, 0x03, params.rule_index & 0xff, params.enable === 'enable' ? 1 : 0]; break;
      case 'remove_rule':  bytes = [0xff, 0x4b, 0x04, params.rule_index & 0xff, 0x00]; break;
      case 'query_rule_config': bytes = [0xff, 0x4c, params.rule_index & 0xff]; break;

      case 'set_valve_power_supply_config': {
        const p = params;
        bytes = [0xff, 0x4f, p.counts & 0xff, ...wu16(p.control_pulse_time), ...wu16(p.power_time)]; break;
      }
      case 'set_pulse_filter_config': {
        const modeMap: Record<string, number> = { hardware: 1, software: 2 };
        bytes = [0xff, 0x52, 0x00, modeMap[params.mode] ?? 1, ...wu16(params.time ?? 40)]; break;
      }
      case 'set_pressure_calibration': {
        bytes = [0xff, 0xab, params.enable === 'enable' ? 1 : 0, ...wi16(params.calibration_value ?? 0)]; break;
      }

      case 'set_lorawan_class_switch': {
        const classMap: Record<string, number> = { 'class A':0,'class B':1,'class C':2,'class CtoB':3,'cancel':255 };
        bytes = [0xf9, 0xa4, ...wu32(params.timestamp ?? 0), ...wu16(params.continuous ?? 0), classMap[params.class_type] ?? 0, params.reserved ?? 0];
        break;
      }
      case 'query_valve_task_status': {
        const idxMap: Record<string, number> = { 'valve 1': 0, 'valve 2': 1 };
        bytes = [0xf9, 0xa5, idxMap[params.index ?? 'valve 1'] ?? 0]; break;
      }
      case 'set_ai_collection_config': {
        const p = params;
        bytes = [0xf9, 0xa8, p.id & 0xff, p.enable === 'enable' ? 1 : 0, ...wu16(p.collect ?? 60), ...wu16(p.collect_irrigation ?? 10), p.open_delay_collect_time ?? 0];
        break;
      }
      case 'read_schedule_config': bytes = [0xf9, 0xaf, params.id & 0xff, params.type & 0xff]; break;

      default:
        throw new Error(`UC511: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  private encodeRuleMask(params: any, trueVal: string): number {
    let mask = 0;
    for (let j = 1; j <= 16; j++) {
      if (params[`rule_${j}`] === trueVal) mask |= (1 << (j - 1));
    }
    return mask;
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC511 is uniquely identified by:
  //   0x03 0x01 / 0x05 0x01 — valve channels
  //   0x04 0xC8 / 0x06 0xC8 — valve pulse counters
  //   0x09 0x7B             — pipe pressure
  //   0x20 0xCE / 0x21 0xCE — history frames

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if ((ch === 0x03 || ch === 0x05) && ty === 0x01) return true; // valve channels
      if ((ch === 0x04 || ch === 0x06) && ty === 0xc8) return true; // valve pulse
      if (ch === 0x09 && ty === 0x7b) return true;                  // pipe pressure
      if ((ch === 0x20 || ch === 0x21) && ty === 0xce) return true; // history frames
    }
    return false;
  }
}

// ── UC512 — identical protocol to UC511, thin subclass ────────────────────────
export class MilesightUC512Codec extends MilesightUC511Codec {
  override readonly codecId: string          = 'milesight-uc512';
  override readonly supportedModels: string[] = ['UC512'];
}