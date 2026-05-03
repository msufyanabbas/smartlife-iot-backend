// src/modules/devices/codecs/milesight/uc100v1.codec.ts
// Milesight UC100 v1 — IoT Controller (Modbus Gateway, legacy firmware)
//
// ── Protocol differences from UC100 v2 ───────────────────────────────────────
//
// UPLINK channels (all different from v2):
//   0xFF 0x19 — Modbus data: chn_id(1B) + data_size(1B) + data_def(1B) + value(N)
//               data_def: sign(7) | data_type(6:0)
//               data_type is a COMPRESSED group (not the same as register_type):
//                 0,1  → coil/discrete (1B)
//                 2,3  → input register 16-bit (2B)
//                 4,6  → int32 (4B)
//                 5,7  → float (4B)
//                 8-11 → partial read: int16 from 4B slot
//   0xFF 0xEE — Modbus alarm (v1.7+): chn_def(1B) + data_len(1B) + data_def(1B) + value(N)
//               chn_def: alarm_type(7:6) | chn_id(5:0)
//               data_def: sign(7) | data_type(6:0)  (same group encoding as 0xFF 0x19)
//   0xF9 0x5F — Modbus mutation (v1.9+): chn_def(1B) + 2 skip bytes + float(4B) = 7B total
//               chn_def: alarm_type(7:6) | chn_id(5:0)
//   0x20 0xCE — Modbus history (v1.7+): timestamp(4B) + chn_id(1B) + data_def(1B) + value(4B) = 10B
//               data_def: sign(7) | data_type(bits[6:2]) | read_status(bit1)
//               NOTE: data_type field is in bits[6:2], not bits[6:0] like the live channel
//   0x20 0xCD — Custom message history: timestamp(4B) + size(1B) + ASCII
//
// DOWNLINK differences from v2:
//   retransmit_interval: 0xFF 0x6A 0x00 <u16>  (v2 uses 0xF9 0x0D)
//   resend_interval:     0xFF 0x6A 0x01 <u16>  (v2 uses 0xF9 0x0E)
//   stop_transmit:       0xFD 0x6D 0xFF        (v2 does not have this)
//   NO: sync_time, report_status, timezone, DST, modbus_serial_config, rule engine
//
// canDecode fingerprint: 0xFF 0x19 (v1 Modbus channel) — absent in v2

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

// ── v1 uplink data_type → byte width consumed ─────────────────────────────────
// In v1 the data_type in the uplink is a compressed group code, not register_type
function v1DataWidth(dataType: number): number {
  if (dataType === 0 || dataType === 1)                 return 1;  // coil/discrete
  if (dataType === 2 || dataType === 3)                 return 2;  // input 16-bit
  if (dataType >= 4 && dataType <= 11)                  return 4;  // int32, float, or partial
  return 2;
}

function readV1ModbusValue(bytes: number[], offset: number, dataType: number, sign: number): number | string {
  switch (dataType) {
    case 0: case 1: return bytes[offset] === 1 ? 'on' : 'off';
    case 2: case 3: return sign ? readI16(bytes, offset) : readU16(bytes, offset);
    case 4: case 6: return sign ? readI32(bytes, offset) : readU32(bytes, offset);
    case 5: case 7: return readFloatLE(bytes, offset);
    case 8: case 9: case 10: case 11:
      // partial: int16 from 4-byte slot
      return sign ? readI16(bytes, offset) : readU16(bytes, offset);
    default: return 0;
  }
}

// v1 history data_def encoding differs: data_type in bits[6:2], read_status in bit1, sign in bit7
function readV1HistoryValue(bytes: number[], offset: number, dataType: number, sign: number): number | string {
  switch (dataType) {
    case 0: case 1:   return bytes[offset] === 1 ? 'on' : 'off';
    case 2: case 3:   return sign ? readI32(bytes, offset) : readU32(bytes, offset); // v1 stores as 32-bit in history
    case 14: case 15: return sign ? readI32(bytes, offset) : readU32(bytes, offset);
    case 4: case 5: case 6: case 7:
    case 16: case 17: case 18: case 19:
      return sign ? readI32(bytes, offset) : readU32(bytes, offset);
    case 8: case 9: case 20: case 21:
      return sign ? readI16(bytes, offset) : readU16(bytes, offset);
    case 10: case 11: case 12: case 13:
    case 22: case 23: case 24: case 25:
      return readFloatLE(bytes, offset);
    default: return 0;
  }
}

