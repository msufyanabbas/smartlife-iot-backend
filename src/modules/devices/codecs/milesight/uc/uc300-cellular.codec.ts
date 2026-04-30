// src/modules/devices/codecs/milesight/uc300-cellular.codec.ts
// Milesight UC300 — Cellular UART Protocol Decoder
//
// This is a completely different framing from the LoRaWAN IPSO codec (uc300.codec.ts).
// It handles the 0x7E-framed serial protocol used over cellular transport.
//
// Frame structure:
//   0x7E          — start flag
//   type (1B)     — 0xF2=change report, 0xF3=attribute report, 0xF4=period report
//   length (2B LE)
//   <payload>
//   0x7E          — end flag
//
// F2 (change report):
//   version(1B) + timestamp(4B) + diMode(4 bits in 1B) + [hasDI: din(4 bits)] + [hasCounter: counters(uint32 each)] + doutEnabled(2 bits) + [hasDO: dout(2 bits)]
//
// F3 (attribute report):
//   version(1B) + ucpVersion(1B) + sn(16B) + hwVersion(4B) + fwVersion(4B) + imei(15B) + imsi(15B) + iccid(20B)
//
// F4 (period report):
//   version(1B) + timestamp(4B) + mobileSignal(1B)
//   + doutEnabled(2 bits) + [hasDO: dout(2 bits)]
//   + diMode(8 bits, 2-bit per channel) + [hasDI: din(4 bits)] + [hasCounter: counters]
//   + ainMode(16 bits, 2-bit per channel) + ain values (float32 if mode=1)
//   + sin entries until end: mode1(1B) + mode2(1B) + data...
//     mode1: index=bits[7:3], regType=REG_LABELS[bits[2:0]]
//     mode2: sign=bit7, collectSuccess=bit3, quantity=bits[2:0]
//
// SIN data by regType:
//   COIL, DISCRETE  → uint8 per item
//   INT16, INT32_AB, INT32_CD → int16/uint16 per item, ×quantity per time
//   INT32, HOLD_INT32, INPUT_INT32 → int32/uint32
//   FLOAT → float32

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const REG_LABELS = [
  'REG_COIL', 'REG_DISCRETE', 'REG_INPUT', 'REG_HOLD_INT16',
  'REG_HOLD_INT32', 'REG_HOLD_FLOAT', 'REG_INPUT_INT32', 'REG_INPUT_FLOAT',
  'REG_INPUT_INT32_AB', 'REG_INPUT_INT32_CD', 'REG_HOLD_INT32_AB', 'REG_HOLD_INT32_CD',
];

// ── Mini buffer reader ────────────────────────────────────────────────────────

class ByteReader {
  private readonly buf: number[];
  private pos = 0;

  constructor(bytes: number[]) { this.buf = bytes; }

  get remaining(): number { return this.buf.length - this.pos; }

  private advance(n: number): number {
    const p = this.pos;
    this.pos += n;
    if (this.pos > this.buf.length) throw new Error('Buffer overread');
    return p;
  }

  readUInt8(): number { return this.buf[this.advance(1)] & 0xff; }
  readInt8():  number { const v = this.readUInt8(); return v > 0x7f ? v - 0x100 : v; }

  readUInt16LE(): number {
    const p = this.advance(2);
    return ((this.buf[p + 1] << 8) | this.buf[p]) & 0xffff;
  }
  readInt16LE(): number { const v = this.readUInt16LE(); return v > 0x7fff ? v - 0x10000 : v; }

  readUInt32LE(): number {
    const p = this.advance(4);
    return (((this.buf[p + 3] << 24) | (this.buf[p + 2] << 16) | (this.buf[p + 1] << 8) | this.buf[p]) >>> 0);
  }
  readInt32LE(): number { const v = this.readUInt32LE(); return v > 0x7fffffff ? v - 0x100000000 : v; }

  readFloatLE(): number {
    const bits = this.readUInt32LE();
    const sign  = (bits >>> 31) === 0 ? 1.0 : -1.0;
    const e     = (bits >>> 23) & 0xff;
    const m     = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
    return parseFloat((sign * m * Math.pow(2, e - 150)).toFixed(6));
  }

