// src/modules/devices/codecs/milesight/uc100.codec.ts
// Milesight UC100 v2 — IoT Controller (Modbus Gateway)
//
// Protocol: Classic channel_id + channel_type (same family as GS301/WT101)
//
// Unique to UC100:
//   - Dynamic Modbus telemetry (0xF9/0x73): variable data width per register type
//   - Modbus mutation (0xF9/0x74): double-precision mutation value
//   - Modbus history (0x21/0xCE): 23-byte timestamped history frames
//   - Custom message history (0x21/0xCD): ASCII message history
//   - Full rule engine: 16 rules, each with 1 condition + up to 3 actions
//   - Downlink: reboot, report interval, timezone, DST, modbus config,
//     channel config, retransmit, history, rule engine

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

// ── Register type → data width (bytes consumed from uplink) ───────────────────
const REG_TYPE_WIDTH: Record<number, number> = {
  0: 1, 1: 1,                         // COIL, DIS → 1 byte
  2: 2, 3: 2,                         // INPUT_AB, INPUT_BA → 2 bytes
  4: 4, 5: 4, 6: 4, 7: 4,            // INPUT_INT32_* → 4 bytes
  8: 4, 9: 4,                         // INPUT_INT32_AB/CD → 4 bytes (reads 2, skips 2)
  10: 4, 11: 4, 12: 4, 13: 4,        // INPUT_FLOAT_* → 4 bytes
  14: 2, 15: 2,                       // HOLD_INT16_* → 2 bytes
  16: 4, 17: 4, 18: 4, 19: 4,        // HOLD_INT32_* → 4 bytes
  20: 4, 21: 4,                       // HOLD_INT32_AB/CD → 4 bytes
  22: 4, 23: 4, 24: 4, 25: 4,        // HOLD_FLOAT_* → 4 bytes
  26: 8, 27: 8, 28: 8, 29: 8,        // INPUT_DOUBLE_* → 8 bytes
  30: 8, 31: 8, 32: 8, 33: 8,        // INPUT_INT64_* → 8 bytes
  34: 8, 35: 8, 36: 8, 37: 8,        // HOLD_DOUBLE_* → 8 bytes
  38: 8, 39: 8, 40: 8, 41: 8,        // HOLD_INT64_* → 8 bytes
};

const REGISTER_TYPE_MAP: Record<number, string> = {
  0: 'MB_REG_COIL', 1: 'MB_REG_DIS',
  2: 'MB_REG_INPUT_AB', 3: 'MB_REG_INPUT_BA',
  4: 'MB_REG_INPUT_INT32_ABCD', 5: 'MB_REG_INPUT_INT32_BADC',
  6: 'MB_REG_INPUT_INT32_CDAB', 7: 'MB_REG_INPUT_INT32_DCBA',
  8: 'MB_REG_INPUT_INT32_AB', 9: 'MB_REG_INPUT_INT32_CD',
  10: 'MB_REG_INPUT_FLOAT_ABCD', 11: 'MB_REG_INPUT_FLOAT_BADC',
  12: 'MB_REG_INPUT_FLOAT_CDAB', 13: 'MB_REG_INPUT_FLOAT_DCBA',
  14: 'MB_REG_HOLD_INT16_AB', 15: 'MB_REG_HOLD_INT16_BA',
  16: 'MB_REG_HOLD_INT32_ABCD', 17: 'MB_REG_HOLD_INT32_BADC',
  18: 'MB_REG_HOLD_INT32_CDAB', 19: 'MB_REG_HOLD_INT32_DCBA',
  20: 'MB_REG_HOLD_INT32_AB', 21: 'MB_REG_HOLD_INT32_CD',
  22: 'MB_REG_HOLD_FLOAT_ABCD', 23: 'MB_REG_HOLD_FLOAT_BADC',
  24: 'MB_REG_HOLD_FLOAT_CDAB', 25: 'MB_REG_HOLD_FLOAT_DCBA',
  26: 'MB_REG_INPUT_DOUBLE_ABCDEFGH', 27: 'MB_REG_INPUT_DOUBLE_GHEFCDAB',
  28: 'MB_REG_INPUT_DOUBLE_BADCFEHG', 29: 'MB_REG_INPUT_DOUBLE_HGFEDCBA',
  30: 'MB_REG_INPUT_INT64_ABCDEFGH', 31: 'MB_REG_INPUT_INT64_GHEFCDAB',
  32: 'MB_REG_INPUT_INT64_BADCFEHG', 33: 'MB_REG_INPUT_INT64_HGFEDCBA',
  34: 'MB_REG_HOLD_DOUBLE_ABCDEFGH', 35: 'MB_REG_HOLD_DOUBLE_GHEFCDAB',
  36: 'MB_REG_HOLD_DOUBLE_BADCFEHG', 37: 'MB_REG_HOLD_DOUBLE_HGFEDCBA',
  38: 'MB_REG_HOLD_INT64_ABCDEFGH', 39: 'MB_REG_HOLD_INT64_GHEFCDAB',
  40: 'MB_REG_HOLD_INT64_BADCFEHG', 41: 'MB_REG_HOLD_INT64_HGFEDCBA',
};

