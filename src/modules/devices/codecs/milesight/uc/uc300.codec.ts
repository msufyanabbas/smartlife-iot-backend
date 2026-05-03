// src/modules/devices/codecs/milesight/uc300.codec.ts
// Milesight UC300 — IoT Controller (GPIO×4 in, GPIO×2 out, PT100×2, ADC×2, ADV×2, Modbus×32)
//
// Protocol: IPSO channel_id + channel_type
//
// Channel arrays (decoder uses range membership):
//   gpio_input  chns: [0x03, 0x04, 0x05, 0x06]  → gpio_input_1..4 / gpio_counter_1..4
//   gpio_output chns: [0x07, 0x08]               → gpio_output_1..2
//   pt100       chns: [0x09, 0x0A]               → pt100_1..2
//   ai (ADC current) chns: [0x0B, 0x0C]          → adc_1..2
//   av (ADC voltage) chns: [0x0D, 0x0E]          → adv_1..2
//
// Telemetry:
//   <gpio_input chn> 0x00  — gpio_input_N (1B on/off)
//   <gpio_input chn> 0xC8  — gpio_counter_N (uint32 LE)
//   <gpio_output chn> 0x01 — gpio_output_N (1B on/off)
//   <pt100 chn> 0x67       — pt100_N (int16 LE /10)
//   <ai chn> 0x02          — adc_N (uint32 LE /100, current)
//   <av chn> 0x02          — adv_N (uint32 LE /100, voltage)
//   <ai chn> 0xE2          — adc_N + stats (4× float16 LE)
//   <av chn> 0xE2          — adv_N + stats (4× float16 LE)
//   <pt100 chn> 0xE2       — pt100_N + stats (4× float16 LE)
//   0xFF 0x19              — modbus: chn_id(1B)+data_len(1B)+data_type(1B)+data(N)
//                            data_type: bit7=signed, bits[6:0]=register type
//                            types: 0=coil,1=discrete,2/3=int16,4/6=int32,5/7=float32,
//                                   8/10=int32_AB,9/11=int32_CD
//   0xFF 0x15              — modbus read error: chn_id(1B) → modbus_chn_{id+1}_alarm
//   0x20 0xDC              — channel_history (bitmask-driven)
//   0x20 0xDD              — modbus_history (bitmask-driven)
//
// Downlink commands:
//   0xFF 0x02 — set_collection_interval (uint16 LE, seconds)
//   0xFF 0x03 — set_report_interval (uint16 LE, seconds)
//   0xFF 0x04 — rejoin
//   0xFF 0x10 — reboot
//   0xFF 0x11 — set_timestamp (uint32 LE)
//   0xFF 0x17 — set_time_zone (int16 LE, UC300 units: hour×10)
//   0xFF 0x4A — sync_time
//   0xFF 0x91 — set_jitter_config: chn_id(1B) + delay(uint32 LE)
//   0xFF 0x93 — gpio_output_N_control: idx(1B) + status(1B) + duration(uint32 LE)
//   0xFF 0x94 — report_status
//   0x07/0x08 <status> 0xFF — gpio_output_N simple control

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Channel range helpers ─────────────────────────────────────────────────────
const GPIO_IN_CHNS  = [0x03, 0x04, 0x05, 0x06];
const GPIO_OUT_CHNS = [0x07, 0x08];
const PT100_CHNS    = [0x09, 0x0a];
const AI_CHNS       = [0x0b, 0x0c];
const AV_CHNS       = [0x0d, 0x0e];

function includes(arr: number[], v: number): boolean { return arr.indexOf(v) !== -1; }

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(bytes: number[], i: number): number { return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff; }
function i16(bytes: number[], i: number): number { const v = u16(bytes, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(bytes: number[], i: number): number { return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0); }
function i32(bytes: number[], i: number): number { const v = u32(bytes, i); return v > 0x7fffffff ? v - 0x100000000 : v; }

function float32LE(bytes: number[], i: number): number {
  const bits = u32(bytes, i);
  const sign  = (bits >>> 31) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 23) & 0xff;
  const m     = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return parseFloat((sign * m * Math.pow(2, e - 150)).toFixed(2));
}

