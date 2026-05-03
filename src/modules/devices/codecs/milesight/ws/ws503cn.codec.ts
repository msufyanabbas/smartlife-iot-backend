// src/modules/devices/codecs/milesight/ws503cn.codec.ts
// Milesight WS503_CN — LoRaWAN Smart Wall Switch (China 470 MHz band)
//
// ── RELATIONSHIP TO OTHER WS503 VARIANTS ─────────────────────────────────────
//   - WS503 (original, ws503.codec.ts):  0xFF 0x29 switch, 0xFF 0x08 6B SN
//   - WS503 v4 (ws503v4.codec.ts):       0xFF 0x29 switch, scheduling, power metering
//   - WS503 CN (this file):              0x08 0x29 switch, rule_config, timezone via 0xF9
//
// ── KEY PROTOCOL DIFFERENCES FROM ws503.codec.ts ────────────────────────────
//   - Switch uplink: 0x08 0x29 (not 0xFF 0x29)
//   - Switch downlink: 0x08 <data> 0xFF — individual switch, different packing
//     data = (mask << 4) | ctrl, where mask=1<<(id-1), ctrl=on_off<<(id-1)
//   - SN: 0xFF 0x16, 8B (original uses 0xFF 0x08, 6B)
//   - cancel_delay_task trailing byte: 0x00 (original uses 0xFF)
//   - sync_time: 0xFF 0x4A 0xFF (WS503v4 uses 0x00)
//   - time_zone: 0xF9 0xBD int16 (not 0xFF 0xBD like WS503v4)
//   - reset_button_enable: 0xFF 0x5E (same as WS503v4, original WS503 has no this)
//   - rule_config: 0xF9 0x64 — 7B struct (similar to WS503v4 schedule but different fields)
//   - Rule uplink: 0xF9 0x67 — 7B rule_config response
//   - Rule query: 0xF9 0x65 <rule_id | 0xFF>
//   - No power metering, no D2D, no DST
//
// ── Switch uplink byte layout (0x08 0x29) ────────────────────────────────────
//   Same bit layout as original WS503's 0xFF 0x29:
//   bits: 7  | 6       | 5       | 4       | 3 | 2       | 1       | 0
//         -  | sw3_chg | sw2_chg | sw1_chg | - | sw3     | sw2     | sw1
//
// ── Switch downlink (individual switch) ──────────────────────────────────────
//   0x08 <data> 0xFF
//   data = (mask << 4) | ctrl
//   where mask = 0x01 << (switch_id - 1)
//         ctrl = on_off << (switch_id - 1)
//   e.g. switch_1=on: mask=0x01, ctrl=0x01, data=0x11 → [0x08, 0x11, 0xFF]
//        switch_2=on: mask=0x02, ctrl=0x02, data=0x22 → [0x08, 0x22, 0xFF]
//        switch_3=on: mask=0x04, ctrl=0x04, data=0x44 → [0x08, 0x44, 0xFF]
//
// ── Rule config struct (7B, 0xF9 0x64) ────────────────────────────────────────
//   [0] rule_id (1-8)
//   [1] rule_type (0=none, 1=enable, 2=disable)
//   [2] condition.days bitmask (bit0=mon..bit6=sun)
//   [3] condition.hour
//   [4] condition.minute
//   [5] action.switches: bits[1:0]=sw1, bits[3:2]=sw2, bits[5:4]=sw3 (0=keep,1=on,2=off)
//   [6] action.child_lock (0=keep, 1=enable, 2=disable)
//   For 0xF8 0x64 (downlink echo with result): byte[7]=0 means success
//   For 0xF9 0x67 (rule report uplink): same 7B struct
//
// ── Downlink commands ─────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF                   — reboot
//   0xFF 0x28 0xFF                   — report_status
//   0xFF 0x2C 0xFF                   — report_attribute
//   0xFF 0x03 <u16>                  — set_report_interval
//   0x08 <data> 0xFF                 — set_switch (individual, packed)
//   0xFF 0x22 <frame_count> <u16> <data> — set_delay_task (multi-switch packed)
//   0xFF 0x23 <frame_count> 0x00     — cancel_delay_task (note: 0x00 not 0xFF!)
//   0xFF 0x2F <mode>                 — set_led_mode
//   0xFF 0x5E <enable>               — set_reset_button_enable
//   0xFF 0x25 <u16>                  — set_child_lock_config (bit15=enable, bits14:0=lock_time)
//   0xFF 0x4A 0xFF                   — sync_time (note: 0xFF not 0x00!)
//   0xF9 0xBD <i16>                  — set_time_zone (minutes, note: 0xF9 not 0xFF!)
//   0xF9 0x64 <7B>                   — set_rule_config
//   0xF9 0x65 <rule_id | 0xFF>       — query_rule_config

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }

