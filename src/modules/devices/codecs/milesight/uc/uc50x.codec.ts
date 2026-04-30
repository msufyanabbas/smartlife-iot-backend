// src/modules/devices/codecs/milesight/uc50x.codec.ts
// Milesight UC50x — Multi-interface Controller (UC501/UC502/UC511/UC512)
// LoRaWAN IPSO protocol — covers the uc50x_decoder.js reference
//
// GPIO channels: [0x03, 0x04] → gpio_input_N / gpio_output_N / gpio_counter_N
// ADC channels:  [0x05, 0x06] → analog_input_N (v2: int16/1000, v3: float16)
// ADC alarm chns:[0x85, 0x86] → analog_input_N + alarm (float16, v3)
//
// Telemetry:
//   0xFF 0x01  — ipso_version
//   0xFF 0x09  — hardware_version
//   0xFF 0x0A  — firmware_version
//   0xFF 0xFF  — tsl_version
//   0xFF 0x16  — sn (8B)
//   0xFF 0x0F  — lorawan_class
//   0xFF 0xFE  — reset_event
//   0xFF 0x0B  — device_status
//   0x01 0x75  — battery (uint8 %)
//   <gpio> 0x00 — gpio_input_N (1B on/off)
//   <gpio> 0x01 — gpio_output_N (1B on/off)
//   <gpio> 0xC8 — gpio_counter_N (uint32 LE)
//   0xFF 0x14  — analog_input_N_type: chn_id packed in byte (upper 4 bits=id, lower 4=type)
//   <adc> 0x02  — analog_input_N v2: 4× int16 LE /1000 = 8B
//   <adc> 0xE2  — analog_input_N v3: 4× float16 LE = 8B
//   <adc_alarm> 0xE2 — analog_input_N v3 + alarm(1B)
//   0x08 0xDB  — sdi12_N: chn_id(1B) + 36B ASCII data
//   0xFF/0x80 0x0E — modbus: chn_id(1B)+pkg_type(1B)+data; 0x80 prefix adds alarm(1B)
//   0xFF 0x15  — modbus read error: (chn_id - 6)(1B)
//   0x20 0xDC  — GPIO/ADC history (fixed 22B structure)
//   0x20 0xDD  — Modbus history (bitmask 16b + 5B per chn)
//   0x20 0xE0  — SDI-12 history (bitmask 16b + 36B per chn)
//
// Downlink commands (UC300-style timezone encoding: hour×10):
//   0xFF 0x02  — set_collection_interval (uint16 LE, seconds)
//   0xFF 0x03  — set_report_interval (uint16 LE, seconds)
//   0xFF 0x10  — reboot
//   0xFF 0x11  — set_timestamp (uint32 LE)
//   0xFF 0x17  — set_time_zone (int16 LE, hour×10)
//   0xFF 0x27  — clear_history
//   0xFF 0x28  — report_status
//   0xFF 0x4A  — sync_time (trailing 0x00, not 0xFF)
//   0xFF 0x68  — set_history_enable
//   0xFF 0x69  — set_retransmit_enable
//   0xFF 0x6A  — set_retransmit/resend_interval
//   0xFD 0x6B  — fetch_history (start only)
//   0xFD 0x6C  — fetch_history (start + end)
//   0xFD 0x6D  — stop_transmit
//   0x03/0x04 <status> 0xFF 0xFF — gpio_output simple control

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Channel arrays ────────────────────────────────────────────────────────────
const GPIO_CHNS      = [0x03, 0x04];
const ADC_CHNS       = [0x05, 0x06];
const ADC_ALARM_CHNS = [0x85, 0x86];

function inArr(arr: number[], v: number): boolean { return arr.indexOf(v) !== -1; }

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function i32(b: number[], i: number): number { const v = u32(b, i); return v > 0x7fffffff ? v - 0x100000000 : v; }

function float32LE(b: number[], i: number): number {
  const bits = u32(b, i);
  const sign  = (bits >>> 31) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 23) & 0xff;
  const m     = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return parseFloat((sign * m * Math.pow(2, e - 150)).toFixed(2));
}

