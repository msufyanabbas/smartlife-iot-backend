// src/modules/devices/codecs/milesight/ws503v4.codec.ts
// Milesight WS503 v4 — LoRaWAN Smart Wall Switch (3-gang, advanced firmware)
//
// ── IMPORTANT: Separate from ws503.codec.ts ──────────────────────────────────
//   WS503 v4 is a later firmware revision with a completely different feature set.
//   NOT backward-compatible with original WS503. Must be listed BEFORE ws503 in
//   ALL_CODECS so its canDecode (0xF9/0xF8 fingerprint) wins.
//
// ── KEY DIFFERENCES FROM WS503 (original) ────────────────────────────────────
//   - SN: 0xFF 0x16 8B  (original: 0xFF 0x08 6B)
//   - Field naming: reporting_interval / button_status (not switch_N)
//   - LED mode: 2-value (disable / Enable-relay-off) vs 3-value original
//   - Button lock: enable only (no lock_time)
//   - Power metering added: voltage(u16 no /10), electric_power, power_factor,
//     power_consumption, current_rating
//   - Alarm channels: 0x87 0xC9, 0x88 0x29, 0x89 0xDF
//   - Collect error channels: 0xB3-0xB7
//   - Extended channel family: 0xF8 (with result byte), 0xF9 (without result byte)
//   - Schedules: 0xF9 0x64/65/67 — 7-byte struct
//   - D2D controller: 0xF9 0xB8 — 5-byte struct
//   - DST: 0xF9 0x72 — 9-byte struct
//   - Power 2W: 0xF9 0xAB — 7-byte struct
//   - Timezone: 0xFF 0xBD (int16 LE, minutes)
//   - D2D agent: 0xFF 0x83 — 5-byte struct
//   - D2D global: 0xFF 0xC7
//   - Power switch mode: 0xFF 0x67
//
// ── Button status byte layout (0xFF 0x29) ────────────────────────────────────
//   bits: 7  | 6       | 5       | 4       | 3 | 2       | 1       | 0
//         -  | b3_chg  | b2_chg  | b1_chg  | - | btn3    | btn2    | btn1
//   If bits[6:4] any set → downlink echo button_status_control
//   If bits[6:4] all zero → uplink button_status
//
// ── Schedule struct (7B, 0xF9 0x64) ──────────────────────────────────────────
//   [0] schedule_id
//   [1] option: bits[1:0]=enable(0=not config,1=enable,2=disable), bit4=use_config
//   [2] days bitmask: bit0=mon..bit6=sun
//   [3] execut_hour
//   [4] execut_min
//   [5] switches: bits[1:0]=bs1, bits[3:2]=bs2, bits[5:4]=bs3 (0=keep,1=on,2=off,3=reversal)
//   [6] lock_status (0=keep,1=lock,2=unlock)
//   For 0xF8 0x64: byte[7] = result code (0=success)
//
// ── DST struct (9B, 0xF9 0x72) ────────────────────────────────────────────────
//   [0] bit7=enable, bits[6:0]=dst_bias(min)
//   [1] start_month
//   [2] bits[7:4]=start_week_num, bits[3:0]=start_week_day
//   [3..4] start_hour_min (u16 LE, min)
//   [5] end_month
//   [6] bits[7:4]=end_week_num, bits[3:0]=end_week_day
//   [7..8] end_hour_min (u16 LE, min)

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
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

function readD2DCmd(b: number[], i: number): string {
  return ('0' + (b[i + 1] & 0xff).toString(16)).slice(-2) +
         ('0' + (b[i]     & 0xff).toString(16)).slice(-2);
}
function writeD2DCmd(cmd: string): number[] {
  const s = (cmd ?? '0000').padStart(4, '0');
  return [parseInt(s.substring(2, 4), 16), parseInt(s.substring(0, 2), 16)];
}