function float16LE(bytes: number[], i: number): number {
  const bits = u16(bytes, i);
  const sign  = (bits >>> 15) === 0 ? 1.0 : -1.0;
  const e     = (bits >>> 10) & 0x1f;
  const m     = e === 0 ? (bits & 0x3ff) << 1 : (bits & 0x3ff) | 0x400;
  return parseFloat((sign * m * Math.pow(2, e - 25)).toFixed(2));
}

function readAscii(bytes: number[], i: number, len: number): string {
  let s = '';
  for (let j = i; j < i + len && j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
  return s.replace(/\0/g, '');
}

// ── Timezone map (UC300-specific: hour×10 units) ──────────────────────────────
const UC300_TZ: Record<number, string> = {
  [-120]: 'UTC-12', [-110]: 'UTC-11', [-100]: 'UTC-10',  [-95]: 'UTC-9:30',
   [-90]: 'UTC-9',   [-80]: 'UTC-8',   [-70]: 'UTC-7',   [-60]: 'UTC-6',
   [-50]: 'UTC-5',   [-40]: 'UTC-4',   [-35]: 'UTC-3:30', [-30]: 'UTC-3',
   [-20]: 'UTC-2',   [-10]: 'UTC-1',     [0]: 'UTC',       [10]: 'UTC+1',
    [20]: 'UTC+2',    [30]: 'UTC+3',    [35]: 'UTC+3:30',  [40]: 'UTC+4',
    [45]: 'UTC+4:30', [50]: 'UTC+5',    [55]: 'UTC+5:30',  [57]: 'UTC+5:45',
    [60]: 'UTC+6',    [65]: 'UTC+6:30', [70]: 'UTC+7',     [80]: 'UTC+8',
    [90]: 'UTC+9',    [95]: 'UTC+9:30',[100]: 'UTC+10',   [105]: 'UTC+10:30',
   [110]: 'UTC+11',  [120]: 'UTC+12',  [127]: 'UTC+12:45',[130]: 'UTC+13',
   [140]: 'UTC+14',
};
function tzName(v: number): string { return UC300_TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(UC300_TZ)) if (n === name) return parseInt(k);
  return 80; // default UTC+8
}

// ── Modbus data decoder ───────────────────────────────────────────────────────
// data_type byte: bit7=signed, bits[6:0]=register type
// 0=coil,1=discrete → always consume 1B (on/off for coil)
// 2,3=int16 LE; 4,6=int32 LE; 5,7=float32 LE; 8,10=int32_AB; 9,11=int32_CD
// NOTE: 8/10 reads int16 from bytes[0..1], 9/11 reads int16 from bytes[2..3]
// data_len byte tells us total byte count (skip it, we use type to determine size)

function decodeModbusValue(bytes: number[], i: number, dataType: number): { value: number | string; size: number } {
  const signed  = (dataType >>> 7) & 1;
  const regType = dataType & 0x7f;
  switch (regType) {
    case 0: return { value: bytes[i] === 1 ? 'on' : 'off', size: 1 };
    case 1: return { value: signed ? (bytes[i] > 0x7f ? bytes[i] - 0x100 : bytes[i]) : (bytes[i] & 0xff), size: 1 };
    case 2:
    case 3: return { value: signed ? i16(bytes, i) : u16(bytes, i), size: 2 };
    case 4:
    case 6: return { value: signed ? i32(bytes, i) : u32(bytes, i), size: 4 };
    case 8:
    case 10: return { value: signed ? i16(bytes, i) : u16(bytes, i), size: 4 };      // AB: low word
    case 9:
    case 11: return { value: signed ? i16(bytes, i + 2) : u16(bytes, i + 2), size: 4 }; // CD: high word
    case 5:
    case 7: return { value: float32LE(bytes, i), size: 4 };
    default: return { value: 0, size: 1 };
  }
}

