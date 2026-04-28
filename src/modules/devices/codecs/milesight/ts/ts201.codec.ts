// src/modules/devices/codecs/milesight/ts201.codec.ts
// Milesight TS201 — Temperature Sensor (DS18B20 / SHT4X probe)
//
// Protocol: IPSO channel_id + channel_type
//
// Telemetry:
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//   0xFF 0xA0 — sensor_id: data(1B nibble-packed) + sn(8B) → 9B
//               bits[7:4]=channel_idx, bits[3:0]=sensor_type (1=DS18B20, 2=SHT4X)
//   0x01 0x75 — battery (uint8 %)
//   0x03 0x67 — temperature (int16 LE /10, °C)
//   0x83 0x67 — threshold alarm: temperature(2B) + alarm_type(1B) → stored in event[]
//   0x93 0x67 — mutation alarm:  temperature(2B) + mutation(2B /10) + alarm_type(1B) → event[]
//   0xB3 0x67 — sensor status exception: status(1B) → event[]
//   0x20 0xCE — history: ts(4B) + type(1B) + temperature(2B) → 7B
//               type byte: bits[7:4]=read_status, bits[3:0]=event_type
//
// Differences from TS101:
//   - report_interval in MINUTES (0xFF 0x8E 0x00 <uint16 LE>)
//   - Mutation alarm channel 0x93 0x67 (not 0x93 0xD7)
//   - Mutation value /10 (TS101 uses /100)
//   - Alarm config via 0xF9 0x0B (threshold) and 0xF9 0x0C (mutation)
//   - retransmit_config is compound object via 0xF9 0x0D
//   - resend_interval via 0xF9 0x0E
//   - calibration via 0xFF 0xEA with type bit (0=temp, 1=humidity)
//   - 0xF8/0xF9 extended downlinks with optional result byte
//   - History is 7B (not 6B), includes type byte

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }

function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