const TZ_MAP: Record<number, string> = {
  [-720]:'UTC-12(IDLW)', [-660]:'UTC-11(SST)', [-600]:'UTC-10(HST)',
  [-570]:'UTC-9:30(MIT)', [-540]:'UTC-9(AKST)', [-480]:'UTC-8(PST)',
  [-420]:'UTC-7(MST)', [-360]:'UTC-6(CST)', [-300]:'UTC-5(EST)',
  [-240]:'UTC-4(AST)', [-210]:'UTC-3:30(NST)', [-180]:'UTC-3(BRT)',
  [-120]:'UTC-2(FNT)', [-60]:'UTC-1(CVT)', [0]:'UTC(WET)',
  [60]:'UTC+1(CET)', [120]:'UTC+2(EET)', [180]:'UTC+3(MSK)',
  [210]:'UTC+3:30(IRST)', [240]:'UTC+4(GST)', [270]:'UTC+4:30(AFT)',
  [300]:'UTC+5(PKT)', [330]:'UTC+5:30(IST)', [345]:'UTC+5:45(NPT)',
  [360]:'UTC+6(BHT)', [390]:'UTC+6:30(MMT)', [420]:'UTC+7(ICT)',
  [480]:'UTC+8(CT/CST)', [540]:'UTC+9(JST)', [570]:'UTC+9:30(ACST)',
  [600]:'UTC+10(AEST)', [630]:'UTC+10:30(LHST)', [660]:'UTC+11(VUT)',
  [720]:'UTC+12(NZST)', [765]:'UTC+12:45(CHAST)', [780]:'UTC+13(PHOT)',
  [840]:'UTC+14(LINT)',
};
const TZ_INV: Record<string, number> = Object.fromEntries(Object.entries(TZ_MAP).map(([k, v]) => [v, +k]));

const MONTH_MAP: Record<number, string>    = { 1:'Jan.', 2:'Feb.', 3:'Mar.', 4:'Apr.', 5:'May.', 6:'Jun.', 7:'Jul.', 8:'Aug.', 9:'Sep.', 10:'Oct.', 11:'Nov.', 12:'Dec.' };
const MONTH_INV: Record<string, number>    = Object.fromEntries(Object.entries(MONTH_MAP).map(([k, v]) => [v, +k]));
const WEEK_NUM_MAP: Record<number, string> = { 1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 5:'last' };
const WEEK_NUM_INV: Record<string, number> = Object.fromEntries(Object.entries(WEEK_NUM_MAP).map(([k, v]) => [v, +k]));
const WEEK_DAY_MAP: Record<number, string> = { 1:'Mon.', 2:'Tues.', 3:'Wed.', 4:'Thurs.', 5:'Fri.', 6:'Sat.', 7:'Sun.' };
const WEEK_DAY_INV: Record<string, number> = Object.fromEntries(Object.entries(WEEK_DAY_MAP).map(([k, v]) => [v, +k]));
const HOUR_MIN_MAP: Record<number, string> = {
  0:'00:00', 60:'01:00', 120:'02:00', 180:'03:00', 240:'04:00', 300:'05:00',
  360:'06:00', 420:'07:00', 480:'08:00', 540:'09:00', 600:'10:00', 660:'11:00',
  720:'12:00', 780:'13:00', 840:'14:00', 900:'15:00', 960:'16:00', 1020:'17:00',
  1080:'18:00', 1140:'19:00', 1200:'20:00', 1260:'21:00', 1320:'22:00', 1380:'23:00',
};
const HOUR_MIN_INV: Record<string, number> = Object.fromEntries(Object.entries(HOUR_MIN_MAP).map(([k, v]) => [v, +k]));

const ENABLE3: Record<number, string>     = { 0:'not config', 1:'enable', 2:'disable' };
const ENABLE3_INV: Record<string, number> = Object.fromEntries(Object.entries(ENABLE3).map(([k, v]) => [v, +k]));
const SW_STATUS: Record<number, string>    = { 0:'keep', 1:'on', 2:'off', 3:'reversal' };
const SW_STATUS_INV: Record<string, number>= Object.fromEntries(Object.entries(SW_STATUS).map(([k, v]) => [v, +k]));
const LOCK_STATUS: Record<number, string>  = { 0:'keep', 1:'lock', 2:'unlock' };
const LOCK_INV: Record<string, number>     = Object.fromEntries(Object.entries(LOCK_STATUS).map(([k, v]) => [v, +k]));
const BTN_MAP: Record<number, string>      = { 1:'button1', 2:'button2', 3:'button1, button2', 4:'button3', 5:'button1, button3', 6:'button2, button3', 7:'button1, button2, button3' };
const BTN_MAP_INV: Record<string, number>  = Object.fromEntries(Object.entries(BTN_MAP).map(([k, v]) => [v, +k]));
const ACT_STATUS: Record<number, string>   = { 0:'off', 1:'on', 2:'reversel' };
const ACT_INV: Record<string, number>      = Object.fromEntries(Object.entries(ACT_STATUS).map(([k, v]) => [v, +k]));
const BTN_ID_MAP: Record<number, string>   = { 0:'button1', 1:'button2', 2:'button3' };
const BTN_ID_INV: Record<string, number>   = Object.fromEntries(Object.entries(BTN_ID_MAP).map(([k, v]) => [v, +k]));