  /** Read a byte and unpack `count` LSBs as individual bits array */
  readBits(count: number): number[] {
    const byte = this.readUInt8();
    const result: number[] = [];
    for (let i = 0; i < count; i++) result.push((byte >>> i) & 1);
    return result;
  }

  readString(length: number): string {
    const p = this.advance(length);
    let s = '';
    for (let i = p; i < p + length; i++) {
      if (this.buf[i] === 0) break;
      s += String.fromCharCode(this.buf[i]);
    }
    return s;
  }

  readHex(length: number): string {
    const p = this.advance(length);
    return this.buf.slice(p, p + length).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function moveDecimal(value: number, decimal: number): number {
  return decimal ? value / Math.pow(10, decimal) : value;
}

// ── Report decoders ───────────────────────────────────────────────────────────

function decodeChangeReport(reader: ByteReader): Record<string, any> {
  const version   = reader.readUInt8();
  const timestamp = reader.readUInt32LE();

  // 4 DI modes packed as 4 bits (2 per channel: 0=disabled,1=gpio,2=counter,3=counter)
  const diByte = reader.readUInt8();
  const diMode: number[] = [];
  for (let i = 0; i < 4; i++) diMode.push((diByte >>> (i * 2)) & 0x03);

  const hasDI      = diMode.some(m => m === 1);
  const hasCounter = diMode.some(m => m === 2 || m === 3);

  const din: number[]   = hasDI ? reader.readBits(4) : [];
  const counter: (number | null)[] = hasCounter
    ? diMode.map(m => (m === 2 || m === 3) ? reader.readUInt32LE() : null)
    : [];

  const doutByte    = reader.readUInt8();
  const doutEnabled = [(doutByte >>> 0) & 1, (doutByte >>> 1) & 1];
  const hasDO       = doutEnabled.some(v => v);
  const dout: number[] = hasDO ? reader.readBits(2) : [];

  return { version, timestamp, diMode, din, counter, doutEnabled, dout };
}

function decodeAttributeReport(reader: ByteReader): Record<string, any> {
  const version         = reader.readUInt8();
  const ucpVersion      = reader.readUInt8();
  const sn              = reader.readString(16);
  const hardwareVersion = reader.readString(4);
  const firmwareVersion = reader.readString(4);
  const imei            = reader.readString(15);
  const imsi            = reader.readString(15);
  const iccid           = reader.readString(20);
  return { version, ucpVersion, sn, hardwareVersion, firmwareVersion, imei, imsi, iccid };
}

function decodePeriodReport(reader: ByteReader): Record<string, any> {
  const version      = reader.readUInt8();
  const timestamp    = reader.readUInt32LE();
  const mobileSignal = reader.readUInt8();

  // DO: 2 channels
  const doutByte    = reader.readUInt8();
  const doutEnabled = [(doutByte >>> 0) & 1, (doutByte >>> 1) & 1];
  const hasDO       = doutEnabled.some(v => v);
  const dout: number[] = hasDO ? reader.readBits(2) : [];

  // DI: 8 channels × 2-bit mode (packed in 2 bytes, read as two nibbles' worth)
  const diByte1 = reader.readUInt8();
  const diByte2 = reader.readUInt8();
  const diMode: number[] = [];
  for (let i = 0; i < 4; i++) diMode.push((diByte1 >>> (i * 2)) & 0x03);
  for (let i = 0; i < 4; i++) diMode.push((diByte2 >>> (i * 2)) & 0x03);

  const hasDI      = diMode.some(m => m === 1);
  const hasCounter = diMode.some(m => m === 2 || m === 3);
  const din: number[] = hasDI ? reader.readBits(4) : [];
  const counter: (number | null)[] = hasCounter
    ? diMode.map(m => (m === 2 || m === 3) ? reader.readUInt32LE() : null)
    : [];

  // AIN: 8 channels × 2-bit mode (packed in 2 bytes)
  const ainByte1 = reader.readUInt8();
  const ainByte2 = reader.readUInt8();
  const ainMode: number[] = [];
  for (let i = 0; i < 4; i++) ainMode.push((ainByte1 >>> (i * 2)) & 0x03);
  for (let i = 0; i < 4; i++) ainMode.push((ainByte2 >>> (i * 2)) & 0x03);

  const ain = ainMode.map((mode, idx) =>
    mode === 1
      ? { index: idx + 1, count: 1, timeStep: 0, values: [reader.readFloatLE()] }
      : { index: idx + 1, count: 0, timeStep: 0, values: [] }
  );

  // SIN entries: read until 1 byte remains (end flag)
  const sin: any[] = [];
  while (reader.remaining > 1) {
    const mode1   = reader.readUInt8();
    const mode2   = reader.readUInt8();
    const index   = (mode1 >>> 3) & 0x1f;      // 5-bit index (v1.1 format)
    const regType = REG_LABELS[mode1 & 0x07] ?? 'UNKNOWN';
    const sign    = (mode2 >>> 7) & 1;
    const collectSuccess = ((mode2 >>> 3) & 1) === 1;
    const quantity = mode2 & 0x07;

    const values: number[][] = [];
    if (quantity > 0) {
      // One time-slice per entry in this simplified format
      const row: number[] = [];
      switch (regType) {
        case 'REG_COIL':
        case 'REG_DISCRETE':
          for (let q = 0; q < quantity; q++) row.push(reader.readUInt8()); break;
        case 'REG_INPUT':
        case 'REG_HOLD_INT16':
        case 'REG_INPUT_INT32_AB':
        case 'REG_INPUT_INT32_CD':
        case 'REG_HOLD_INT32_AB':
        case 'REG_HOLD_INT32_CD':
          for (let q = 0; q < quantity; q++) {
            const v = sign ? reader.readInt16LE() : reader.readUInt16LE();
            row.push(v);
          }
          break;
        case 'REG_HOLD_INT32':
        case 'REG_INPUT_INT32':
          for (let q = 0; q < quantity; q++) {
            const v = sign ? reader.readInt32LE() : reader.readUInt32LE();
            row.push(v);
          }
          break;
        case 'REG_HOLD_FLOAT':
        case 'REG_INPUT_FLOAT':
          for (let q = 0; q < quantity; q++) row.push(reader.readFloatLE()); break;
        default:
          break;
      }
      if (row.length > 0) values.push(row);
    }

    sin.push({ index: index + 1, regType, sign, collectSuccess, quantity, values });
  }

  return { version, timestamp, mobileSignal, doutEnabled, dout, diMode, din, counter, ainMode, ain, sin };
}

// ── Codec class ───────────────────────────────────────────────────────────────

export class MilesightUC300CellularCodec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-uc300-cellular';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['UC300-LTE', 'UC300-4G'];
  readonly protocol        = 'other' as const;
  readonly modelFamily = 'UC300';
  readonly imageUrl = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/uc-series/uc300/uc300.png';
  readonly category = 'UC300';


  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);