function float16LE(b: number[], i: number): number {
  const bits = u16(b, i);
  const sign  = (bits >>> 15) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 10) & 0x1f;
  const m     = e === 0 ? (bits & 0x3ff) << 1 : (bits & 0x3ff) | 0x400;
  return sign * m * Math.pow(2, e - 25);
}

function readString(b: number[], i: number, len: number): string {
  let s = '';
  for (let j = i; j < i + len && j < b.length; j++) {
    if (b[j] === 0) break;
    s += String.fromCharCode(b[j]);
  }
  return s;
}

// ── UC300-style timezone (hour×10) ────────────────────────────────────────────
const UC5X_TZ: Record<number, string> = {
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
function tzName(v: number): string { return UC5X_TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(UC5X_TZ)) if (n === name) return parseInt(k);
  return 80;
}

// ── Modbus value decoder (UC50x variant: old 0x0E protocol, chn_id subtract 6) ─
// pkg_type bits[2:0]=data_type; 0,1=on/off; 2,3=uint16; 4,6=uint32; 5,7=float32
function decodeModbus0E(b: number[], i: number): { value: number | string; size: number } {
  const dt = b[i + 1] & 0x07;
  switch (dt) {
    case 0: case 1: return { value: b[i + 2] === 1 ? 'on' : 'off', size: 1 };
    case 2: case 3: return { value: u16(b, i + 2),  size: 2 };
    case 4: case 6: return { value: u32(b, i + 2),  size: 4 };
    case 5: case 7: return { value: float32LE(b, i + 2), size: 4 };
    default:        return { value: 0, size: 1 };
  }
}