const TZ_MAP: Record<number, string> = {
  [-720]: 'UTC-12', [-660]: 'UTC-11', [-600]: 'UTC-10', [-570]: 'UTC-9:30',
  [-540]: 'UTC-9',  [-480]: 'UTC-8',  [-420]: 'UTC-7',  [-360]: 'UTC-6',
  [-300]: 'UTC-5',  [-240]: 'UTC-4',  [-210]: 'UTC-3:30', [-180]: 'UTC-3',
  [-120]: 'UTC-2',  [-60]:  'UTC-1',    0: 'UTC',          60: 'UTC+1',
   120: 'UTC+2',   180: 'UTC+3',      210: 'UTC+3:30',   240: 'UTC+4',
   270: 'UTC+4:30', 300: 'UTC+5',     330: 'UTC+5:30',   345: 'UTC+5:45',
   360: 'UTC+6',   390: 'UTC+6:30',   420: 'UTC+7',      480: 'UTC+8',
   540: 'UTC+9',   570: 'UTC+9:30',   600: 'UTC+10',     630: 'UTC+10:30',
   660: 'UTC+11',  720: 'UTC+12',     765: 'UTC+12:45',  780: 'UTC+13',
   840: 'UTC+14',
};

export class MilesightUC100Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc100';
  readonly manufacturer    = 'Milesight';
  readonly model           = 'UC100';
  readonly description     = 'IoT Controller / Modbus Gateway with Rule Engine';
  readonly supportedModels = ['UC100'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};
    let i = 0;

    while (i < bytes.length) {
      const channel_id   = bytes[i++];
      const channel_type = bytes[i++];

      // ── Device attribute frames ──────────────────────────────────────────

      if (channel_id === 0xff && channel_type === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (channel_id === 0xff && channel_type === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join(''); i += 8;
      }
      else if (channel_id === 0xff && channel_type === 0x0f) {
        decoded.lorawan_class = (['Class A', 'Class B', 'Class C', 'Class CtoB'])[bytes[i++]] ?? 'unknown';
      }
      else if (channel_id === 0xff && channel_type === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }
      else if (channel_id === 0xff && channel_type === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Modbus telemetry (0xF9/0x73) ─────────────────────────────────────
      // value_1: [alarm_type(7..6)] [chn_id(5..0)]
      // value_2: [sign(7)] [reg_offset(6..5)] [data_type(4..0)]

      else if (channel_id === 0xf9 && channel_type === 0x73) {
        const v1 = bytes[i++];
        const v2 = bytes[i++];

        const chn_id        = (v1 & 0x3f) + 1;
        const alarm_value   = (v1 >>> 6) & 0x03;
        const sign          = (v2 >>> 7) & 0x01;
        const reg_offset    = (v2 >>> 5) & 0x03;
        const data_type     = v2 & 0x1f;

        const chn_name = reg_offset === 0 ? `modbus_chn_${chn_id}` : `modbus_chn_${chn_id}_reg_${reg_offset + 1}`;
        const value    = this.readModbusValue(bytes, i, data_type, sign);
        i += REG_TYPE_WIDTH[data_type] ?? 2;

        decoded[chn_name] = value;

        if (alarm_value !== 0) {
          const alarmMap: Record<number, string> = { 0: 'normal', 1: 'threshold alarm', 2: 'threshold alarm release', 3: 'mutation alarm' };
          if (!decoded.event) decoded.event = [];
          (decoded.event as any[]).push({
            [chn_name]:              value,
            [`${chn_name}_alarm`]:   alarmMap[alarm_value] ?? 'unknown',
          });
        }
      }

      // ── Modbus read error (0xFF/0x15) ─────────────────────────────────────

      else if (channel_id === 0xff && channel_type === 0x15) {
        const chn_id = (bytes[i++] & 0xff) + 1;
        decoded[`modbus_chn_${chn_id}_alarm`] = 'read error';
      }

      // ── Modbus mutation (0xF9/0x74) ───────────────────────────────────────

      else if (channel_id === 0xf9 && channel_type === 0x74) {
        const chn_def    = bytes[i++];
        const chn_id     = (chn_def & 0x3f) + 1;
        const reg_offset = (chn_def >>> 6) & 0x03;
        const chn_name   = reg_offset === 0 ? `modbus_chn_${chn_id}` : `modbus_chn_${chn_id}_reg_${reg_offset + 1}`;
        decoded[`${chn_name}_mutation`] = this.readDoubleLE(bytes, i); i += 8;
      }

      // ── Modbus history (0x21/0xCE) ────────────────────────────────────────
      // 4B timestamp + 1B chn_id + 2B data_def + 8B data_1 + 8B data_2 = 23B total

      else if (channel_id === 0x21 && channel_type === 0xce) {
        const ts       = this.u32(bytes, i); i += 4;
        const chn_id   = (bytes[i++] & 0xff) + 1;
        const data_def = this.u16(bytes, i); i += 2;

        const sign        = (data_def >>> 15) & 0x01;
        const reg_type    = (data_def >>> 9) & 0x3f;
        const read_status = (data_def >>> 8) & 0x01;
        const reg_counts  = (data_def >>> 6) & 0x03;
        const event_type  = (data_def >>> 4) & 0x03;
        const alarmMap: Record<number, string> = { 0: 'normal', 1: 'threshold alarm', 2: 'threshold alarm release', 3: 'mutation alarm' };
        const chn_name = `modbus_chn_${chn_id}`;

        const entry: Record<string, any> = { timestamp: ts };
        if (read_status === 1) {
          entry[chn_name]          = this.readModbusHistoryValue(bytes, i, reg_type, sign);
          if (reg_counts === 2) {
            entry[`${chn_name}_reg_2`] = this.readModbusHistoryValue(bytes, i + 8, reg_type, sign);
          }
          entry[`${chn_name}_alarm`] = alarmMap[event_type] ?? 'unknown';
        } else {
          entry[`${chn_name}_alarm`] = 'read error';
        }
        i += 16; // skip both 8-byte data slots

        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(entry);
      }

      // ── Custom message history (0x21/0xCD) ────────────────────────────────

      else if (channel_id === 0x21 && channel_type === 0xcd) {
        const ts         = this.u32(bytes, i); i += 4;
        const msg_length = bytes[i++];
        const msg        = this.readAscii(bytes, i, msg_length); i += msg_length;
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({ timestamp: ts, custom_message: msg });
      }

      // ── Standard downlink responses (0xFE/0xFF) ───────────────────────────

      else if (channel_id === 0xfe || channel_id === 0xff) {
        const result = this.handleDownlink(channel_type, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF8/0xF9) ───────────────────────────

      else if (channel_id === 0xf8 || channel_id === 0xf9) {
        const result = this.handleDownlinkExt(channel_id, channel_type, bytes, i);
        // Merge rule_config arrays if present
        for (const [k, v] of Object.entries(result.data)) {
          if (k === 'rule_config' && Array.isArray(decoded.rule_config) && Array.isArray(v)) {
            const existing = decoded.rule_config as any[];
            for (const incoming of v as any[]) {
              const idx = existing.findIndex((r: any) => r.rule_id === incoming.rule_id);
              if (idx >= 0) Object.assign(existing[idx], incoming);
              else existing.push(incoming);
            }
          } else {
            (decoded as any)[k] = v;
          }
        }
        i = result.offset;
      }

      // ── History response marker (0xFC) ────────────────────────────────────

      else if (channel_id === 0xfc) {
        i += 1;
      }

      // ── Custom message (any other channel_id) ─────────────────────────────

      else {
        decoded.custom_message = this.readAscii(bytes, i - 2, bytes.length - (i - 2));
        i = bytes.length;
      }
    }

    return decoded;
  }

  // ── Standard downlink response handler ───────────────────────────────────

  private handleDownlink(channelType: number, bytes: number[], offset: number): { data: DecodedTelemetry; offset: number } {
    const d: DecodedTelemetry = {};

    switch (channelType) {
      case 0x03: d.report_interval = this.u16(bytes, offset); offset += 2; break;
      case 0x04: d.confirm_mode_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x10: d.reboot = 'yes'; offset += 1; break;
      case 0x27: d.clear_history = 'yes'; offset += 1; break;
      case 0x28: d.report_status = 'yes'; offset += 1; break;
      case 0x4a: d.sync_time = 'yes'; offset += 1; break;
      case 0x68: d.history_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: d.retransmit_enable = bytes[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0xbd: {
        const tz = this.i16(bytes, offset); offset += 2;
        d.time_zone = TZ_MAP[tz] ?? `UTC${tz >= 0 ? '+' : ''}${tz / 60}`;
        break;
      }
      case 0xef: {
        const sub = bytes[offset];
        if (sub === 0x00) {
          // remove channel
          const chn_id = bytes[offset + 1];
          if (!d.remove_modbus_channels) d.remove_modbus_channels = [];
          (d.remove_modbus_channels as any[]).push({ channel_id: chn_id });
          offset += 4;
        } else if (sub === 0x01) {
          // channel config
          const ch = this.readModbusChannelConfig(bytes, offset + 1);
          if (!d.modbus_channels) d.modbus_channels = [];
          (d.modbus_channels as any[]).push(ch);
          offset += 7;
        } else if (sub === 0x02) {
          // channel name
          const chn_id = bytes[offset + 1];
          const len    = bytes[offset + 2];
          const name   = this.readAscii(bytes, offset + 3, len);
          if (!d.modbus_channels_name) d.modbus_channels_name = [];
          (d.modbus_channels_name as any[]).push({ channel_id: chn_id, name });
          offset += 3 + len;
        }
        break;
      }
      default:
        throw new Error(`UC100: unknown downlink response 0x${channelType.toString(16)}`);
    }

    return { data: d, offset };
  }

  // ── Extended downlink response handler ───────────────────────────────────

  private handleDownlinkExt(code: number, channelType: number, bytes: number[], offset: number): { data: DecodedTelemetry; offset: number } {
    const d: DecodedTelemetry = {};

    switch (channelType) {
      case 0x0d: {
        d.retransmit_config = {
          enable:   bytes[offset] === 1 ? 'enable' : 'disable',
          interval: this.u16(bytes, offset + 1),
        };
        offset += 3;
        break;
      }
      case 0x0e: d.resend_interval = this.u16(bytes, offset); offset += 2; break;
      case 0x72: {
        d.dst_config = this.readDstConfig(bytes, offset); offset += 9; break;
      }
      case 0x76: {
        const mask = this.u16(bytes, offset);
        const type = bytes[offset + 2]; offset += 3;
        const rules: Record<string, string> = {};
        for (let r = 0; r < 16; r++) {
          rules[`rule_${r + 1}`] = ((mask >>> r) & 1) === 1 ? 'yes' : 'no';
        }
        if (type === 0x01) d.batch_enable_rules  = rules;
        else if (type === 0x02) d.batch_disable_rules = rules;
        else if (type === 0x03) d.batch_remove_rules  = rules;
        break;
      }
      case 0x77: d.query_rule_config = bytes[offset++]; break;
      case 0x78: {
        d.modbus_serial_port_config = this.readModbusSerialPortConfig(bytes, offset); offset += 7; break;
      }
      case 0x79: {
        d.modbus_config = this.readModbusConfig(bytes, offset); offset += 7; break;
      }
      case 0x7a: {
        const qr = bytes[offset++];
        if (qr === 0x00) d.query_modbus_serial_port_config = 'yes';
        else if (qr === 0x01) d.query_modbus_config = 'yes';
        break;
      }
      case 0x7d: {
        const result = this.readRuleConfig(bytes, offset);
        d.rule_config = [result.data];
        offset = result.offset;
        break;
      }
      default:
        throw new Error(`UC100: unknown ext downlink response 0x${channelType.toString(16)}`);
    }

    // 0xf8 means a result status byte follows
    if (code === 0xf8) {
      const resultVal = bytes[offset++];
      if (resultVal !== 0) {
        const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
        return {
          data: {
            device_response_result: {
              channel_type: channelType,
              result:       resultMap[resultVal] ?? 'unknown',
              request:      d,
            },
          },
          offset,
        };
      }
    }

    return { data: d, offset };
  }

  // ── Encode downlink ───────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':         bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status':  bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':      bytes = [0xff, 0x4a, 0x00]; break;
      case 'clear_history':  bytes = [0xff, 0x27, 0x01]; break;
      case 'query_modbus_serial_port_config': bytes = [0xf9, 0x7a, 0x00]; break;
      case 'query_modbus_config':             bytes = [0xf9, 0x7a, 0x01]; break;

      case 'set_report_interval': {
        const v = params.interval ?? 600;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }
      case 'set_confirm_mode': {
        bytes = [0xff, 0x04, params.enable === 'enable' || params.enable === 1 ? 1 : 0];
        break;
      }
      case 'set_time_zone': {
        const tz = params.timezone ?? 180;
        const v  = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0xbd, v & 0xff, (v >> 8) & 0xff];
        break;
      }
      case 'set_history_enable': {
        bytes = [0xff, 0x68, params.enable === 'enable' || params.enable === 1 ? 1 : 0];
        break;
      }
      case 'set_retransmit_enable': {
        bytes = [0xff, 0x69, params.enable === 'enable' || params.enable === 1 ? 1 : 0];
        break;
      }
      case 'set_retransmit_config': {
        const en  = params.enable === 'enable' || params.enable === 1 ? 1 : 0;
        const iv  = params.interval ?? 60;
        bytes = [0xf9, 0x0d, en, iv & 0xff, (iv >> 8) & 0xff];
        break;
      }
      case 'set_resend_interval': {
        const v = params.interval ?? 60;
        bytes = [0xf9, 0x0e, v & 0xff, (v >> 8) & 0xff];
        break;
      }
      case 'fetch_history': {
        const st = params.start_time ?? 0;
        const et = params.end_time ?? 0;
        if (!et) {
          bytes = [0xfd, 0x6b, st & 0xff, (st >> 8) & 0xff, (st >> 16) & 0xff, (st >> 24) & 0xff];
        } else {
          bytes = [
            0xfd, 0x6c,
            st & 0xff, (st >> 8) & 0xff, (st >> 16) & 0xff, (st >> 24) & 0xff,
            et & 0xff, (et >> 8) & 0xff, (et >> 16) & 0xff, (et >> 24) & 0xff,
          ];
        }
        break;
      }
      case 'set_modbus_serial_port_config': {
        const { baud_rate = 9600, data_bits = 8, stop_bits = 1, parity = 'none' } = params;
        const parityMap: Record<string, number> = { none: 0, odd: 1, even: 2 };
        const br = baud_rate;
        bytes = [
          0xf9, 0x78,
          br & 0xff, (br >> 8) & 0xff, (br >> 16) & 0xff, (br >> 24) & 0xff,
          data_bits, stop_bits,
          typeof parity === 'string' ? (parityMap[parity] ?? 0) : parity,
        ];
        break;
      }
      case 'set_modbus_config': {
        const { exec_interval = 1000, max_response_time = 1000, retry_times = 3,
                pass_through_enable = 'disable', pass_through_direct = 'active', pass_through_port = 52 } = params;
        const ptEn   = pass_through_enable  === 'enable'        || pass_through_enable  === 1 ? 1 : 0;
        const ptDir  = pass_through_direct  === 'bidirectional' || pass_through_direct  === 1 ? 1 : 0;
        const data   = (ptEn << 4) | ptDir;
        bytes = [
          0xf9, 0x79,
          exec_interval & 0xff, (exec_interval >> 8) & 0xff,
          max_response_time & 0xff, (max_response_time >> 8) & 0xff,
          retry_times & 0xff, data & 0xff, pass_through_port & 0xff,
        ];
        break;
      }
      case 'set_modbus_channel': {
        const { channel_id, slave_id, register_address, register_type, quantity = 1, sign = 'unsigned' } = params;
        const regTypeMap = Object.entries(REGISTER_TYPE_MAP).find(([, v]) => v === register_type);
        const regTypeNum = regTypeMap ? parseInt(regTypeMap[0]) : 0;
        const signBit    = sign === 'signed' || sign === 1 ? 1 : 0;
        const dataB      = (signBit << 4) | (quantity & 0x0f);
        bytes = [
          0xff, 0xef, 0x01,
          channel_id & 0xff, slave_id & 0xff,
          register_address & 0xff, (register_address >> 8) & 0xff,
          regTypeNum & 0xff, dataB & 0xff,
        ];
        break;
      }
      case 'set_modbus_channel_name': {
        const { channel_id, name } = params;
        const nameBytes = Array.from(name as string).map((c: string) => c.charCodeAt(0));
        bytes = [0xff, 0xef, 0x02, channel_id, nameBytes.length, ...nameBytes];
        break;
      }
      case 'remove_modbus_channel': {
        bytes = [0xff, 0xef, 0x00, params.channel_id & 0xff, 0x00];
        break;
      }
      case 'set_dst': {
        const { enable = 'disable', offset = 60, start_month = 3, start_week_num = 2,
                start_week_day = 7, start_time = 120, end_month = 10, end_week_num = 1,
                end_week_day = 7, end_time = 180 } = params;
        const en    = enable === 'enable' || enable === 1 ? 1 : 0;
        const data  = (en << 7) | (offset & 0x7f);
        const swb   = ((start_week_num & 0x0f) << 4) | (start_week_day & 0x0f);
        const ewb   = ((end_week_num   & 0x0f) << 4) | (end_week_day   & 0x0f);
        bytes = [
          0xf9, 0x72, data,
          en ? start_month : 0, en ? swb : 0,
          en ? start_time & 0xff : 0, en ? (start_time >> 8) & 0xff : 0,
          en ? end_month : 0, en ? ewb : 0,
          en ? end_time & 0xff : 0, en ? (end_time >> 8) & 0xff : 0,
        ];
        break;
      }
      case 'query_rule_config': {
        bytes = [0xf9, 0x77, params.rule_id & 0xff];
        break;
      }
      case 'batch_enable_rules':  bytes = this.buildBatchRules(params, 0x01); break;
      case 'batch_disable_rules': bytes = this.buildBatchRules(params, 0x02); break;
      case 'batch_remove_rules':  bytes = this.buildBatchRules(params, 0x03); break;

      default:
        throw new Error(`UC100: unsupported command: ${type}`);
    }

    return { data: Buffer.from(bytes).toString('base64'), fPort: 85 };
  }

  // ── Helpers: batch rules ──────────────────────────────────────────────────

  private buildBatchRules(params: any, subtype: number): number[] {
    let mask = 0;
    for (let r = 0; r < 16; r++) {
      const key = `rule_${r + 1}`;
      if (params[key] === 'yes' || params[key] === 1) mask |= (1 << r);
    }
    return [0xf9, 0x76, mask & 0xff, (mask >> 8) & 0xff, subtype];
  }

  // ── Helpers: Modbus value reading ─────────────────────────────────────────

  private readModbusValue(bytes: number[], offset: number, dataType: number, sign: number): number | string {
    switch (dataType) {
      case 0: case 1: return bytes[offset] === 1 ? 'on' : 'off';
      case 2: case 3: return sign ? this.i16(bytes, offset) : this.u16(bytes, offset);
      case 4: case 5: case 6: case 7:
        return sign ? this.i32(bytes, offset) : this.u32(bytes, offset);
      case 8: case 9:
        return sign ? this.i16(bytes, offset) : this.u16(bytes, offset);
      case 10: case 11: case 12: case 13:
        return this.readFloatLE(bytes, offset);
      case 14: case 15:
        return sign ? this.i16(bytes, offset) : this.u16(bytes, offset);
      case 16: case 17: case 18: case 19:
      case 20: case 21:
        return sign ? this.i32(bytes, offset) : this.u32(bytes, offset);
      case 22: case 23: case 24: case 25:
        return this.readFloatLE(bytes, offset);
      case 26: case 27: case 28: case 29:
      case 34: case 35: case 36: case 37:
        return this.readDoubleLE(bytes, offset);
      case 30: case 31: case 32: case 33:
      case 38: case 39: case 40: case 41:
        return sign ? this.readInt64LE(bytes, offset) : this.readUInt64LE(bytes, offset);
      default: return 0;
    }
  }

  private readModbusHistoryValue(bytes: number[], offset: number, regType: number, sign: number): number | string {
    // History uses same logic but always reads from 8-byte slot
    return this.readModbusValue(bytes, offset, regType, sign);
  }

  // ── Helpers: config readers ───────────────────────────────────────────────

  private readModbusChannelConfig(bytes: number[], offset: number): Record<string, any> {
    return {
      channel_id:       bytes[offset],
      slave_id:         bytes[offset + 1],
      register_address: this.u16(bytes, offset + 2),
      register_type:    REGISTER_TYPE_MAP[bytes[offset + 4]] ?? `unknown(${bytes[offset + 4]})`,
      sign:             ((bytes[offset + 5] >>> 4) & 1) === 1 ? 'signed' : 'unsigned',
      quantity:         bytes[offset + 5] & 0x0f,
    };
  }

  private readModbusSerialPortConfig(bytes: number[], offset: number): Record<string, any> {
    const parityMap: Record<number, string> = { 0: 'none', 1: 'odd', 2: 'even' };
    return {
      baud_rate: this.u32(bytes, offset),
      data_bits: bytes[offset + 4],
      stop_bits: bytes[offset + 5],
      parity:    parityMap[bytes[offset + 6]] ?? 'unknown',
    };
  }

  private readModbusConfig(bytes: number[], offset: number): Record<string, any> {
    const dirMap: Record<number, string> = { 0: 'active', 1: 'bidirectional' };
    const data = bytes[offset + 5];
    return {
      exec_interval:        this.u16(bytes, offset),
      max_response_time:    this.u16(bytes, offset + 2),
      retry_times:          bytes[offset + 4],
      pass_through_enable:  ((data >>> 4) & 1) === 1 ? 'enable' : 'disable',
      pass_through_direct:  dirMap[data & 1] ?? 'unknown',
      pass_through_port:    bytes[offset + 6],
    };
  }

  private readDstConfig(bytes: number[], offset: number): Record<string, any> {
    const data       = bytes[offset];
    const enable_val = (data >> 7) & 0x01;
    const dst: Record<string, any> = {
      enable: enable_val === 1 ? 'enable' : 'disable',
      offset: data & 0x7f,
    };
    if (enable_val === 1) {
      dst.start_month    = bytes[offset + 1];
      const swb          = bytes[offset + 2];
      dst.start_week_num = swb >> 4;
      dst.start_week_day = swb & 0x0f;
      dst.start_time     = this.u16(bytes, offset + 3);
      dst.end_month      = bytes[offset + 5];
      const ewb          = bytes[offset + 6];
      dst.end_week_num   = ewb >> 4;
      dst.end_week_day   = ewb & 0x0f;
      dst.end_time       = this.u16(bytes, offset + 7);
    }
    return dst;
  }

  private readRuleConfig(bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const v1 = bytes[offset];
    const v2 = bytes[offset + 1];

    const enable_val        = (v1 >>> 7) & 0x01;
    const rule_id           = v1 & 0x7f;
    const condition_or_act  = (v2 >>> 7) & 0x01;
    const rule_index        = (v2 >>> 4) & 0x07;
    const rule_type_val     = v2 & 0x0f;

    const rule: Record<string, any> = {
      rule_id,
      enable: enable_val === 1 ? 'enable' : 'disable',
    };

    const condTypeMap: Record<number, string> = { 0: 'none', 1: 'time', 2: 'modbus_value', 3: 'modbus_cmd', 4: 'message', 5: 'd2d', 6: 'reboot' };
    const actTypeMap:  Record<number, string> = { 0: 'none', 1: 'message', 2: 'd2d', 3: 'modbus_cmd', 4: 'report_status', 5: 'report_alarm', 6: 'reboot' };

    if (condition_or_act === 0x00) {
      // condition
      rule.condition = { type: condTypeMap[rule_type_val] ?? 'unknown' };
      switch (rule_type_val) {
        case 0x00: offset += 2; break;
        case 0x01: // time condition — 7 bytes
          rule.condition.time_condition = this.readTimeCondition(bytes, offset + 2);
          offset += 9; break;
        case 0x02: // modbus value condition — 18 bytes
          rule.condition.modbus_value_condition = this.readModbusValueCondition(bytes, offset + 2);
          offset += 20; break;
        case 0x03: { // modbus cmd condition
          const len = bytes[offset + 2];
          rule.condition.modbus_cmd_condition = { cmd: this.readAscii(bytes, offset + 3, len) };
          offset += 3 + len; break;
        }
        case 0x04: { // message condition
          const len = bytes[offset + 2];
          rule.condition.message_condition = { message: this.readAscii(bytes, offset + 3, len) };
          offset += 3 + len; break;
        }
        case 0x05: { // d2d condition — 3 bytes
          const d2d_cmd = bytes.slice(offset + 2, offset + 4).map(b => b.toString(16).padStart(2, '0')).join('');
          const d2dMap: Record<number, string> = { 0: 'any', 1: 'on', 2: 'off' };
          rule.condition.d2d_condition = { d2d_cmd, d2d_status: d2dMap[bytes[offset + 4]] ?? 'unknown' };
          offset += 5; break;
        }
        case 0x06: offset += 2; break; // reboot condition
        default:   offset += 2;
      }
    } else {
      // action
      const action: Record<string, any> = {
        type:       actTypeMap[rule_type_val] ?? 'unknown',
        index:      rule_index,
        delay_time: this.u32(bytes, offset + 2),
      };
      switch (rule_type_val) {
        case 0x00: offset += 6; break;
        case 0x01: { // message action
          const len = bytes[offset + 6];
          action.message_action = { message: this.readAscii(bytes, offset + 7, len) };
          offset += 7 + len; break;
        }
        case 0x02: { // d2d action
          const cmd = bytes.slice(offset + 6, offset + 8).map(b => b.toString(16).padStart(2, '0')).join('');
          action.d2d_action = { d2d_cmd: cmd };
          offset += 8; break;
        }
        case 0x03: { // modbus cmd action
          const len = bytes[offset + 6];
          action.modbus_cmd_action = { cmd: this.readAscii(bytes, offset + 7, len) };
          offset += 7 + len; break;
        }
        case 0x04: offset += 6; break; // report status
        case 0x05: { // report alarm action
          action.report_alarm_action = { release_enable: bytes[offset + 6] === 1 ? 'enable' : 'disable' };
          offset += 7; break;
        }
        case 0x06: offset += 6; break; // reboot action
        default:   offset += 6;
      }
      rule.action = [action];
    }

    return { data: rule, offset };
  }

  private readTimeCondition(bytes: number[], offset: number): Record<string, any> {
    const modeVal = bytes[offset];
    const modeMap: Record<number, string> = { 0: 'weekdays', 1: 'days' };
    const mask    = this.u32(bytes, offset + 1);
    const tc: Record<string, any> = {
      mode: modeMap[modeVal] ?? 'unknown',
      hour:   bytes[offset + 5],
      minute: bytes[offset + 6],
    };
    if (modeVal === 0) {
      tc.weekdays = Array.from({ length: 7 }, (_, i) => i + 1).filter(d => (mask >> (d - 1)) & 1);
    } else {
      tc.days = Array.from({ length: 31 }, (_, i) => i + 1).filter(d => (mask >> (d - 1)) & 1);
    }
    return tc;
  }

  private readModbusValueCondition(bytes: number[], offset: number): Record<string, any> {
    const chn_id       = bytes[offset];
    const cond_def     = bytes[offset + 1];
    const cond_val     = cond_def & 0x0f;
    const holding_mode = (cond_def >>> 4) & 0x01;
    const continue_t   = this.u32(bytes, offset + 2);
    const lock_t       = this.u32(bytes, offset + 6);
    const val1         = this.readFloatLE(bytes, offset + 10);
    const val2         = this.readFloatLE(bytes, offset + 14);

    const condMap: Record<number, string> = { 0: 'false', 1: 'true', 2: 'below', 3: 'above', 4: 'between', 5: 'outside', 6: 'change_with_time', 7: 'change_without_time' };
    const holdMap: Record<number, string> = { 0: 'below', 1: 'above' };

    const mc: Record<string, any> = {
      channel_id: chn_id,
      condition:  condMap[cond_val] ?? 'unknown',
      continue_time: continue_t,
      lock_time: lock_t,
    };
    if (cond_val < 5) mc.holding_mode = holdMap[holding_mode] ?? 'unknown';
    if (cond_val === 2 || cond_val === 4) mc.threshold_min = val1;
    if (cond_val === 3 || cond_val === 4) mc.threshold_max = val2;
    if (cond_val === 6 || cond_val === 7) { mc.mutation_duration = val1; mc.mutation = val2; }
    return mc;
  }

  // ── Low-level byte readers ────────────────────────────────────────────────

  private u16(bytes: number[], i: number): number {
    return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
  }
  private i16(bytes: number[], i: number): number {
    const v = this.u16(bytes, i);
    return v > 0x7fff ? v - 0x10000 : v;
  }
  private u32(bytes: number[], i: number): number {
    return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
  }
  private i32(bytes: number[], i: number): number {
    const v = this.u32(bytes, i);
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  private readFloatLE(bytes: number[], offset: number): number {
    const bits = (bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset];
    const sign = bits >>> 31 === 0 ? 1.0 : -1.0;
    const e    = (bits >>> 23) & 0xff;
    const m    = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
    return parseFloat((sign * m * Math.pow(2, e - 150)).toFixed(2));
  }
  private readDoubleLE(bytes: number[], offset: number): number {
    const low  = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
    const high = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
    const sign = high >>> 31 === 0 ? 1.0 : -1.0;
    const exp  = (high >>> 20) & 0x7ff;
    const hm   = high & 0xfffff;
    if (exp === 0) return sign * Math.pow(2, -1022) * (hm * Math.pow(2, -20) + low * Math.pow(2, -52));
    if (exp === 0x7ff) return hm === 0 && low === 0 ? sign * Infinity : NaN;
    return sign * Math.pow(2, exp - 1023) * (1 + hm * Math.pow(2, -20) + low * Math.pow(2, -52));
  }
  private readUInt64LE(bytes: number[], offset: number): number {
    const low  = this.u32(bytes, offset);
    const high = this.u32(bytes, offset + 4);
    return high < 0x200000 ? high * 0x100000000 + low : high * 0x100000000 + low; // best effort
  }
  private readInt64LE(bytes: number[], offset: number): number {
    const low  = this.u32(bytes, offset);
    const high = this.u32(bytes, offset + 4);
    if ((high & 0x80000000) === 0 && high < 0x200000) return high * 0x100000000 + low;
    return -((~high & 0x7fffffff) * 0x100000000 + (~low & 0xffffffff) + 1);
  }
  private readAscii(bytes: number[], offset: number, length: number): string {
    let str = '';
    for (let j = 0; j < length && (offset + j) < bytes.length; j++) {
      if (bytes[offset + j] === 0x00) break;
      str += String.fromCharCode(bytes[offset + j]);
    }
    return str;
  }
}