function readSchedule(b: number[], offset: number, isReport = false): any {
  const s: any = {};
  s.schedule_id   = b[offset];
  s.enable        = ENABLE3[b[offset + 1] & 0x03] ?? 'unknown';
  s.use_config    = (b[offset + 1] >> 4) & 1 ? 'yes' : 'no';
  const days      = b[offset + 2];
  const dayKeys   = isReport
    ? ['execution_day_mon','execution_day_tues','execution_day_wed','execution_day_thu','execution_day_fri','execution_day_sat','execution_day_sun']
    : ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  for (let d = 0; d < 7; d++) s[dayKeys[d]] = (days >> d) & 1 ? 'enable' : 'disable';
  s.execut_hour    = b[offset + 3];
  s.execut_min     = b[offset + 4];
  const sw         = b[offset + 5];
  s.button_status1 = SW_STATUS[(sw >> 0) & 3];
  s.button_status2 = SW_STATUS[(sw >> 2) & 3];
  s.button_status3 = SW_STATUS[(sw >> 4) & 3];
  s.lock_status    = LOCK_STATUS[b[offset + 6]] ?? 'unknown';
  return s;
}

function readDst(b: number[], offset: number): any {
  const byte0 = b[offset];
  return {
    enable:         (byte0 >> 7) & 1 ? 'enable' : 'disable',
    dst_bias:       byte0 & 0x7f,
    start_month:    MONTH_MAP[b[offset + 1]]              ?? 'unknown',
    start_week_num: WEEK_NUM_MAP[(b[offset + 2] >> 4) & 0xf] ?? 'unknown',
    start_week_day: WEEK_DAY_MAP[b[offset + 2] & 0xf]    ?? 'unknown',
    start_hour_min: HOUR_MIN_MAP[u16(b, offset + 3)]      ?? u16(b, offset + 3),
    end_month:      MONTH_MAP[b[offset + 5]]              ?? 'unknown',
    end_week_num:   WEEK_NUM_MAP[(b[offset + 6] >> 4) & 0xf] ?? 'unknown',
    end_week_day:   WEEK_DAY_MAP[b[offset + 6] & 0xf]    ?? 'unknown',
    end_hour_min:   HOUR_MIN_MAP[u16(b, offset + 7)]      ?? u16(b, offset + 7),
  };
}

// ── Codec ─────────────────────────────────────────────────────────────────────