export class MilesightUC50xCodec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-uc50x';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC501', 'UC502', 'UC511', 'UC512'];
  readonly protocol        = 'lorawan' as const;
  readonly category       = 'IoT Controller' as const;
  readonly imageUrl      = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc501/uc501-v3.png';
  readonly modelFamily?: string = 'UC50x';

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

      // ── GPIO input (0x03/0x04 type=0x00) ──────────────────────────────────
      else if (inArr(GPIO_CHNS, ch) && ty === 0x00) {
        const id = ch - GPIO_CHNS[0] + 1;
        decoded[`gpio_input_${id}`] = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── GPIO output (0x03/0x04 type=0x01) ─────────────────────────────────
      else if (inArr(GPIO_CHNS, ch) && ty === 0x01) {
        const id = ch - GPIO_CHNS[0] + 1;
        decoded[`gpio_output_${id}`] = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── GPIO counter (0x03/0x04 type=0xC8) ───────────────────────────────
      else if (inArr(GPIO_CHNS, ch) && ty === 0xc8) {
        const id = ch - GPIO_CHNS[0] + 1;
        decoded[`gpio_counter_${id}`] = u32(bytes, i); i += 4;
      }

      // ── Analog input type (0xFF 0x14) — packed: upper 4 bits=chn, lower=type ─
      else if (ch === 0xff && ty === 0x14) {
        const packed = bytes[i] & 0xff;
        const chnId  = (packed >>> 4);
        const chnType = (packed & 0x0f) === 1 ? 'voltage' : 'current';
        decoded[`analog_input_${chnId}_type`] = chnType;
        i += 1;
      }

      // ── ADC v2 (0x05/0x06 type=0x02) — 4× int16 LE /1000 ────────────────
      else if (inArr(ADC_CHNS, ch) && ty === 0x02) {
        const id   = ch - ADC_CHNS[0] + 1;
        const name = `analog_input_${id}`;
        decoded[name]           = i16(bytes, i)     / 1000;
        decoded[`${name}_min`]  = i16(bytes, i + 2) / 1000;
        decoded[`${name}_max`]  = i16(bytes, i + 4) / 1000;
        decoded[`${name}_avg`]  = i16(bytes, i + 6) / 1000;
        i += 8;
      }

      // ── ADC v3 (0x05/0x06 type=0xE2) — 4× float16 LE ─────────────────────
      else if (inArr(ADC_CHNS, ch) && ty === 0xe2) {
        const id   = ch - ADC_CHNS[0] + 1;
        const name = `analog_input_${id}`;
        decoded[name]           = float16LE(bytes, i);
        decoded[`${name}_min`]  = float16LE(bytes, i + 2);
        decoded[`${name}_max`]  = float16LE(bytes, i + 4);
        decoded[`${name}_avg`]  = float16LE(bytes, i + 6);
        i += 8;
      }

      // ── ADC alarm v3 (0x85/0x86 type=0xE2) — 4× float16 + alarm(1B) ──────
      else if (inArr(ADC_ALARM_CHNS, ch) && ty === 0xe2) {
        const id   = ch - ADC_ALARM_CHNS[0] + 1;
        const name = `analog_input_${id}`;
        decoded[name]              = float16LE(bytes, i);
        decoded[`${name}_min`]     = float16LE(bytes, i + 2);
        decoded[`${name}_max`]     = float16LE(bytes, i + 4);
        decoded[`${name}_avg`]     = float16LE(bytes, i + 6);
        const alarmVal             = bytes[i + 8] & 0xff;
        const alarmMap: Record<number, string> = { 1: 'threshold alarm', 2: 'value change alarm' };
        decoded[`${name}_alarm`]   = alarmMap[alarmVal] ?? 'unknown';
        i += 9;
      }

      // ── SDI-12 (0x08 0xDB) — chn_id(1B) + 36B ASCII ─────────────────────
      else if (ch === 0x08 && ty === 0xdb) {
        const sdiId = (bytes[i] & 0xff) + 1;
        decoded[`sdi12_${sdiId}`] = readString(bytes, i + 1, 36);
        i += 37;
      }

      // ── Modbus channel (0xFF/0x80 0x0E) ───────────────────────────────────
      // [i]=chn_id (subtract 6 for logical id), [i+1]=pkg_type, [i+2..]=value
      // 0x80 prefix means alarm byte follows value
      else if ((ch === 0xff || ch === 0x80) && ty === 0x0e) {
        const modbusId = (bytes[i] & 0xff) - 6;
        const key      = `modbus_chn_${modbusId}`;
        const { value, size } = decodeModbus0E(bytes, i);
        decoded[key] = value;
        i += 2 + size; // skip chn_id + pkg_type + data
        if (ch === 0x80) {
          const alarmVal = bytes[i++] & 0xff;
          const alarmMap: Record<number, string> = { 0: 'threshold alarm', 1: 'value change alarm' };
          decoded[`${key}_alarm`] = alarmMap[alarmVal] ?? 'unknown';
        }
      }

      // ── Modbus read error (0xFF 0x15) ─────────────────────────────────────
      else if (ch === 0xff && ty === 0x15) {
        const modbusId = (bytes[i] & 0xff) - 6;
        decoded[`modbus_chn_${modbusId}_alarm`] = 'read error';
        i += 1;
      }

      // ── GPIO/ADC history (0x20 0xDC) — fixed 22B ─────────────────────────
      // ts(4) + gpio1_type(1)+gpio1_data(4) + gpio2_type(1)+gpio2_data(4) + ai1(4) + ai2(4)
      else if (ch === 0x20 && ty === 0xdc) {
        const ts = u32(bytes, i);
        const entry: Record<string, any> = { timestamp: ts };

        for (let g = 0; g < 2; g++) {
          const gType = bytes[i + 4 + g * 5] & 0xff;
          const gVal  = u32(bytes, i + 4 + g * 5 + 1);
          if (gType === 0x00)      entry[`gpio_input_${g + 1}`]   = gVal === 1 ? 'on' : 'off';
          else if (gType === 0x01) entry[`gpio_output_${g + 1}`]  = gVal === 1 ? 'on' : 'off';
          else if (gType === 0x02) entry[`gpio_counter_${g + 1}`] = gVal;
        }

        entry.analog_input_1 = i32(bytes, i + 14) / 1000;
        entry.analog_input_2 = i32(bytes, i + 18) / 1000;
        i += 22;

        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Modbus history (0x20 0xDD) — ts(4) + mask(2) + 5B per chn ─────────
      // Each modbus entry: type(1B) + value(4B)
      else if (ch === 0x20 && ty === 0xdd) {
        const ts      = u32(bytes, i);
        const maskRaw = u16(bytes, i + 4);
        i += 6;
        const entry: Record<string, any> = { timestamp: ts };
        for (let bit = 0; bit < 16; bit++) {
          if (!((maskRaw >>> bit) & 1)) continue;
          const dt  = bytes[i] & 0x07;
          const val = (dt === 5 || dt === 7) ? float32LE(bytes, i + 1) : u32(bytes, i + 1);
          entry[`modbus_chn_${bit + 1}`] = val;
          i += 5;
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── SDI-12 history (0x20 0xE0) — ts(4) + mask(2) + 36B per chn ────────
      else if (ch === 0x20 && ty === 0xe0) {
        const ts      = u32(bytes, i);
        const maskRaw = u16(bytes, i + 4);
        i += 6;
        const entry: Record<string, any> = { timestamp: ts };
        for (let bit = 0; bit < 16; bit++) {
          if (!((maskRaw >>> bit) & 1)) continue;
          entry[`sdi12_${bit + 1}`] = readString(bytes, i, 36);
          i += 36;
        }
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

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x02: data.collection_interval = u16(bytes, offset); offset += 2; break;
      case 0x03: data.report_interval     = u16(bytes, offset); offset += 2; break;
      case 0x10: data.reboot              = 'yes'; offset += 1; break;
      case 0x11: data.timestamp           = u32(bytes, offset); offset += 4; break;
      case 0x17: data.time_zone           = tzName(i16(bytes, offset)); offset += 2; break;
      case 0x27: data.clear_history       = 'yes'; offset += 1; break;
      case 0x28: data.report_status       = 'yes'; offset += 1; break;
      case 0x68: data.history_enable      = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69: data.retransmit_enable   = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const t = bytes[offset] & 0xff;
        if (t === 0) data.retransmit_interval = u16(bytes, offset + 1);
        else         data.resend_interval     = u16(bytes, offset + 1);
        offset += 3; break;
      }
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    const wu16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const wi16 = (v: number) => { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; };
    const wu32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

    switch (type) {
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;
      case 'set_report_interval':     bytes = [0xff, 0x03, ...wu16(params.report_interval ?? 300)]; break;
      case 'reboot':                  bytes = [0xff, 0x10, 0xff]; break;
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break; // NOTE: trailing 0x00 not 0xFF
      case 'report_status':           bytes = [0xff, 0x28, 0xff]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'set_timestamp':           bytes = [0xff, 0x11, ...wu32(params.timestamp ?? 0)]; break;
      case 'set_time_zone':           bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
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
      case 'stop_transmit': bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_gpio_output': {
        const idx    = params.index ?? 1; // 1 or 2
        const status = params.status === 'on' ? 1 : 0;
        if (idx < 1 || idx > 2) throw new Error('gpio output index must be 1 or 2');
        const chnIds = [0x03, 0x04];
        bytes = [chnIds[idx - 1], status, 0xff, 0xff]; break;
      }
      default:
        throw new Error(`UC50x: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC50x is uniquely identified by:
  //   0x05/0x06 0x02 — ADC v2 channels (int16/1000, not float16 like UC300)
  //   0x05/0x06 0xE2 — ADC v3 channels (float16)
  //   0x85/0x86 0xE2 — ADC alarm channels
  //   0x08 0xDB      — SDI-12 channel
  //   0x20 0xE0      — SDI-12 history

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (inArr(ADC_CHNS, ch)       && (ty === 0x02 || ty === 0xe2)) return true;
      if (inArr(ADC_ALARM_CHNS, ch) && ty === 0xe2)                  return true;
      if (ch === 0x08 && ty === 0xdb) return true;  // SDI-12
      if (ch === 0x20 && ty === 0xe0) return true;  // SDI-12 history
    }
    return false;
  }
}

// ── UC502 — identical protocol to UC501, thin subclass ────────────────────────
export class MilesightUC502Codec extends MilesightUC50xCodec {
  override readonly codecId: string          = 'milesight-uc502';
  override readonly supportedModels: string[] = ['UC502'];
}