export class MilesightTS201Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-ts201';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['TS201'];
  readonly protocol        = 'lorawan' as const;

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
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Sensor ID (0xFF 0xA0) — nibble-packed: hi=channel_idx, lo=sensor_type ─
      else if (ch === 0xff && ty === 0xa0) {
        const data      = bytes[i] & 0xff;
        const chIdx     = (data >>> 4) & 0x0f;
        const stype     = data & 0x0f;
        const stypeMap: Record<number, string> = { 1:'DS18B20', 2:'SHT4X' };
        const sn        = bytes.slice(i + 1, i + 9).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        decoded[`sensor_${chIdx}_type`] = stypeMap[stype] ?? 'unknown';
        decoded[`sensor_${chIdx}_sn`]   = sn;
        i += 9;
      }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery = bytes[i] & 0xff; decoded.batteryLevel = decoded.battery; i += 1;
      }

      // ── Temperature (0x03 0x67) — normal reading ─────────────────────────────
      else if (ch === 0x03 && ty === 0x67) {
        decoded.temperature = i16(bytes, i) / 10; i += 2;
      }

      // ── Temperature threshold alarm (0x83 0x67) — pushed to event[] ──────────
      else if (ch === 0x83 && ty === 0x67) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = {
          temperature:       i16(bytes, i) / 10,
          temperature_alarm: alarmMap[bytes[i + 2] & 0xff] ?? 'unknown',
        };
        decoded.temperature = entry.temperature;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry);
        i += 3;
      }

      // ── Temperature mutation alarm (0x93 0x67) — pushed to event[] ───────────
      // NOTE: TS201 uses 0x93 0x67 (not 0xD7 like TS101), mutation /10 (not /100)
      else if (ch === 0x93 && ty === 0x67) {
        const alarmMap: Record<number, string> = { 0:'threshold alarm release',1:'threshold alarm',2:'mutation alarm' };
        const entry = {
          temperature:          i16(bytes, i) / 10,
          temperature_mutation: i16(bytes, i + 2) / 10,
          temperature_alarm:    alarmMap[bytes[i + 4] & 0xff] ?? 'unknown',
        };
        decoded.temperature = entry.temperature;
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry);
        i += 5;
      }

      // ── Temperature sensor status exception (0xB3 0x67) ─────────────────────
      else if (ch === 0xb3 && ty === 0x67) {
        const statusMap: Record<number, string> = { 0:'read error',1:'out of range' };
        const entry = { temperature_sensor_status: statusMap[bytes[i] & 0xff] ?? 'unknown' };
        if (!decoded.event) decoded.event = [];
        decoded.event.push(entry);
        i += 1;
      }

      // ── History (0x20 0xCE) — 7B: ts(4) + type(1) + temp(2) ─────────────────
      // type byte: bits[7:4]=read_status, bits[3:0]=event_type
      else if (ch === 0x20 && ty === 0xce) {
        const typeByte  = bytes[i + 4] & 0xff;
        const readSt    = (typeByte >>> 4) & 0x0f;
        const evType    = typeByte & 0x0f;
        const readMap:  Record<number, string> = { 0:'normal',1:'read error',2:'out of range' };
        const evMap:    Record<number, string> = { 1:'periodic event',2:'temperature alarm event',3:'temperature alarm release event' };
        const entry = {
          timestamp:   u32(bytes, i),
          read_status: readMap[readSt] ?? 'unknown',
          event_type:  evMap[evType]  ?? 'unknown',
          temperature: i16(bytes, i + 5) / 10,
        };
        i += 7;
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Standard downlink responses (0xFF / 0xFE) ────────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF8=with result, 0xF9=without) ─────────
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
    switch (ty) {
      case 0x02: data.collection_interval = u16(b, offset); offset += 2; break;
      case 0x10: data.reboot        = 'yes'; offset += 1; break;
      case 0x27: data.clear_history = 'yes'; offset += 1; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x4a: data.sync_time     = 'yes'; offset += 1; break;
      case 0x68: data.history_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e: data.report_interval = u16(b, offset + 1); offset += 3; break; // skip sub-type byte
      case 0xea: {
        const ctrl  = b[offset] & 0xff;
        const type  = ctrl & 0x01;      // 0=temperature, 1=humidity
        const enBit = (ctrl >>> 7) & 1;
        const raw   = i16(b, offset + 1);
        if (type === 0) {
          data.temperature_calibration_settings = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: raw / 10 };
        } else {
          data.humidity_calibration_settings    = { enable: enBit === 1 ? 'enable' : 'disable', calibration_value: raw / 2 };
        }
        offset += 3; break;
      }
      case 0xf2: data.alarm_report_counts  = u16(b, offset); offset += 2; break;
      case 0xf5: data.alarm_release_enable = b[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  private handleDownlinkExt(code: number, ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const condMap: Record<number, string> = { 0:'disable',1:'below',2:'above',3:'between',4:'outside' };

    switch (ty) {
      case 0x0b: { // temperature alarm config
        const dtype = b[offset] & 0xff;
        if (dtype === 0x01) {
          data.temperature_alarm_config = {
            condition:     condMap[b[offset + 1] & 0xff] ?? 'unknown',
            threshold_max: i16(b, offset + 2) / 10,
            threshold_min: i16(b, offset + 4) / 10,
            enable:        b[offset + 6] === 1 ? 'enable' : 'disable',
          };
        }
        offset += 7; break;
      }
      case 0x0c: { // temperature mutation alarm config
        const dtype = b[offset] & 0xff;
        if (dtype === 0x02) {
          data.temperature_mutation_alarm_config = {
            mutation: u16(b, offset + 1) / 10,
            enable:   b[offset + 3] === 1 ? 'enable' : 'disable',
          };
        }
        offset += 4; break;
      }
      case 0x0d: // retransmit config
        data.retransmit_config = { enable: b[offset] === 1 ? 'enable' : 'disable', interval: u16(b, offset + 1) };
        offset += 3; break;
      case 0x0e: data.resend_interval = u16(b, offset); offset += 2; break;
      case 0x31: {
        const sensorMap: Record<number, string> = { 0:'all',1:'sensor_1' };
        data.fetch_sensor_id = sensorMap[b[offset] & 0xff] ?? 'unknown'; offset += 1; break;
      }
      case 0x32: data.ack_retry_times = b[offset + 2] & 0xff; offset += 3; break;
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
      // TS201: sync_time trailing 0x00
      case 'sync_time':               bytes = [0xff, 0x4a, 0x00]; break;
      // TS201: report_interval in MINUTES via 0xFF 0x8E 0x00
      case 'set_report_interval':     bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 10)]; break;
      case 'set_collection_interval': bytes = [0xff, 0x02, ...wu16(params.collection_interval ?? 300)]; break;
      case 'set_history_enable':      bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;
      case 'clear_history':           bytes = [0xff, 0x27, 0x01]; break;
      case 'stop_transmit':           bytes = [0xfd, 0x6d, 0xff]; break;
      case 'set_alarm_release_enable': bytes = [0xff, 0xf5, params.enable === 'enable' ? 1 : 0]; break;
      case 'set_alarm_report_counts': bytes = [0xff, 0xf2, ...wu16(params.alarm_report_counts ?? 1)]; break;

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = end === 0
          ? [0xfd, 0x6b, ...wu32(start)]
          : [0xfd, 0x6c, ...wu32(start), ...wu32(end)];
        break;
      }

      // Calibration: 0xFF 0xEA, data byte bit0=type (0=temp, 1=humidity), bit7=enable
      case 'set_temperature_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        const ctrl   = (enBit << 7) | 0;                   // type=0 (temperature)
        const calRaw = Math.round((params.calibration_value ?? 0) * 10);
        bytes = [0xff, 0xea, ctrl & 0xff, ...wi16(calRaw)]; break;
      }
      case 'set_humidity_calibration': {
        const enBit  = params.enable === 'enable' ? 1 : 0;
        const ctrl   = (enBit << 7) | 1;                   // type=1 (humidity)
        const calRaw = Math.round((params.calibration_value ?? 0) * 2);
        bytes = [0xff, 0xea, ctrl & 0xff, ...wi16(calRaw)]; break;
      }

      // 0xF9-prefixed commands
      case 'set_temperature_alarm_config': {
        const condMap: Record<string, number> = { disable:0, below:1, above:2, between:3, outside:4 };
        const condVal = condMap[params.condition ?? 'below'] ?? 1;
        const maxRaw  = Math.round((params.threshold_max ?? 0) * 10);
        const minRaw  = Math.round((params.threshold_min ?? 0) * 10);
        bytes = [0xf9, 0x0b, 0x01, condVal & 0xff, ...wu16(maxRaw), ...wu16(minRaw), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_temperature_mutation_alarm_config': {
        const mutRaw = Math.round((params.threshold ?? 0) * 10);
        bytes = [0xf9, 0x0c, 0x02, ...wu16(mutRaw), params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_retransmit_config': {
        bytes = [0xf9, 0x0d, params.enable === 'enable' ? 1 : 0, ...wu16(params.interval ?? 60)]; break;
      }
      case 'set_resend_interval': bytes = [0xf9, 0x0e, ...wu16(params.resend_interval ?? 60)]; break;
      case 'fetch_sensor_id': {
        const sensorMap: Record<string, number> = { all: 0, sensor_1: 1 };
        bytes = [0xf9, 0x31, sensorMap[params.fetch_sensor_id ?? 'all'] ?? 0]; break;
      }
      case 'set_ack_retry_times': bytes = [0xf9, 0x32, 0x00, 0x00, params.ack_retry_times & 0xff]; break;

      default:
        throw new Error(`TS201: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // TS201 is uniquely identified by:
  //   0x03 0x67 — temperature on channel 3 (shared with TS101)
  //   0x83 0x67 — threshold alarm
  //   0x93 0x67 — mutation alarm (TS201 uses 0x67, TS101 uses 0xD7 — disambiguates)
  //   0xB3 0x67 — sensor status
  //   0xFF 0xA0 — sensor ID channel (TS201-specific)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0x93 && ty === 0x67) return true; // mutation 0x67 = TS201 only
      if (ch === 0xb3 && ty === 0x67) return true; // sensor status
      if (ch === 0xff && ty === 0xa0) return true; // sensor ID
    }
    return false;
  }
}