// ── Low-level readers ─────────────────────────────────────────────────────────
function readU16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function readI16(b: number[], i: number): number { const v = readU16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function readU32(b: number[], i: number): number { return (((b[i+3]<<24)|(b[i+2]<<16)|(b[i+1]<<8)|b[i])>>>0); }
function readI32(b: number[], i: number): number { const v = readU32(b, i); return v > 0x7fffffff ? v - 0x100000000 : v; }
function readFloatLE(b: number[], offset: number): number {
  const bits = (b[offset+3]<<24)|(b[offset+2]<<16)|(b[offset+1]<<8)|b[offset];
  const sign = bits >>> 31 === 0 ? 1.0 : -1.0;
  const e    = (bits >>> 23) & 0xff;
  const m    = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return parseFloat((sign * m * Math.pow(2, e - 150)).toFixed(2));
}
function readAscii(b: number[], offset: number, len: number): string {
  let s = '';
  for (let j = 0; j < len && (offset + j) < b.length; j++) {
    if (b[offset + j] === 0) break;
    s += String.fromCharCode(b[offset + j]);
  }
  return s;
}

const ALARM_MAP: Record<number, string> = { 0:'normal', 1:'threshold alarm', 2:'threshold release alarm', 3:'mutation alarm' };

export class MilesightUC100V1Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc100-v1';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC100'];
  readonly protocol        = 'lorawan' as const;
  readonly category = 'Controller';
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc100/uc100.png';
  readonly modelFamily = 'UC100';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'UC100',
    description:  'IoT Controller / Modbus Gateway (v1 firmware) — dynamic Modbus channel configuration',
    telemetryKeys: [
      // Modbus channels are dynamically named modbus_chn_N — expose the concept
      { key: 'modbus_chn_1',  label: 'Modbus Channel 1',  type: 'number' as const },
      { key: 'modbus_chn_2',  label: 'Modbus Channel 2',  type: 'number' as const },
      { key: 'modbus_chn_3',  label: 'Modbus Channel 3',  type: 'number' as const },
      { key: 'modbus_chn_4',  label: 'Modbus Channel 4',  type: 'number' as const },
      { key: 'modbus_chn_5',  label: 'Modbus Channel 5',  type: 'number' as const },
      { key: 'modbus_chn_6',  label: 'Modbus Channel 6',  type: 'number' as const },
      { key: 'modbus_chn_7',  label: 'Modbus Channel 7',  type: 'number' as const },
      { key: 'modbus_chn_8',  label: 'Modbus Channel 8',  type: 'number' as const },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'clear_history', label: 'Clear History', params: [] },
      { type: 'stop_transmit', label: 'Stop Transmit', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 600, min: 60 }],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmit_enable',
        label:  'Set Retransmit Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmit_interval',
        label:  'Set Retransmit Interval',
        params: [{ key: 'retransmit_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300 }],
      },
      {
        type:   'set_resend_interval',
        label:  'Set Resend Interval',
        params: [{ key: 'resend_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300 }],
      },
      {
        type:   'set_modbus_channel',
        label:  'Set Modbus Channel',
        params: [
          { key: 'channel_id',        label: 'Channel ID',         type: 'number' as const, required: true  },
          { key: 'slave_id',          label: 'Slave ID',           type: 'number' as const, required: true  },
          { key: 'register_address',  label: 'Register Address',   type: 'number' as const, required: true  },
          { key: 'register_type',     label: 'Register Type',      type: 'string' as const, required: true, default: 'MB_REG_HOLD_INT16_AB' },
          { key: 'quantity',          label: 'Quantity',           type: 'number' as const, required: false, default: 1 },
          { key: 'sign',              label: 'Sign',               type: 'select' as const, required: false, options: [{ label: 'Unsigned', value: 'unsigned' }, { label: 'Signed', value: 'signed' }] },
        ],
      },
      {
        type:   'set_modbus_channel_name',
        label:  'Set Modbus Channel Name',
        params: [
          { key: 'channel_id', label: 'Channel ID', type: 'number' as const, required: true },
          { key: 'name',       label: 'Name',       type: 'string' as const, required: true },
        ],
      },
      {
        type:   'remove_modbus_channel',
        label:  'Remove Modbus Channel',
        params: [{ key: 'channel_id', label: 'Channel ID', type: 'number' as const, required: true }],
      },
      {
        type:   'fetch_history',
        label:  'Fetch History',
        params: [
          { key: 'start_time', label: 'Start Time (Unix)', type: 'number' as const, required: true  },
          { key: 'end_time',   label: 'End Time (Unix)',   type: 'number' as const, required: false },
        ],
      },
    ],
    uiComponents: [
      { type: 'value' as const, label: 'Modbus Channel 1', keys: ['modbus_chn_1'] },
      { type: 'value' as const, label: 'Modbus Channel 2', keys: ['modbus_chn_2'] },
      { type: 'value' as const, label: 'Modbus Channel 3', keys: ['modbus_chn_3'] },
      { type: 'value' as const, label: 'Modbus Channel 4', keys: ['modbus_chn_4'] },
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

      // ── Attributes ────────────────────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++]; decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i]&0xff).toString(16)}.${(bytes[i+1]&0xff)>>4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i]&0xff).toString(16)}.${(bytes[i+1]&0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i+1]}`; i += 2; }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i+8).map(b => b.toString(16).padStart(2,'0')).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        decoded.lorawan_class = (['Class A','Class B','Class C','Class CtoB'])[bytes[i++]] ?? 'unknown';
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i++] === 1 ? 'reset' : 'normal'; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i++] === 1 ? 'on' : 'off'; }

      // ── Modbus data (0xFF 0x19) ───────────────────────────────────────────
      // chn_id(1B) + data_size(1B) + data_def(1B) + value(N)
      // data_def: sign(bit7) | data_type(bits6:0) — compressed group code
      else if (ch === 0xff && ty === 0x19) {
        const chn_id   = (bytes[i++] & 0xff) + 1;
        i++;                                              // skip data_size byte
        const data_def = bytes[i++];
        const sign     = (data_def >>> 7) & 0x01;
        const dtype    = data_def & 0x7f;
        const chn_name = `modbus_chn_${chn_id}`;
        decoded[chn_name] = readV1ModbusValue(bytes, i, dtype, sign);
        i += v1DataWidth(dtype);
      }

      // ── Modbus read error (0xFF 0x15) ─────────────────────────────────────
      else if (ch === 0xff && ty === 0x15) {
        const chn_id = (bytes[i++] & 0xff) + 1;
        decoded[`modbus_chn_${chn_id}_alarm`] = 'read error';
      }

      // ── Modbus alarm (0xFF 0xEE) v1.7+ ───────────────────────────────────
      // chn_def(1B) + data_len(1B) + data_def(1B) + value(N)
      // chn_def: alarm_type(7:6) | chn_id(5:0)
      // data_def: sign(7) | data_type(6:0) — same compressed encoding
      else if (ch === 0xff && ty === 0xee) {
        const chn_def    = bytes[i++];
        i++;                                              // skip data_len
        const data_def   = bytes[i++];
        const chn_id     = (chn_def & 0x3f) + 1;
        const alarm_val  = (chn_def >>> 6) & 0x03;
        const sign       = (data_def >>> 7) & 0x01;
        const dtype      = data_def & 0x7f;
        const chn_name   = `modbus_chn_${chn_id}`;
        decoded[`${chn_name}_alarm`] = ALARM_MAP[alarm_val] ?? 'unknown';
        decoded[chn_name]            = readV1ModbusValue(bytes, i, dtype, sign);
        i += v1DataWidth(dtype);
      }

      // ── Modbus mutation (0xF9 0x5F) v1.9+ ────────────────────────────────
      // chn_def(1B) + 2 skip bytes + float(4B) = 7B total
      // chn_def: alarm_type(7:6) | chn_id(5:0)
      // Only emitted when alarm_type === 3 (mutation alarm)
      else if (ch === 0xf9 && ty === 0x5f) {
        const chn_def   = bytes[i];
        const chn_id    = (chn_def & 0x3f) + 1;
        const alarm_val = (chn_def >>> 6) & 0x03;
        const chn_name  = `modbus_chn_${chn_id}`;
        if (alarm_val === 3) {
          decoded[`${chn_name}_alarm`]    = ALARM_MAP[3];
          decoded[`${chn_name}_mutation`] = readFloatLE(bytes, i + 3);
        }
        i += 7;
      }

      // ── Modbus history (0x20 0xCE) v1.7+ ─────────────────────────────────
      // timestamp(4B) + chn_id(1B) + data_def(1B) + value(4B) = 10B
      // data_def: sign(7) | data_type(bits[6:2]) | read_status(bit1)
      // NOTE: data_type is in bits[6:2] — different from the live channel's bits[6:0]
      else if (ch === 0x20 && ty === 0xce) {
        const ts       = readU32(bytes, i); i += 4;
        const chn_id   = (bytes[i++] & 0xff) + 1;
        const data_def = bytes[i++];
        const sign       = (data_def >>> 7) & 0x01;
        const dtype      = (data_def >> 2) & 0x1f;   // bits[6:2]
        const read_ok    = (data_def >>> 1) & 0x01;
        const chn_name   = `modbus_chn_${chn_id}`;

        const entry: Record<string, any> = { timestamp: ts };
        if (read_ok === 0) {
          entry[`${chn_name}_alarm`] = 'read error';
          i += 4;
        } else {
          entry[chn_name] = readV1HistoryValue(bytes, i, dtype, sign);
          i += 4;
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Custom message history (0x20 0xCD) ───────────────────────────────
      else if (ch === 0x20 && ty === 0xcd) {
        const ts     = readU32(bytes, i); i += 4;
        const len    = bytes[i++];
        const msg    = readAscii(bytes, i, len); i += len;
        if (!decoded.history) decoded.history = [];
        decoded.history.push({ timestamp: ts, custom_message: msg });
      }

      // ── Downlink responses (0xFE/0xFF) ────────────────────────────────────
      else if (ch === 0xfe || ch === 0xff) {
        const r = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, r.data); i = r.offset;
      }

      // ── Custom message (any other channel_id) ─────────────────────────────
      else {
        decoded.custom_message = readAscii(bytes, i - 2, bytes.length - (i - 2));
        i = bytes.length;
      }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const d: Record<string, any> = {};
    switch (ty) {
      case 0x03: d.report_interval = readU16(b, offset); offset += 2; break;
      case 0x04: d.confirm_mode_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x10: d.reboot = 'yes'; offset += 1; break;
      case 0x27: d.clear_history = 'yes'; offset += 1; break;
      case 0x68: d.history_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x69: d.retransmit_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x6a: {
        // 0xFF 0x6A type(1B) u16(2B) — retransmit_interval or resend_interval
        const sub = b[offset];
        const val = readU16(b, offset + 1); offset += 3;
        if (sub === 0x00) d.retransmit_interval = val;
        else if (sub === 0x01) d.resend_interval = val;
        break;
      }
      case 0xef: {
        const sub = b[offset];
        if (sub === 0x00) {
          if (!d.remove_modbus_channels) d.remove_modbus_channels = [];
          d.remove_modbus_channels.push({ channel_id: b[offset + 1] });
          offset += 4;
        } else if (sub === 0x01) {
          if (!d.modbus_channels) d.modbus_channels = [];
          d.modbus_channels.push(this.readModbusChannelConfig(b, offset + 1));
          offset += 7;
        } else if (sub === 0x02) {
          const chn_id = b[offset + 1];
          const len    = b[offset + 2];
          const name   = readAscii(b, offset + 3, len);
          if (!d.modbus_channels_name) d.modbus_channels_name = [];
          d.modbus_channels_name.push({ channel_id: chn_id, name });
          offset += 3 + len;
        }
        break;
      }
      default: offset += 1; break;
    }
    return { data: d, offset };
  }

  private readModbusChannelConfig(b: number[], offset: number): Record<string, any> {
    const signMap: Record<number, string>     = { 0:'unsigned', 1:'signed' };
    const regTypeMap: Record<number, string>  = {
      0:'MB_REG_COIL', 1:'MB_REG_DIS', 2:'MB_REG_INPUT_AB', 3:'MB_REG_INPUT_BA',
      4:'MB_REG_INPUT_INT32_ABCD', 5:'MB_REG_INPUT_INT32_BADC', 6:'MB_REG_INPUT_INT32_CDAB', 7:'MB_REG_INPUT_INT32_DCBA',
      8:'MB_REG_INPUT_INT32_AB', 9:'MB_REG_INPUT_INT32_CD',
      10:'MB_REG_INPUT_FLOAT_ABCD', 11:'MB_REG_INPUT_FLOAT_BADC', 12:'MB_REG_INPUT_FLOAT_CDAB', 13:'MB_REG_INPUT_FLOAT_DCBA',
      14:'MB_REG_HOLD_INT16_AB', 15:'MB_REG_HOLD_INT16_BA',
      16:'MB_REG_HOLD_INT32_ABCD', 17:'MB_REG_HOLD_INT32_BADC', 18:'MB_REG_HOLD_INT32_CDAB', 19:'MB_REG_HOLD_INT32_DCBA',
      20:'MB_REG_HOLD_INT32_AB', 21:'MB_REG_HOLD_INT32_CD',
      22:'MB_REG_HOLD_FLOAT_ABCD', 23:'MB_REG_HOLD_FLOAT_BADC', 24:'MB_REG_HOLD_FLOAT_CDAB', 25:'MB_REG_HOLD_FLOAT_DCBA',
    };
    const data = b[offset + 5];
    return {
      channel_id:       b[offset],
      slave_id:         b[offset + 1],
      register_address: readU16(b, offset + 2),
      register_type:    regTypeMap[b[offset + 4]] ?? `unknown(${b[offset + 4]})`,
      sign:             signMap[(data >>> 4) & 0x01] ?? 'unsigned',
      quantity:         data & 0x0f,
    };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'clear_history': bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 600;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;

      // v1-specific: 0xFF 0x6A subtype(1B) u16(2B)
      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 300;
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }
      case 'set_resend_interval': {
        const v = params.resend_interval ?? 300;
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'fetch_history': {
        const st = params.start_time ?? 0;
        const et = params.end_time ?? 0;
        if (!et) bytes = [0xfd, 0x6b, st&0xff,(st>>8)&0xff,(st>>16)&0xff,(st>>24)&0xff];
        else     bytes = [0xfd, 0x6c, st&0xff,(st>>8)&0xff,(st>>16)&0xff,(st>>24)&0xff,
                                      et&0xff,(et>>8)&0xff,(et>>16)&0xff,(et>>24)&0xff];
        break;
      }

      case 'set_modbus_channel': {
        const { channel_id, slave_id, register_address, register_type, quantity = 1, sign = 'unsigned' } = params;
        const regMap: Record<string, number> = {
          MB_REG_COIL:0, MB_REG_DIS:1, MB_REG_INPUT_AB:2, MB_REG_INPUT_BA:3,
          MB_REG_INPUT_INT32_ABCD:4, MB_REG_INPUT_INT32_BADC:5, MB_REG_INPUT_INT32_CDAB:6, MB_REG_INPUT_INT32_DCBA:7,
          MB_REG_INPUT_INT32_AB:8, MB_REG_INPUT_INT32_CD:9,
          MB_REG_INPUT_FLOAT_ABCD:10, MB_REG_INPUT_FLOAT_BADC:11, MB_REG_INPUT_FLOAT_CDAB:12, MB_REG_INPUT_FLOAT_DCBA:13,
          MB_REG_HOLD_INT16_AB:14, MB_REG_HOLD_INT16_BA:15,
          MB_REG_HOLD_INT32_ABCD:16, MB_REG_HOLD_INT32_BADC:17, MB_REG_HOLD_INT32_CDAB:18, MB_REG_HOLD_INT32_DCBA:19,
          MB_REG_HOLD_INT32_AB:20, MB_REG_HOLD_INT32_CD:21,
          MB_REG_HOLD_FLOAT_ABCD:22, MB_REG_HOLD_FLOAT_BADC:23, MB_REG_HOLD_FLOAT_CDAB:24, MB_REG_HOLD_FLOAT_DCBA:25,
        };
        const regTypeNum = typeof register_type === 'string' ? (regMap[register_type] ?? 0) : register_type;
        const signBit    = sign === 'signed' ? 1 : 0;
        const dataB      = ((signBit & 1) << 4) | (quantity & 0x0f);
        bytes = [
          0xff, 0xef, 0x01,
          channel_id & 0xff, slave_id & 0xff,
          register_address & 0xff, (register_address >> 8) & 0xff,
          regTypeNum & 0xff, dataB & 0xff,
        ]; break;
      }

      case 'set_modbus_channel_name': {
        const nameBytes = Array.from(params.name as string).map((c: string) => c.charCodeAt(0));
        bytes = [0xff, 0xef, 0x02, params.channel_id & 0xff, nameBytes.length, ...nameBytes]; break;
      }

      case 'remove_modbus_channel':
        // v1 encoder uses 4-byte remove (no trailing 0x00 padding seen in v2)
        bytes = [0xff, 0xef, 0x00, params.channel_id & 0xff]; break;

      default: throw new Error(`UC100v1: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // v1 is identified by 0xFF 0x19 (the v1 Modbus data channel).
  // v2 uses 0xF9 0x73 instead — these are mutually exclusive fingerprints.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x19) return true;
    }
    return false;
  }
}