const TZ_MAP: Record<number, string> = {
  [-720]:'UTC-12', [-660]:'UTC-11', [-600]:'UTC-10', [-570]:'UTC-9:30',
  [-540]:'UTC-9', [-480]:'UTC-8', [-420]:'UTC-7', [-360]:'UTC-6',
  [-300]:'UTC-5', [-240]:'UTC-4', [-210]:'UTC-3:30', [-180]:'UTC-3',
  [-120]:'UTC-2', [-60]:'UTC-1', [0]:'UTC', [60]:'UTC+1', [120]:'UTC+2',
  [180]:'UTC+3', [210]:'UTC+3:30', [240]:'UTC+4', [270]:'UTC+4:30',
  [300]:'UTC+5', [330]:'UTC+5:30', [345]:'UTC+5:45', [360]:'UTC+6',
  [390]:'UTC+6:30', [420]:'UTC+7', [480]:'UTC+8', [540]:'UTC+9',
  [570]:'UTC+9:30', [600]:'UTC+10', [630]:'UTC+10:30', [660]:'UTC+11',
  [720]:'UTC+12', [765]:'UTC+12:45', [780]:'UTC+13', [840]:'UTC+14',
};
const TZ_INV: Record<string, number> = Object.fromEntries(Object.entries(TZ_MAP).map(([k, v]) => [v, +k]));

const RULE_TYPE: Record<number, string> = { 0:'none', 1:'enable', 2:'disable' };
const RULE_TYPE_INV: Record<string, number> = Object.fromEntries(Object.entries(RULE_TYPE).map(([k, v]) => [v, +k]));
const SW_ACTION: Record<number, string> = { 0:'keep', 1:'on', 2:'off' };
const SW_ACTION_INV: Record<string, number> = Object.fromEntries(Object.entries(SW_ACTION).map(([k, v]) => [v, +k]));
const CHILD_LOCK_ACTION: Record<number, string> = { 0:'keep', 1:'enable', 2:'disable' };
const CHILD_LOCK_INV: Record<string, number> = Object.fromEntries(Object.entries(CHILD_LOCK_ACTION).map(([k, v]) => [v, +k]));

const DAY_KEYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

function readRuleConfig(b: number[], offset: number): any {
  const rule: any = { rule_id: b[offset] };
  const ruleType = b[offset + 1] & 0xff;
  rule.rule_type = RULE_TYPE[ruleType] ?? 'unknown';
  if (ruleType !== 0) {
    const days = b[offset + 2];
    rule.condition = {};
    DAY_KEYS.forEach((k, i) => { rule.condition[k] = (days >> i) & 1 ? 'enable' : 'disable'; });
    rule.condition.hour   = b[offset + 3];
    rule.condition.minute = b[offset + 4];
    rule.action = {};
    const sw = b[offset + 5];
    rule.action.switch_1 = SW_ACTION[(sw >> 0) & 3];
    rule.action.switch_2 = SW_ACTION[(sw >> 2) & 3];
    rule.action.switch_3 = SW_ACTION[(sw >> 4) & 3];
    rule.action.child_lock = CHILD_LOCK_ACTION[b[offset + 6]] ?? 'unknown';
  }
  return rule;
}