    // Validate 0x7E framing
    if (bytes.length < 5 || bytes[0] !== 0x7e || bytes[bytes.length - 1] !== 0x7e) {
      return {} as DecodedTelemetry;
    }

    const type   = bytes[1];
    const length = ((bytes[3] << 8) | bytes[2]) & 0xffff;
    const reader = new ByteReader(bytes.slice(4, 4 + length));

    let result: Record<string, any>;
    switch (type) {
      case 0xf2: result = decodeChangeReport(reader);    break;
      case 0xf3: result = decodeAttributeReport(reader); break;
      case 0xf4: result = decodePeriodReport(reader);    break;
      default:   result = { raw_type: `0x${type.toString(16)}` }; break;
    }

    return { start_flag: 0x7e, type: `0x${type.toString(16)}`, length, ...result, end_flag: 0x7e } as unknown as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // UC300 cellular protocol is uplink-only — no standardised downlink framing.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('UC300 cellular: no downlink commands supported via this codec');
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // UC300 cellular frames start and end with 0x7E and have type 0xF2/F3/F4.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 5) return false;
    if (bytes[0] !== 0x7e || bytes[bytes.length - 1] !== 0x7e) return false;
    const type = bytes[1];
    return type === 0xf2 || type === 0xf3 || type === 0xf4;
  }
}