export class MilesightUC300Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc300';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC300'];
  readonly modelFamily?: string = 'UC300';
  readonly protocol        = 'lorawan' as const;
  readonly category       = 'IoT Controller' as const;
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc300/uc300.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'UC300',
    description:  'IoT Controller — 4× GPIO inputs, 2× GPIO outputs, PT100, ADC current/voltage, and Modbus',
    telemetryKeys: [
      { key: 'gpio_input_1',  label: 'GPIO Input 1',      type: 'string' as const, enum: ['on', 'off'] },
      { key: 'gpio_input_2',  label: 'GPIO Input 2',      type: 'string' as const, enum: ['on', 'off'] },
      { key: 'gpio_input_3',  label: 'GPIO Input 3',      type: 'string' as const, enum: ['on', 'off'] },
      { key: 'gpio_input_4',  label: 'GPIO Input 4',      type: 'string' as const, enum: ['on', 'off'] },
      { key: 'gpio_counter_1', label: 'GPIO Counter 1',   type: 'number' as const              },
      { key: 'gpio_counter_2', label: 'GPIO Counter 2',   type: 'number' as const              },
      { key: 'gpio_counter_3', label: 'GPIO Counter 3',   type: 'number' as const              },
      { key: 'gpio_counter_4', label: 'GPIO Counter 4',   type: 'number' as const              },
      { key: 'gpio_output_1', label: 'GPIO Output 1',     type: 'string' as const, enum: ['on', 'off'] },
      { key: 'gpio_output_2', label: 'GPIO Output 2',     type: 'string' as const, enum: ['on', 'off'] },
      { key: 'pt100_1',       label: 'PT100 Channel 1',   type: 'number' as const, unit: '°C'  },
      { key: 'pt100_2',       label: 'PT100 Channel 2',   type: 'number' as const, unit: '°C'  },
      { key: 'adc_1',         label: 'ADC Current 1',     type: 'number' as const, unit: 'mA'  },
      { key: 'adc_2',         label: 'ADC Current 2',     type: 'number' as const, unit: 'mA'  },
      { key: 'adv_1',         label: 'ADC Voltage 1',     type: 'number' as const, unit: 'V'   },
      { key: 'adv_2',         label: 'ADC Voltage 2',     type: 'number' as const, unit: 'V'   },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device',  params: [] },
      { type: 'report_status', label: 'Report Status',  params: [] },
      { type: 'sync_time',     label: 'Sync Time',      params: [] },
      { type: 'rejoin',        label: 'Rejoin Network', params: [] },
      {
        type:   'set_collection_interval',
        label:  'Set Collection Interval',
        params: [{ key: 'collection_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 10 }],
      },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Time Zone', type: 'string' as const, required: true, default: 'UTC+8' }],
      },
      {
        type:   'set_gpio_output',
        label:  'Set GPIO Output',
        params: [
          { key: 'index',  label: 'Index (1 or 2)', type: 'number' as const, required: true, default: 1, min: 1, max: 2 },
          { key: 'status', label: 'Status',          type: 'select' as const, required: true, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
        ],
      },
      {
        type:   'set_gpio_output_with_duration',
        label:  'Set GPIO Output with Duration',
        params: [
          { key: 'index',    label: 'Index (1 or 2)', type: 'number' as const, required: true, default: 1, min: 1, max: 2 },
          { key: 'status',   label: 'Status',          type: 'select' as const, required: true, options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
          { key: 'duration', label: 'Duration (ms)',   type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_jitter_config',
        label:  'Set Jitter Config',
        params: [
          { key: 'all',          label: 'All Channels (ms)',   type: 'number' as const, required: false },
          { key: 'gpio_input_1', label: 'GPIO Input 1 (ms)',   type: 'number' as const, required: false },
          { key: 'gpio_input_2', label: 'GPIO Input 2 (ms)',   type: 'number' as const, required: false },
          { key: 'gpio_input_3', label: 'GPIO Input 3 (ms)',   type: 'number' as const, required: false },
          { key: 'gpio_input_4', label: 'GPIO Input 4 (ms)',   type: 'number' as const, required: false },
        ],
      },
    ],
    uiComponents: [
      { type: 'value' as const,  label: 'GPIO Input 1',  keys: ['gpio_input_1']             },
      { type: 'value' as const,  label: 'GPIO Input 2',  keys: ['gpio_input_2']             },
      { type: 'value' as const,  label: 'GPIO Input 3',  keys: ['gpio_input_3']             },
      { type: 'value' as const,  label: 'GPIO Input 4',  keys: ['gpio_input_4']             },
      { type: 'toggle' as const, label: 'GPIO Output 1', keys: ['gpio_output_1'], command: 'set_gpio_output' },
      { type: 'toggle' as const, label: 'GPIO Output 2', keys: ['gpio_output_2'], command: 'set_gpio_output' },
      { type: 'value' as const,  label: 'PT100 1',       keys: ['pt100_1'],       unit: '°C' },
      { type: 'value' as const,  label: 'PT100 2',       keys: ['pt100_2'],       unit: '°C' },
      { type: 'value' as const,  label: 'ADC Current 1', keys: ['adc_1'],         unit: 'mA' },
      { type: 'value' as const,  label: 'ADC Current 2', keys: ['adc_2'],         unit: 'mA' },
      { type: 'value' as const,  label: 'ADC Voltage 1', keys: ['adv_1'],         unit: 'V'  },
      { type: 'value' as const,  label: 'ADC Voltage 2', keys: ['adv_2'],         unit: 'V'  },
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

      // ── GPIO input (0x03–0x06 type=0x00) — on/off ─────────────────────────
      else if (includes(GPIO_IN_CHNS, ch) && ty === 0x00) {
        const id = ch - GPIO_IN_CHNS[0] + 1;
        decoded[`gpio_input_${id}`] = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── GPIO counter (0x03–0x06 type=0xC8) — uint32 LE ────────────────────
      else if (includes(GPIO_IN_CHNS, ch) && ty === 0xc8) {
        const id = ch - GPIO_IN_CHNS[0] + 1;
        decoded[`gpio_counter_${id}`] = u32(bytes, i); i += 4;
      }

      // ── GPIO output (0x07–0x08 type=0x01) — on/off ────────────────────────
      else if (includes(GPIO_OUT_CHNS, ch) && ty === 0x01) {
        const id = ch - GPIO_OUT_CHNS[0] + 1;
        decoded[`gpio_output_${id}`] = bytes[i] === 1 ? 'on' : 'off'; i += 1;
      }

      // ── PT100 (0x09–0x0A type=0x67) — int16 LE /10 ────────────────────────
      else if (includes(PT100_CHNS, ch) && ty === 0x67) {
        const id = ch - PT100_CHNS[0] + 1;
        decoded[`pt100_${id}`] = i16(bytes, i) / 10; i += 2;
      }

      // ── ADC current (0x0B–0x0C type=0x02) — uint32 LE /100 ───────────────
      else if (includes(AI_CHNS, ch) && ty === 0x02) {
        const id = ch - AI_CHNS[0] + 1;
        decoded[`adc_${id}`] = u32(bytes, i) / 100; i += 4;
      }

      // ── ADC voltage (0x0D–0x0E type=0x02) — uint32 LE /100 ───────────────
      else if (includes(AV_CHNS, ch) && ty === 0x02) {
        const id = ch - AV_CHNS[0] + 1;
        decoded[`adv_${id}`] = u32(bytes, i) / 100; i += 4;
      }

      // ── PT100 stats (0x09–0x0A type=0xE2) — 4× float16 LE ─────────────────
      else if (includes(PT100_CHNS, ch) && ty === 0xe2) {
        const id   = ch - PT100_CHNS[0] + 1;
        const name = `pt100_${id}`;
        decoded[name]           = float16LE(bytes, i);
        decoded[`${name}_max`]  = float16LE(bytes, i + 2);
        decoded[`${name}_min`]  = float16LE(bytes, i + 4);
        decoded[`${name}_avg`]  = float16LE(bytes, i + 6);
        i += 8;
      }

      // ── ADC current stats (0x0B–0x0C type=0xE2) — 4× float16 LE ──────────
      else if (includes(AI_CHNS, ch) && ty === 0xe2) {
        const id   = ch - AI_CHNS[0] + 1;
        const name = `adc_${id}`;
        decoded[name]           = float16LE(bytes, i);
        decoded[`${name}_max`]  = float16LE(bytes, i + 2);
        decoded[`${name}_min`]  = float16LE(bytes, i + 4);
        decoded[`${name}_avg`]  = float16LE(bytes, i + 6);
        i += 8;
      }

      // ── ADC voltage stats (0x0D–0x0E type=0xE2) — 4× float16 LE ──────────
      else if (includes(AV_CHNS, ch) && ty === 0xe2) {
        const id   = ch - AV_CHNS[0] + 1;
        const name = `adv_${id}`;
        decoded[name]           = float16LE(bytes, i);
        decoded[`${name}_max`]  = float16LE(bytes, i + 2);
        decoded[`${name}_min`]  = float16LE(bytes, i + 4);
        decoded[`${name}_avg`]  = float16LE(bytes, i + 6);
        i += 8;
      }

      // ── Modbus channel (0xFF 0x19) ─────────────────────────────────────────
      // [i]=chn_id(0-based) [i+1]=data_len [i+2]=data_type [i+3..]=value
      else if (ch === 0xff && ty === 0x19) {
        const modbusId  = (bytes[i] & 0xff) + 1; // 1-based
        const dataLen   = bytes[i + 1] & 0xff;   // total data bytes incl. data_type
        const dataType  = bytes[i + 2] & 0xff;
        const key       = `modbus_chn_${modbusId}`;
        i += 3;
        const { value, size } = decodeModbusValue(bytes, i, dataType);
        decoded[key] = value;
        // advance by actual data size; dataLen-1 is remaining after data_type byte
        i += Math.max(size, (dataLen - 1));
      }

      // ── Modbus read error (0xFF 0x15) ─────────────────────────────────────
      else if (ch === 0xff && ty === 0x15) {
        const modbusId = (bytes[i] & 0xff) + 1;
        decoded[`modbus_chn_${modbusId}_alarm`] = 'read error';
        i += 1;
      }

      // ── Channel history (0x20 0xDC) ───────────────────────────────────────
      // ts(4B) + channel_mask(2B uint16 LE, bit0=gpio_in_1…)
      // then for each set bit: varying data per channel category
      else if (ch === 0x20 && ty === 0xdc) {
        const ts         = u32(bytes, i);
        const maskRaw    = u16(bytes, i + 4);
        i += 6;
        const entry: Record<string, any> = { timestamp: ts };

        for (let bit = 0; bit < 16; bit++) {
          if (!((maskRaw >>> bit) & 1)) continue;
          if (bit < 4) {
            // GPIO input or counter
            const mode = bytes[i++];
            if (mode === 0) {
              entry[`gpio_input_${bit + 1}`] = u32(bytes, i) === 1 ? 'on' : 'off';
            } else {
              entry[`gpio_counter_${bit + 1}`] = u32(bytes, i);
            }
            i += 4;
          } else if (bit < 6) {
            entry[`gpio_output_${bit - 4 + 1}`] = bytes[i] === 1 ? 'on' : 'off'; i += 1;
          } else if (bit < 8) {
            entry[`pt100_${bit - 6 + 1}`] = float16LE(bytes, i); i += 2;
          } else if (bit < 10) {
            const name = `adc_${bit - 8 + 1}`;
            entry[name]           = float16LE(bytes, i);
            entry[`${name}_max`]  = float16LE(bytes, i + 2);
            entry[`${name}_min`]  = float16LE(bytes, i + 4);
            entry[`${name}_avg`]  = float16LE(bytes, i + 6);
            i += 8;
          } else if (bit < 12) {
            const name = `adv_${bit - 10 + 1}`;
            entry[name]           = float16LE(bytes, i);
            entry[`${name}_max`]  = float16LE(bytes, i + 2);
            entry[`${name}_min`]  = float16LE(bytes, i + 4);
            entry[`${name}_avg`]  = float16LE(bytes, i + 6);
            i += 8;
          } else if (bit === 12) {
            // custom text message (48 bytes)
            entry.text = readAscii(bytes, i, 48); i += 48;
          }
        }
        if (!decoded.channel_history) decoded.channel_history = [];
        decoded.channel_history.push(entry);
      }

      // ── Modbus history (0x20 0xDD) ────────────────────────────────────────
      // ts(4B) + modbus_mask(4B uint32 LE, bit0=chn1…) + per-channel: data_type(1B)+value
      else if (ch === 0x20 && ty === 0xdd) {
        const ts      = u32(bytes, i);
        const maskRaw = u32(bytes, i + 4);
        i += 8;
        const entry: Record<string, any> = { timestamp: ts };

        for (let bit = 0; bit < 32; bit++) {
          if (!((maskRaw >>> bit) & 1)) continue;
          const dataType = bytes[i++] & 0xff;
          const key      = `modbus_chn_${bit + 1}`;
          const { value, size } = decodeModbusValue(bytes, i, dataType);
          entry[key] = value;
          i += size;
        }
        if (!decoded.modbus_history) decoded.modbus_history = [];
        decoded.modbus_history.push(entry);
      }

      // ── Downlink responses (0xFF / 0xFE) ──────────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Text / unknown — read rest as ASCII ────────────────────────────────
      else {
        decoded.text = readAscii(bytes, i - 2, bytes.length - (i - 2));
        i = bytes.length;
      }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x02:
        data.collection_interval = u16(bytes, offset); offset += 2; break;
      case 0x03:
        data.report_interval = u16(bytes, offset); offset += 2; break;
      case 0x11:
        data.timestamp = u32(bytes, offset); offset += 4; break;
      case 0x17:
        data.time_zone = tzName(i16(bytes, offset)); offset += 2; break;
      case 0x91: {
        const jitterChnMap: Record<number, string> = { 0: 'all', 1: 'gpio_input_1', 2: 'gpio_input_2', 3: 'gpio_input_3', 4: 'gpio_input_4', 5: 'gpio_output_1', 6: 'gpio_output_2' };
        const chnId = bytes[offset] & 0xff;
        const key   = jitterChnMap[chnId] ?? `channel_${chnId}`;
        if (!data.jitter_config) data.jitter_config = {};
        data.jitter_config[key] = u32(bytes, offset + 1);
        offset += 5; break;
      }
      case 0x93: {
        const idx  = bytes[offset] & 0xff;
        const stat = bytes[offset + 1] === 1 ? 'on' : 'off';
        const dur  = u32(bytes, offset + 2);
        data[`gpio_output_${idx}_control`] = { status: stat, duration: dur };
        offset += 6; break;
      }
      default:
        offset += 1; break;
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
      case 'set_collection_interval': {
        const v = params.collection_interval ?? 300;
        bytes = [0xff, 0x02, ...wu16(v)]; break;
      }
      case 'set_report_interval': {
        const v = params.report_interval ?? 300;
        bytes = [0xff, 0x03, ...wu16(v)]; break;
      }
      case 'rejoin':       bytes = [0xff, 0x04, 0xff]; break;
      case 'reboot':       bytes = [0xff, 0x10, 0xff]; break;
      case 'sync_time':    bytes = [0xff, 0x4a, 0xff]; break;
      case 'report_status': bytes = [0xff, 0x94, 0xff]; break;

      case 'set_timestamp': {
        const v = params.timestamp ?? 0;
        bytes = [0xff, 0x11, ...wu32(v)]; break;
      }
      case 'set_time_zone': {
        const v = tzValue(params.time_zone ?? 'UTC+8');
        bytes = [0xff, 0x17, ...wi16(v)]; break;
      }

      case 'set_jitter_config': {
        const jitterChnMap: Record<string, number> = { all: 0, gpio_input_1: 1, gpio_input_2: 2, gpio_input_3: 3, gpio_input_4: 4, gpio_output_1: 5, gpio_output_2: 6 };
        const result: number[] = [];
        for (const [key, chnId] of Object.entries(jitterChnMap)) {
          if (key in params) {
            result.push(0xff, 0x91, chnId, ...wu32(params[key]));
          }
        }
        bytes = result; break;
      }

      case 'set_gpio_output': {
        const idx    = params.index ?? 1; // 1 or 2
        const status = params.status === 'on' ? 1 : 0;
        const chnIds = [0x07, 0x08];
        if (idx < 1 || idx > 2) throw new Error('gpio output index must be 1 or 2');
        bytes = [chnIds[idx - 1], status, 0xff]; break;
      }

      case 'set_gpio_output_with_duration': {
        const idx      = params.index ?? 1;
        const status   = params.status === 'on' ? 1 : 0;
        const duration = params.duration ?? 0;
        if (idx < 1 || idx > 2) throw new Error('gpio output index must be 1 or 2');
        bytes = [0xff, 0x93, idx & 0xff, status, ...wu32(duration)]; break;
      }

      default:
        throw new Error(`UC300: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC300 is uniquely identified by:
  //   0xFF 0x19 — Modbus with data_length byte (UC300-specific modbus format)
  //   0x0B/0x0C 0x02 — ADC current channels
  //   0x0D/0x0E 0x02 — ADC voltage channels
  //   0x09/0x0A 0x67 — PT100 channels
  //   0x20 0xDC / 0x20 0xDD — history frames

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0xff && ty === 0x19) return true;   // UC300 Modbus protocol
      if (ch === 0x20 && ty === 0xdc) return true;   // channel history
      if (ch === 0x20 && ty === 0xdd) return true;   // modbus history
      if (includes(PT100_CHNS, ch) && ty === 0x67) return true; // PT100
      if (includes(AI_CHNS, ch)    && ty === 0x02) return true; // ADC current
      if (includes(AV_CHNS, ch)    && ty === 0x02) return true; // ADC voltage
    }
    return false;
  }
}