export class MilesightWS503V4Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws503-v4';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS503-V4'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS503-V4',
    description:  'Smart Wall Switch (3-gang, v4) — power metering, scheduling, D2D, DST',
    telemetryKeys: [
      { key: 'button_status.button1', label: 'Switch 1',          type: 'string' as const, enum: ['on', 'off'] },
      { key: 'button_status.button2', label: 'Switch 2',          type: 'string' as const, enum: ['on', 'off'] },
      { key: 'button_status.button3', label: 'Switch 3',          type: 'string' as const, enum: ['on', 'off'] },
      { key: 'voltage',               label: 'Voltage',           type: 'number' as const, unit: 'V'  },
      { key: 'electric_power',        label: 'Active Power',      type: 'number' as const, unit: 'W'  },
      { key: 'power_factor',          label: 'Power Factor',      type: 'number' as const, unit: '%'  },
      { key: 'power_consumption',     label: 'Power Consumption', type: 'number' as const, unit: 'Wh' },
      { key: 'current_rating',        label: 'Current',           type: 'number' as const, unit: 'mA' },
    ],
    commands: [
      { type: 'reboot',              label: 'Reboot Device',       params: [] },
      { type: 'report_status',       label: 'Report Status',       params: [] },
      { type: 'power_consumption_clear', label: 'Clear Power Consumption', params: [] },
      {
        type:   'set_reporting_interval',
        label:  'Set Reporting Interval',
        params: [{ key: 'reporting_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 1200, min: 60 }],
      },
      {
        type:   'set_button_status_control',
        label:  'Control Switches',
        params: [
          { key: 'button_status1', label: 'Switch 1', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
          { key: 'button_status2', label: 'Switch 2', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
          { key: 'button_status3', label: 'Switch 3', type: 'select' as const, required: false, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
        ],
      },
      {
        type:   'set_button_lock_config',
        label:  'Set Button Lock',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_led_mode',
        label:  'Set LED Mode',
        params: [{ key: 'led_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Disable', value: 'disable' }, { label: 'Enable (relay closed indicator off)', value: 'Enable (relay closed indicator off)' }] }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Offset (minutes, UTC+8=480)', type: 'number' as const, required: true, default: 180 }],
      },
      {
        type:   'set_overcurrent_alarm_config',
        label:  'Set Overcurrent Alarm',
        params: [
          { key: 'enable',    label: 'Enable',     type: 'boolean' as const, required: true  },
          { key: 'threshold', label: 'Threshold (A)', type: 'number' as const, required: false, default: 10 },
        ],
      },
      {
        type:   'set_overcurrent_protection',
        label:  'Set Overcurrent Protection',
        params: [
          { key: 'enable',    label: 'Enable',     type: 'boolean' as const, required: true  },
          { key: 'threshold', label: 'Threshold (A)', type: 'number' as const, required: false, default: 10 },
        ],
      },
      {
        type:   'set_power_switch_mode',
        label:  'Set Power Switch Mode',
        params: [{ key: 'power_switch_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Off', value: 'off' }, { label: 'On', value: 'on' }, { label: 'Keep', value: 'keep' }] }],
      },
      {
        type:   'set_d2d_settings',
        label:  'Set D2D Settings',
        params: [
          { key: 'd2d_controller_enable', label: 'Controller Enable', type: 'boolean' as const, required: false },
          { key: 'd2d_agent_enable',      label: 'Agent Enable',      type: 'boolean' as const, required: false },
        ],
      },
      {
        type:   'set_schedule',
        label:  'Set Schedule',
        params: [
          { key: 'schedule_id',    label: 'Schedule ID', type: 'number'  as const, required: true, default: 1 },
          { key: 'enable',         label: 'Enable',      type: 'select'  as const, required: true, options: [{ label: 'Enable', value: 'enable' }, { label: 'Disable', value: 'disable' }, { label: 'Not Config', value: 'not config' }] },
          { key: 'execut_hour',    label: 'Hour',        type: 'number'  as const, required: true, default: 0, min: 0, max: 23 },
          { key: 'execut_min',     label: 'Minute',      type: 'number'  as const, required: true, default: 0, min: 0, max: 59 },
          { key: 'button_status1', label: 'Switch 1',    type: 'select'  as const, required: false, options: ['keep','on','off','reversal'].map(v => ({ label: v, value: v })) },
          { key: 'button_status2', label: 'Switch 2',    type: 'select'  as const, required: false, options: ['keep','on','off','reversal'].map(v => ({ label: v, value: v })) },
          { key: 'button_status3', label: 'Switch 3',    type: 'select'  as const, required: false, options: ['keep','on','off','reversal'].map(v => ({ label: v, value: v })) },
        ],
      },
      {
        type:   'get_schedule',
        label:  'Query Schedule',
        params: [{ key: 'schedule_id', label: 'Schedule ID (or "all schedules")', type: 'string' as const, required: true, default: 'all schedules' }],
      },
    ],
    uiComponents: [
      { type: 'toggle' as const, label: 'Switch 1',      keys: ['button_status.button1'], command: 'set_button_status_control' },
      { type: 'toggle' as const, label: 'Switch 2',      keys: ['button_status.button2'], command: 'set_button_status_control' },
      { type: 'toggle' as const, label: 'Switch 3',      keys: ['button_status.button3'], command: 'set_button_status_control' },
      { type: 'value'  as const, label: 'Voltage',       keys: ['voltage'],               unit: 'V'  },
      { type: 'value'  as const, label: 'Active Power',  keys: ['electric_power'],        unit: 'W'  },
      { type: 'value'  as const, label: 'Power Consumption', keys: ['power_consumption'], unit: 'Wh' },
      { type: 'value'  as const, label: 'Current',       keys: ['current_rating'],        unit: 'mA' },
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
      // SN: 0xFF 0x16, 8 bytes (v4 switched back to 0x16 unlike original WS503's 0x08)
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 1:'Class B', 2:'Class C' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Power metering ────────────────────────────────────────────────────────
      // voltage = uint16 raw, NO /10 divisor (differs from WS51x/52x)
      else if (ch === 0x03 && ty === 0x74) { decoded.voltage         = u16(bytes, i); i += 2; }
      else if (ch === 0x04 && ty === 0x80) { decoded.electric_power  = u32(bytes, i); i += 4; }
      else if (ch === 0x05 && ty === 0x81) { decoded.power_factor    = bytes[i++] & 0xff; }
      else if (ch === 0x06 && ty === 0x83) { decoded.power_consumption = u32(bytes, i); i += 4; }
      else if (ch === 0x07 && ty === 0xc9) { decoded.current_rating  = u16(bytes, i); i += 2; }

      // ── Button status (0xFF 0x29) ─────────────────────────────────────────────
      // bits[6:4] non-zero → downlink echo (button_status_control)
      // bits[6:4] all zero → uplink (button_status)
      else if (ch === 0xff && ty === 0x29) {
        const d    = bytes[i++];
        const mask = (d >> 4) & 0x07;
        if (mask) {
          decoded.button_status_control = {
            button_status1:        (d >> 0) & 1 ? 'on' : 'off',
            button_status1_change: (d >> 4) & 1 ? 'yes' : 'no',
            button_status2:        (d >> 1) & 1 ? 'on' : 'off',
            button_status2_change: (d >> 5) & 1 ? 'yes' : 'no',
            button_status3:        (d >> 2) & 1 ? 'on' : 'off',
            button_status3_change: (d >> 6) & 1 ? 'yes' : 'no',
          };
        } else {
          decoded.button_status = {
            button1: (d >> 0) & 1 ? 'on' : 'off',
            button2: (d >> 1) & 1 ? 'on' : 'off',
            button3: (d >> 2) & 1 ? 'on' : 'off',
          };
        }
      }

      // ── Alarm channels ────────────────────────────────────────────────────────
      else if (ch === 0x87 && ty === 0xc9) {
        decoded.overcurrent_alarm = { current: u16(bytes, i), status: bytes[i + 2] === 1 ? 'overcurrent' : 'unknown' }; i += 3;
      }
      else if (ch === 0x88 && ty === 0x29) {
        decoded.device_abnormal_alarm = { status: bytes[i] === 1 ? 'abnormal' : 'unknown' }; i += 1;
      }
      else if (ch === 0x89 && ty === 0xdf) {
        decoded.temperature_alarm = { status: bytes[i] === 1 ? 'overtemperature' : 'unknown' }; i += 1;
      }

      // ── Collect error channels ────────────────────────────────────────────────
      else if (ch === 0xb3 && ty === 0x74) { decoded.voltage_collect_error           = { type: bytes[i] === 1 ? 'collection error' : 'unknown' }; i += 1; }
      else if (ch === 0xb4 && ty === 0x80) { decoded.electric_power_collect_error    = { type: bytes[i] === 1 ? 'collection error' : 'unknown' }; i += 1; }
      else if (ch === 0xb5 && ty === 0x81) { decoded.power_factor_collect_error      = { type: bytes[i] === 1 ? 'collection error' : 'unknown' }; i += 1; }
      else if (ch === 0xb6 && ty === 0x83) { decoded.power_consumption_collect_error = { type: bytes[i] === 1 ? 'collection error' : 'unknown' }; i += 1; }
      else if (ch === 0xb7 && ty === 0xc9) { decoded.current_collect_error           = { type: bytes[i] === 1 ? 'collection error' : 'unknown' }; i += 1; }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const r = this.handleStdResponse(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      // ── Extended responses (0xF8 = with result byte, 0xF9 = without) ──────────
      else if (ch === 0xf8 || ch === 0xf9) {
        const r = this.handleExtResponse(ch, ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Standard response handler (0xFF / 0xFE) ──────────────────────────────────

  private handleStdResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03: data.reporting_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2c: data.report_attribute = 'yes'; offset += 1; break;

      case 0x25: {
        data.button_lock_config = { enable: (u16(b, offset) >>> 15) & 1 ? 'enable' : 'disable' };
        offset += 2; break;
      }

      case 0x29: {
        const d    = b[offset++] & 0xff;
        const mask = (d >> 4) & 0x07;
        if (mask) {
          data.button_status_control = {
            button_status1:        (d >> 0) & 1 ? 'on' : 'off',
            button_status1_change: (d >> 4) & 1 ? 'yes' : 'no',
            button_status2:        (d >> 1) & 1 ? 'on' : 'off',
            button_status2_change: (d >> 5) & 1 ? 'yes' : 'no',
            button_status3:        (d >> 2) & 1 ? 'on' : 'off',
            button_status3_change: (d >> 6) & 1 ? 'yes' : 'no',
          };
        }
        break;
      }

      case 0x2f: data.led_mode = b[offset] === 1 ? 'Enable (relay closed indicator off)' : 'disable'; offset += 1; break;
      case 0x5e: data.button_reset_config   = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x26: data.power_consumption_3w  = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x27: data.power_consumption_clear = b[offset++] === 1 ? 'yes' : 'no'; break;

      case 0x24:
        data.overcurrent_alarm_config = { enable: b[offset] === 1 ? 'enable' : 'disable', threshold: b[offset + 1] & 0xff };
        offset += 2; break;

      case 0x30:
        data.overcurrent_protection = { enable: b[offset] === 1 ? 'enable' : 'disable', threshold: b[offset + 1] & 0xff };
        offset += 2; break;

      case 0x8d: data.highcurrent_config = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x67: data.power_switch_mode  = (['off', 'on', 'keep'])[b[offset++]] ?? 'unknown'; break;
      case 0x4a: data.time_synchronize   = 'yes'; offset += 1; break;

      case 0xbd: data.time_zone = TZ_MAP[i16(b, offset)] ?? i16(b, offset); offset += 2; break;

      case 0xc7: {
        const d = b[offset++] & 0xff;
        data.d2d_settings = {
          d2d_controller_enable:        (d >> 0) & 1 ? 'enable' : 'disable',
          d2d_controller_enable_change: (d >> 4) & 1 ? 'yes' : 'no',
          d2d_agent_enable:             (d >> 1) & 1 ? 'enable' : 'disable',
          d2d_agent_enable_change:      (d >> 5) & 1 ? 'yes' : 'no',
        }; break;
      }

      case 0x83: {
        const agent = {
          number:          b[offset] & 0xff,
          enable:          (b[offset + 1] & 0x01) ? 'enable' : 'disable',
          control_command: readD2DCmd(b, offset + 2),
          action_status: {
            button:        BTN_MAP[(b[offset + 4] >> 4) & 0xf] ?? 'unknown',
            button_status: ACT_STATUS[b[offset + 4] & 0x0f]    ?? 'unknown',
          },
        };
        if (!data.d2d_agent_settings_array) data.d2d_agent_settings_array = [];
        data.d2d_agent_settings_array.push(agent);
        offset += 5; break;
      }

      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Extended response handler (0xF8 = with result, 0xF9 = without) ───────────

  private handleExtResponse(ch: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const hasResult = ch === 0xf8;

    switch (ty) {
      case 0x64: {
        // 7 bytes of schedule data; for 0xF8, result byte is AFTER those 7 bytes
        if (!hasResult || b[offset + 7] === 0) {
          if (!data.schedule_settings) data.schedule_settings = [];
          data.schedule_settings.push(readSchedule(b, offset));
        } else {
          data.schedule_settings_result = b[offset + 7];
        }
        offset += 7; break;
      }

      case 0x65: {
        const id = b[offset++];
        data.get_schedule = { schedule_id: id === 0xff ? 'all schedules' : id }; break;
      }

      case 0x67: {
        if (!data.schedule_report) data.schedule_report = [];
        data.schedule_report.push(readSchedule(b, offset, true));
        offset += 7; break;
      }

      case 0xab: {
        data.power_consumption_2w = {
          enable:        b[offset] === 1 ? 'enable' : 'disable',
          button_power1: u16(b, offset + 1),
          button_power2: u16(b, offset + 3),
          button_power3: u16(b, offset + 5),
        }; offset += 7; break;
      }

      case 0xb8: {
        const ctrl = {
          button_id:     BTN_ID_MAP[b[offset]] ?? 'unknown',
          contrl_enable: b[offset + 1] === 1 ? 'enable' : 'disable',
          uplink: {
            lora_enable:   (b[offset + 2] & 0x01) ? 'enable' : 'disable',
            button_enable: (b[offset + 2] >> 1) & 0x01 ? 'enable' : 'disable',
          },
          contrl_cmd: readD2DCmd(b, offset + 3),
        };
        if (!data.d2d_controller_settings_array) data.d2d_controller_settings_array = [];
        data.d2d_controller_settings_array.push(ctrl);
        offset += 5; break;
      }

      case 0x72: {
        data.daylight_saving_time = readDst(b, offset);
        offset += 9; break;
      }

      default: offset += 1; break;
    }

    if (hasResult) offset += 1; // consume result byte for 0xF8 responses

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
      case 'time_synchronize': bytes = [0xff, 0x4a, 0x00]; break;
      case 'power_consumption_clear': bytes = [0xff, 0x27, 0x01]; break;

      case 'set_reporting_interval':
        bytes = [0xff, 0x03, ...wu16(params.reporting_interval ?? 1200)]; break;

      case 'set_button_status_control': {
        const p = params.button_status_control ?? params;
        let data = 0;
        if ('button_status1' in p) {
          data |= 1 << 4; // always set change bit when controlling
          if (p.button_status1 === 'on') data |= 1 << 0;
        }
        if ('button_status2' in p) {
          data |= 1 << 5;
          if (p.button_status2 === 'on') data |= 1 << 1;
        }
        if ('button_status3' in p) {
          data |= 1 << 6;
          if (p.button_status3 === 'on') data |= 1 << 2;
        }
        bytes = [0xff, 0x29, data & 0xff]; break;
      }

      case 'set_button_lock_config': {
        const en = ((params.button_lock_config?.enable ?? params.enable) === 'enable') ? 1 : 0;
        bytes = [0xff, 0x25, ...wu16(en << 15)]; break;
      }

      case 'set_button_reset_config':
        bytes = [0xff, 0x5e, params.button_reset_config === 'enable' ? 1 : 0]; break;

      case 'set_power_consumption_3w':
        bytes = [0xff, 0x26, params.power_consumption_3w === 'enable' ? 1 : 0]; break;

      case 'set_led_mode':
        bytes = [0xff, 0x2f, params.led_mode === 'Enable (relay closed indicator off)' ? 1 : 0]; break;

      case 'set_overcurrent_alarm_config':
        bytes = [0xff, 0x24, params.enable === 'enable' ? 1 : 0, params.threshold ?? 10]; break;

      case 'set_overcurrent_protection':
        bytes = [0xff, 0x30, params.enable === 'enable' ? 1 : 0, params.threshold ?? 10]; break;

      case 'set_highcurrent_config':
        bytes = [0xff, 0x8d, params.highcurrent_config === 'enable' ? 1 : 0]; break;

      case 'set_power_switch_mode': {
        const m: Record<string, number> = { off: 0, on: 1, keep: 2 };
        bytes = [0xff, 0x67, m[params.power_switch_mode ?? 'keep'] ?? 2]; break;
      }

      case 'set_time_zone': {
        const minutes = typeof params.time_zone === 'number'
          ? params.time_zone : (TZ_INV[params.time_zone] ?? 0);
        bytes = [0xff, 0xbd, ...wi16(minutes)]; break;
      }

      case 'set_d2d_settings': {
        const p = params.d2d_settings ?? params;
        let data = 0;
        if (p.d2d_controller_enable === 'enable')        data |= 1 << 0;
        if (p.d2d_agent_enable === 'enable')             data |= 1 << 1;
        if (p.d2d_controller_enable_change === 'yes')    data |= 1 << 4;
        if (p.d2d_agent_enable_change === 'yes')         data |= 1 << 5;
        bytes = [0xff, 0xc7, data & 0xff]; break;
      }

      case 'set_d2d_agent_settings': {
        const p = params;
        const act = ((BTN_MAP_INV[p.action_status?.button] ?? 1) << 4) |
                    (ACT_INV[p.action_status?.button_status] ?? 0);
        bytes = [
          0xff, 0x83,
          p.number ?? 0, p.enable === 'enable' ? 1 : 0,
          ...writeD2DCmd(p.control_command ?? '0000'),
          act,
        ]; break;
      }

      case 'set_schedule': {
        const p = params.schedule_settings ?? params;
        const dayKeys = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        let days = 0;
        dayKeys.forEach((k, bit) => { if (p[k] === 'enable') days |= 1 << bit; });
        const opt = (ENABLE3_INV[p.enable ?? 'enable'] ?? 1) | ((p.use_config === 'yes' ? 1 : 0) << 4);
        const sw  = (SW_STATUS_INV[p.button_status1 ?? 'keep'] ?? 0) |
                    ((SW_STATUS_INV[p.button_status2 ?? 'keep'] ?? 0) << 2) |
                    ((SW_STATUS_INV[p.button_status3 ?? 'keep'] ?? 0) << 4);
        bytes = [
          0xf9, 0x64,
          p.schedule_id ?? 1, opt, days,
          p.execut_hour ?? 0, p.execut_min ?? 0,
          sw, LOCK_INV[p.lock_status ?? 'keep'] ?? 0,
        ]; break;
      }

      case 'get_schedule': {
        const id = params.get_schedule?.schedule_id ?? params.schedule_id;
        bytes = [0xf9, 0x65, id === 'all schedules' ? 0xff : (id ?? 1) & 0xff]; break;
      }

      case 'set_power_consumption_2w': {
        const p = params.power_consumption_2w ?? params;
        bytes = [
          0xf9, 0xab, p.enable === 'enable' ? 1 : 0,
          ...wu16(p.button_power1 ?? 0),
          ...wu16(p.button_power2 ?? 0),
          ...wu16(p.button_power3 ?? 0),
        ]; break;
      }

      case 'set_d2d_controller_settings': {
        const p = params.d2d_controller_settings ?? params;
        const uplink = ((p.uplink?.lora_enable   === 'enable') ? 1 : 0) |
                       ((p.uplink?.button_enable === 'enable') ? 2 : 0);
        bytes = [
          0xf9, 0xb8,
          BTN_ID_INV[p.button_id ?? 'button1'] ?? 0,
          p.contrl_enable === 'enable' ? 1 : 0,
          uplink,
          ...writeD2DCmd(p.contrl_cmd ?? '0000'),
        ]; break;
      }

      case 'set_daylight_saving_time': {
        const p = params.daylight_saving_time ?? params;
        const en   = p.enable === 'enable' ? 1 : 0;
        const bias = p.dst_bias ?? 60;
        const sm   = MONTH_INV[p.start_month ?? 'Mar.']      ?? 3;
        const swn  = WEEK_NUM_INV[p.start_week_num ?? '2nd'] ?? 2;
        const swd  = WEEK_DAY_INV[p.start_week_day ?? 'Sun.']?? 7;
        const shm  = typeof p.start_hour_min === 'number' ? p.start_hour_min : (HOUR_MIN_INV[p.start_hour_min] ?? 120);
        const em   = MONTH_INV[p.end_month ?? 'Nov.']        ?? 11;
        const ewn  = WEEK_NUM_INV[p.end_week_num ?? '1st']   ?? 1;
        const ewd  = WEEK_DAY_INV[p.end_week_day ?? 'Sun.']  ?? 7;
        const ehm  = typeof p.end_hour_min === 'number' ? p.end_hour_min : (HOUR_MIN_INV[p.end_hour_min] ?? 120);
        bytes = [
          0xf9, 0x72,
          ((en & 1) << 7) | (bias & 0x7f),
          sm,  ((swn & 0xf) << 4) | (swd & 0xf), ...wu16(shm),
          em,  ((ewn & 0xf) << 4) | (ewd & 0xf), ...wu16(ehm),
        ]; break;
      }

      default:
        throw new Error(`WS503V4: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS503 v4 identified by extended channel prefixes 0xF8/0xF9 (v4-exclusive).
  // Must be registered BEFORE ws503.codec.ts in ALL_CODECS.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i];
      if (ch === 0xf9 || ch === 0xf8) return true;              // extended channels — v4 only
      if (ch === 0x87 && bytes[i + 1] === 0xc9) return true;    // overcurrent alarm — v4 only
      if (ch === 0x88 && bytes[i + 1] === 0x29) return true;    // device abnormal — v4 only
      if (ch === 0x89 && bytes[i + 1] === 0xdf) return true;    // temperature alarm — v4 only
      if (ch === 0xff && bytes[i + 1] === 0x29) return true;    // button status (shared with ws503, v4 wins by ordering)
    }
    return false;
  }
}