export class MilesightWS503CNCodec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws503-cn';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS503-CN'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS503-CN',
    description:  'Smart Wall Switch (3-gang, CN 470 MHz) — rule engine, timezone support',
    telemetryKeys: [
      { key: 'switch_1', label: 'Switch 1', type: 'string' as const, enum: ['on', 'off'] },
      { key: 'switch_2', label: 'Switch 2', type: 'string' as const, enum: ['on', 'off'] },
      { key: 'switch_3', label: 'Switch 3', type: 'string' as const, enum: ['on', 'off'] },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device',  params: [] },
      { type: 'report_status', label: 'Report Status',  params: [] },
      { type: 'sync_time',     label: 'Sync Time',      params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 1200, min: 60 }],
      },
      {
        type:   'set_switch',
        label:  'Set Switch',
        params: [
          { key: 'switch_id', label: 'Switch ID (1–3)', type: 'number' as const, required: true, default: 1, min: 1, max: 3 },
          { key: 'state',     label: 'State',           type: 'select' as const, required: true, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
        ],
      },
      {
        type:   'set_led_mode',
        label:  'Set LED Mode',
        params: [{ key: 'led_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Off', value: 'off' }, { label: 'On Inverted', value: 'on_inverted' }, { label: 'On Synced', value: 'on_synced' }] }],
      },
      {
        type:   'set_child_lock_config',
        label:  'Set Child Lock',
        params: [
          { key: 'enable',    label: 'Enable',       type: 'boolean' as const, required: true  },
          { key: 'lock_time', label: 'Lock Time (minutes)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Time Zone', type: 'string' as const, required: true, default: 'UTC+3' }],
      },
      {
        type:   'set_rule_config',
        label:  'Set Rule Config',
        params: [
          { key: 'rule_id',   label: 'Rule ID (1–8)', type: 'number' as const, required: true, default: 1, min: 1, max: 8 },
          { key: 'rule_type', label: 'Rule Type',     type: 'select' as const, required: true, options: [{ label: 'None', value: 'none' }, { label: 'Enable', value: 'enable' }, { label: 'Disable', value: 'disable' }] },
        ],
      },
      {
        type:   'query_rule_config',
        label:  'Query Rule Config',
        params: [{ key: 'rule_id', label: 'Rule ID (1–8)', type: 'number' as const, required: true, default: 1, min: 1, max: 8 }],
      },
      { type: 'query_all_rule_config', label: 'Query All Rule Configs', params: [] },
    ],
    uiComponents: [
      { type: 'toggle' as const, label: 'Switch 1', keys: ['switch_1'], command: 'set_switch' },
      { type: 'toggle' as const, label: 'Switch 2', keys: ['switch_2'], command: 'set_switch' },
      { type: 'toggle' as const, label: 'Switch 3', keys: ['switch_3'], command: 'set_switch' },
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
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── SWITCH STATUS (0x08 0x29) ─────────────────────────────────────────────
      // CN uses 0x08 0x29 (original WS503 uses 0xFF 0x29)
      // Same packed byte format: bits[2:0]=switch states, bits[6:4]=change flags
      else if (ch === 0x08 && ty === 0x29) {
        const d = bytes[i++];
        decoded.switch_1        = (d >> 0) & 1 ? 'on' : 'off';
        decoded.switch_1_change = (d >> 4) & 1 ? 'yes' : 'no';
        decoded.switch_2        = (d >> 1) & 1 ? 'on' : 'off';
        decoded.switch_2_change = (d >> 5) & 1 ? 'yes' : 'no';
        decoded.switch_3        = (d >> 2) & 1 ? 'on' : 'off';
        decoded.switch_3_change = (d >> 6) & 1 ? 'yes' : 'no';
      }

      // ── RULE CONFIG UPLINK (0xF9 0x67) ───────────────────────────────────────
      else if (ch === 0xf9 && ty === 0x67) {
        if (!decoded.rule_config) decoded.rule_config = [];
        decoded.rule_config.push(readRuleConfig(bytes, i));
        i += 7;
      }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const r = this.handleStdResponse(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      // ── Extended responses (0xF8 / 0xF9) ─────────────────────────────────────
      else if (ch === 0xf8 || ch === 0xf9) {
        const r = this.handleExtResponse(ch, ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleStdResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x03: data.report_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2c: data.report_attribute = 'yes'; offset += 1; break;

      case 0x22: {
        data.frame_count = b[offset] & 0xff;
        data.delay_time  = u16(b, offset + 1);
        const d = b[offset + 3] & 0xff;
        const switchBits: Record<string, number> = { switch_1: 0, switch_2: 1, switch_3: 2 };
        for (const [key, bit] of Object.entries(switchBits)) {
          if ((d >> (bit + 4)) & 1) data[key] = (d >> bit) & 1 ? 'on' : 'off';
        }
        offset += 4; break;
      }

      case 0x23: data.cancel_delay_task = b[offset] & 0xff; offset += 2; break;

      case 0x25: {
        const raw = u16(b, offset);
        data.child_lock_config = { enable: (raw >>> 15) & 1 ? 'enable' : 'disable', lock_time: raw & 0x7fff };
        offset += 2; break;
      }

      case 0x2f: {
        const ledMap: Record<number, string> = { 0:'off', 1:'on_inverted', 2:'on_synced' };
        data.led_mode = ledMap[b[offset]] ?? 'unknown'; offset += 1; break;
      }

      case 0x4a: data.sync_time = 'yes'; offset += 1; break;
      case 0x5e: data.reset_button_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;

      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleExtResponse(ch: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x64: {
        // 7B rule data + 1B result for 0xF8, or just 7B + 1B overhead for 0xF9
        const resultByte = b[offset + 7];
        if (resultByte === 0) {
          if (!data.rule_config) data.rule_config = [];
          data.rule_config.push(readRuleConfig(b, offset));
        } else {
          data.rule_config_result = resultByte;
        }
        offset += 9; // 7B data + 1B result + 1B extra (as per reference decoder)
        break;
      }

      case 0x65: {
        // query response: [rule_id_or_0xFF, result_byte]
        const id          = b[offset] & 0xff;
        const resultByte  = b[offset + 1] & 0xff;
        if (resultByte === 0) {
          data.query_rule_config_request = id === 0xff
            ? 'yes'
            : { [`rule_${id}`]: 'yes' };
        }
        offset += 2; break;
      }

      case 0xbd:
        // timezone in CN: 0xF9 0xBD int16 LE minutes (not 0xFF 0xBD like WS503v4)
        data.time_zone = TZ_MAP[i16(b, offset)] ?? i16(b, offset); offset += 2; break;

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
      // sync_time uses 0xFF trailing (not 0x00 like WS503v4)
      case 'sync_time':        bytes = [0xff, 0x4a, 0xff]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 1200)]; break;

      // Individual switch control: 0x08 <data> 0xFF
      // data = (mask << 4) | ctrl, mask = 1 << (id-1), ctrl = on_off << (id-1)
      case 'set_switch': {
        const id  = params.switch_id ?? 1; // 1, 2, or 3
        const on  = params.state === 'on' || params.state === 1 ? 1 : 0;
        const mask = 0x01 << (id - 1);
        const ctrl = on << (id - 1);
        const data = ((mask & 0x07) << 4) | (ctrl & 0x07);
        bytes = [0x08, data & 0xff, 0xff]; break;
      }

      // Multi-switch delay task: 0xFF 0x22 <frame_count> <u16_delay> <packed_data>
      // packed_data: bits[6:4]=mask, bits[2:0]=states for switches 1-3
      case 'set_delay_task': {
        const p = params.delay_task ?? params;
        const frameCount = p.frame_count ?? 0;
        const delayTime  = p.delay_time ?? 0;
        let data = 0;
        const bits: Record<string, number> = { switch_1: 0, switch_2: 1, switch_3: 2 };
        for (const [key, bit] of Object.entries(bits)) {
          if (key in p) {
            data |= 1 << (bit + 4);
            if (p[key] === 'on' || p[key] === 1) data |= 1 << bit;
          }
        }
        bytes = [0xff, 0x22, frameCount & 0xff, ...wu16(delayTime), data & 0xff]; break;
      }

      // cancel_delay_task trailing byte is 0x00 (NOT 0xFF like original WS503)
      case 'cancel_delay_task':
        bytes = [0xff, 0x23, (params.cancel_delay_task ?? 0) & 0xff, 0x00]; break;

      case 'set_led_mode': {
        const modeMap: Record<string, number> = { off:0, on_inverted:1, on_synced:2 };
        bytes = [0xff, 0x2f, modeMap[params.led_mode ?? 'off'] ?? 0]; break;
      }

      case 'set_reset_button_enable':
        bytes = [0xff, 0x5e, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_child_lock_config': {
        const en = params.enable === 'enable' ? 1 : 0;
        const raw = ((en & 1) << 15) | ((params.lock_time ?? 0) & 0x7fff);
        bytes = [0xff, 0x25, ...wu16(raw)]; break;
      }

      // time_zone: 0xF9 0xBD (NOT 0xFF 0xBD like WS503v4!)
      case 'set_time_zone': {
        const minutes = typeof params.time_zone === 'number'
          ? params.time_zone : (TZ_INV[params.time_zone] ?? 0);
        bytes = [0xf9, 0xbd, ...wi16(minutes)]; break;
      }

      // set_rule_config: 0xF9 0x64 + 7-byte struct
      case 'set_rule_config': {
        const p = params.rule_config ?? params;
        const ruleType = RULE_TYPE_INV[p.rule_type ?? 'none'] ?? 0;
        let days = 0;
        let hour = 0, minute = 0;
        let sw = 0, lock = 0;
        if (ruleType !== 0 && p.condition) {
          DAY_KEYS.forEach((k, bit) => { if (p.condition[k] === 'enable') days |= 1 << bit; });
          hour   = p.condition.hour   ?? 0;
          minute = p.condition.minute ?? 0;
        }
        if (p.action) {
          sw = (SW_ACTION_INV[p.action.switch_1 ?? 'keep'] ?? 0) |
               ((SW_ACTION_INV[p.action.switch_2 ?? 'keep'] ?? 0) << 2) |
               ((SW_ACTION_INV[p.action.switch_3 ?? 'keep'] ?? 0) << 4);
          lock = CHILD_LOCK_INV[p.action.child_lock ?? 'keep'] ?? 0;
        }
        bytes = [0xf9, 0x64, p.rule_id ?? 1, ruleType, days, hour, minute, sw, lock]; break;
      }

      // query_rule_config: 0xF9 0x65 <rule_id> (single rule)
      case 'query_rule_config':
        bytes = [0xf9, 0x65, (params.rule_id ?? 1) & 0xff]; break;

      // query_all_rule_config: 0xF9 0x65 0xFF
      case 'query_all_rule_config':
        bytes = [0xf9, 0x65, 0xff]; break;

      default:
        throw new Error(`WS503CN: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS503 CN uniquely identified by switch channel 0x08 0x29 (not 0xFF 0x29).
  // This is the primary differentiator from all other WS503 variants.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0x08 && bytes[i + 1] === 0x29) return true; // CN-exclusive switch channel
    }
    return false;
  }
}