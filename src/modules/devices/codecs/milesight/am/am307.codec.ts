// src/modules/devices/codecs/milesight/am307.codec.ts
/**
 * Milesight AM307 Codec
 * Ambience Monitoring Sensor — Temperature + Humidity + PIR + Light + CO₂ + TVOC + Pressure
 *
 * Uses IPSO linear walk architecture (same as AM10x series), NOT command-dispatch (AM30xL).
 *
 * Key channel differences from other AM sensors:
 *   PIR:     0x05 0x00 — simple 1-byte status (0=idle, 1=trigger)
 *   Light:   0x06 0xCB — light_level uint8 (0–5 scale, same byte as AM304L als_level)
 *   CO₂:     0x07 0x7D — uint16 LE ppm
 *   TVOC:    0x08 0x7D — uint16 LE / 100 = iaq   (mode 0)
 *            0x08 0xE6 — uint16 LE raw  = µg/m³  (mode 1)
 *   Pressure:0x09 0x73 — uint16 LE / 10 = hPa
 *   Buzzer:  0x0E 0x01 — buzzer_status uint8
 *
 * History records (16 bytes each):
 *   0x20 0xCE — TVOC in iaq units (uint16/100)
 *   0x21 0xCE — TVOC in µg/m³ units (uint16 raw)
 *   Layout: timestamp(4B) + temperature(2B) + humidity(2B) + pir(1B) +
 *           light_level(1B) + co2(2B) + tvoc(2B) + pressure(2B)
 *
 * canDecode fingerprint: 0x08 0x7D (TVOC iaq) or 0x08 0xE6 (TVOC µg/m³)
 * — these channels don't appear in AM10x or AM30xL families.
 *
 * Reference payload: "0367EE00 04687C 050001 06CB02 077DA803 087D2500 09736627"
 *   → { temperature:23.8, humidity:62, pir:"trigger", light_level:2,
 *        co2:936, tvoc:0.37, pressure:1008.6 }
 *
 * Based on official Milesight AM307(v2) decoder/encoder
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

const TIMEZONE_MAP: Record<string, string> = {
  '-120': 'UTC-12', '-110': 'UTC-11', '-100': 'UTC-10', '-95': 'UTC-9:30',
  '-90': 'UTC-9',   '-80': 'UTC-8',   '-70': 'UTC-7',   '-60': 'UTC-6',
  '-50': 'UTC-5',   '-40': 'UTC-4',   '-35': 'UTC-3:30','-30': 'UTC-3',
  '-20': 'UTC-2',   '-10': 'UTC-1',   '0': 'UTC',       '10': 'UTC+1',
  '20': 'UTC+2',    '30': 'UTC+3',    '35': 'UTC+3:30', '40': 'UTC+4',
  '45': 'UTC+4:30', '50': 'UTC+5',    '55': 'UTC+5:30', '57': 'UTC+5:45',
  '60': 'UTC+6',    '65': 'UTC+6:30', '70': 'UTC+7',    '80': 'UTC+8',
  '90': 'UTC+9',    '95': 'UTC+9:30', '100': 'UTC+10',  '105': 'UTC+10:30',
  '110': 'UTC+11',  '120': 'UTC+12',  '127': 'UTC+12:45','130': 'UTC+13',
  '140': 'UTC+14',
};

export class MilesightAM307Codec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-am307';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['AM307'];
  readonly protocol = 'lorawan' as const;
  readonly category: string = 'Ambience Monitoring';
  readonly modelFamily: string = 'AM307';
  readonly imageUrl: string = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/am-series/am307/am307.png';

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'AM307',
    description:  'Ambience Monitoring Sensor — Temperature, Humidity, PIR, Light Level, CO₂, TVOC, and Pressure',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'   },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C'  },
      { key: 'humidity',    label: 'Humidity',    type: 'number' as const, unit: '%'   },
      { key: 'pir',         label: 'PIR',         type: 'string' as const, enum: ['idle', 'trigger'] },
      { key: 'light_level', label: 'Light Level', type: 'number' as const              },
      { key: 'co2',         label: 'CO₂',         type: 'number' as const, unit: 'ppm' },
      { key: 'tvoc',        label: 'TVOC',        type: 'number' as const              },
      { key: 'tvoc_unit',   label: 'TVOC Unit',   type: 'string' as const              },
      { key: 'pressure',    label: 'Pressure',    type: 'number' as const, unit: 'hPa' },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'stop_buzzer',   label: 'Stop Buzzer',   params: [] },
      { type: 'query_status',  label: 'Query Status',  params: [] },
      { type: 'stop_transmit', label: 'Stop Transmit', params: [] },
      { type: 'clear_history', label: 'Clear History', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60, max: 86400 }],
      },
      {
        type:   'set_time_sync',
        label:  'Set Time Sync',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'offset', label: 'UTC Offset (tenths of hours)', type: 'number' as const, required: true, default: 0 }],
      },
      {
        type:   'set_tvoc_unit',
        label:  'Set TVOC Unit',
        params: [{ key: 'unit', label: 'Unit', type: 'select' as const, required: true, options: [{ label: 'IAQ', value: 'iaq' }, { label: 'µg/m³', value: 'µg/m³' }] }],
      },
      {
        type:   'set_co2_abc_calibration',
        label:  'Set CO₂ ABC Calibration',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_co2_calibration_enable',
        label:  'Set CO₂ Calibration Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_co2_calibration_settings',
        label:  'Set CO₂ Calibration Settings',
        params: [
          { key: 'mode',              label: 'Mode',                    type: 'select' as const, required: true,  options: [{ label: 'Factory', value: 'factory' }, { label: 'ABC', value: 'abc' }, { label: 'Manual', value: 'manual' }, { label: 'Background', value: 'background' }, { label: 'Zero', value: 'zero' }] },
          { key: 'calibration_value', label: 'Calibration Value (ppm)', type: 'number' as const, required: false },
        ],
      },
      {
        type:   'set_buzzer',
        label:  'Set Buzzer',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_led_indicator',
        label:  'Set LED Indicator',
        params: [{ key: 'mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Off', value: 'off' }, { label: 'On', value: 'on' }, { label: 'Blink', value: 'blink' }] }],
      },
      {
        type:   'set_screen_display',
        label:  'Set Screen Display',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_retransmit_enable',
        label:  'Set Retransmit Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_history_enable',
        label:  'Set History Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
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
      { type: 'gauge' as const, label: 'Battery',     keys: ['battery'],     unit: '%'   },
      { type: 'value' as const, label: 'Temperature', keys: ['temperature'], unit: '°C'  },
      { type: 'value' as const, label: 'Humidity',    keys: ['humidity'],    unit: '%'   },
      { type: 'value' as const, label: 'PIR',         keys: ['pir']                      },
      { type: 'value' as const, label: 'Light Level', keys: ['light_level']              },
      { type: 'gauge' as const, label: 'CO₂',         keys: ['co2'],         unit: 'ppm' },
      { type: 'value' as const, label: 'TVOC',        keys: ['tvoc']                     },
      { type: 'value' as const, label: 'Pressure',    keys: ['pressure'],    unit: 'hPa' },
    ],
  };
}

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ──────────────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] & 0xf0) >> 4}.${bytes[i] & 0x0f}`;
        i += 1;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // TEMPERATURE (0x03 0x67) — int16 LE / 10 = °C
      else if (ch === 0x03 && ty === 0x67) {
        const raw = (bytes[i + 1] << 8) | bytes[i];
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }

      // HUMIDITY (0x04 0x68) — uint8 / 2 = %rH
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }

      // PIR (0x05 0x00) — simple status byte: 0=idle, 1=trigger
      else if (ch === 0x05 && ty === 0x00) {
        decoded.pir = bytes[i] === 1 ? 'trigger' : 'idle';
        i += 1;
      }

      // LIGHT LEVEL (0x06 0xCB) — uint8 (0–5 scale)
      else if (ch === 0x06 && ty === 0xcb) {
        decoded.light_level = bytes[i] & 0xff;
        i += 1;
      }

      // CO₂ (0x07 0x7D) — uint16 LE ppm
      else if (ch === 0x07 && ty === 0x7d) {
        decoded.co2 = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        i += 2;
      }

      // TVOC iaq (0x08 0x7D) — uint16 LE / 100
      else if (ch === 0x08 && ty === 0x7d) {
        decoded.tvoc      = (((bytes[i + 1] << 8) | bytes[i]) & 0xffff) / 100;
        decoded.tvoc_unit = 'iaq';
        i += 2;
      }

      // TVOC µg/m³ (0x08 0xE6) — uint16 LE raw
      else if (ch === 0x08 && ty === 0xe6) {
        decoded.tvoc      = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.tvoc_unit = 'µg/m³';
        i += 2;
      }

      // PRESSURE (0x09 0x73) — uint16 LE / 10 = hPa
      else if (ch === 0x09 && ty === 0x73) {
        decoded.pressure = (((bytes[i + 1] << 8) | bytes[i]) & 0xffff) / 10;
        i += 2;
      }

      // BUZZER STATUS (0x0E 0x01)
      else if (ch === 0x0e && ty === 0x01) {
        decoded.buzzer_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // HISTORY (iaq mode) — 0x20 0xCE, 16 bytes
      else if (ch === 0x20 && ty === 0xce) {
        const rec = this.decodeHistoryRecord(bytes, i, false);
        i += 16;
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(rec);
      }

      // HISTORY (µg/m³ mode) — 0x21 0xCE, 16 bytes
      else if (ch === 0x21 && ty === 0xce) {
        const rec = this.decodeHistoryRecord(bytes, i, true);
        i += 16;
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(rec);
      }

      // DOWNLINK RESPONSE
      else if (ch === 0xfe || ch === 0xff) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded;
  }

  // ── History record decoder ─────────────────────────────────────────────

  private decodeHistoryRecord(bytes: number[], i: number, luxMode: boolean): Record<string, any> {
    const ts   = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
    const rawT = (bytes[i + 5] << 8) | bytes[i + 4];
    const temp = (rawT > 0x7fff ? rawT - 0x10000 : rawT) / 10;
    const hum  = (((bytes[i + 7] << 8) | bytes[i + 6]) & 0xffff) / 2;
    const pir  = bytes[i + 8] === 1 ? 'trigger' : 'idle';
    const ligh = bytes[i + 9] & 0xff;
    const co2  = ((bytes[i + 11] << 8) | bytes[i + 10]) & 0xffff;
    const tvocRaw = ((bytes[i + 13] << 8) | bytes[i + 12]) & 0xffff;
    const tvoc = luxMode ? tvocRaw : tvocRaw / 100;
    const pres = (((bytes[i + 15] << 8) | bytes[i + 14]) & 0xffff) / 10;

    return {
      timestamp:   ts,
      temperature: temp,
      humidity:    hum,
      pir,
      light_level: ligh,
      co2,
      tvoc,
      tvoc_unit:   luxMode ? 'µg/m³' : 'iaq',
      pressure:    pres,
    };
  }

  // ── Downlink response handler ─────────────────────────────────────────────

  private handleDownlinkResponse(
    ty: number,
    bytes: number[],
    offset: number,
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x03:
        data.report_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x10:
        data.reboot = 'yes';
        offset += 1;
        break;

      case 0x17: {
        const raw = (bytes[offset + 1] << 8) | bytes[offset];
        const tz  = raw > 0x7fff ? raw - 0x10000 : raw;
        data.time_zone = TIMEZONE_MAP[String(tz)] ?? `UTC offset ${tz}`;
        offset += 2;
        break;
      }

      case 0x1a: {
        const modeVal  = bytes[offset] & 0xff;
        const modeMap: Record<number, string> = { 0: 'factory', 1: 'abc', 2: 'manual', 3: 'background', 4: 'zero' };
        data.co2_calibration_settings = { mode: modeMap[modeVal] ?? 'unknown' };
        if (modeVal === 2) {
          data.co2_calibration_settings.calibration_value = ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff;
          offset += 3;
        } else {
          offset += 1;
        }
        break;
      }

      case 0x25: {
        const bits = bytes[offset++];
        data.child_lock_settings = {
          off_button:        bits & 0x01 ? 'enable' : 'disable',
          on_button:         (bits >> 1) & 0x01 ? 'enable' : 'disable',
          collection_button: (bits >> 2) & 0x01 ? 'enable' : 'disable',
        };
        break;
      }

      case 0x27:
        data.clear_history = 'yes';
        offset += 1;
        break;

      case 0x2c:
        data.query_status = 'yes';
        offset += 1;
        break;

      case 0x2d:
        data.screen_display_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x2e: {
        const modeMap: Record<number, string> = { 0: 'off', 1: 'on', 2: 'blink' };
        data.led_indicator_mode = modeMap[bytes[offset]] ?? 'unknown';
        offset += 1;
        break;
      }

      case 0x39:
        data.co2_abc_calibration_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 5; // skip 4 reserved bytes
        break;

      case 0x3a:
        data.report_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x3b:
        data.time_sync_enable = bytes[offset] === 2 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x3c:
        data.screen_display_pattern = bytes[offset] & 0xff;
        offset += 1;
        break;

      case 0x3d:
        data.stop_buzzer = 'yes';
        offset += 1;
        break;

      case 0x3e:
        data.buzzer_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x66:
        data.screen_display_alarm_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x68:
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x69:
        data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x6a: {
        const itype = bytes[offset] & 0xff;
        const ival  = ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff;
        if (itype === 0) data.retransmit_interval = ival;
        else             data.resend_interval     = ival;
        offset += 3;
        break;
      }

      case 0x6d:
        data.stop_transmit = 'yes';
        offset += 1;
        break;

      case 0xeb: {
        const unitMap: Record<number, string> = { 0: 'iaq', 1: 'µg/m³' };
        data.tvoc_unit = unitMap[bytes[offset]] ?? 'unknown';
        offset += 1;
        break;
      }

      case 0xf0: {
        const mask = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        const dval = ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff;
        const bits: Record<string, number> = { temperature: 0, humidity: 1, co2: 2, light: 3, tvoc: 4, smile: 5, letter: 6 };
        const elem: Record<string, string> = {};
        for (const [k, b] of Object.entries(bits)) {
          if ((mask >> b) & 0x01) elem[k] = (dval >> b) & 0x01 ? 'enable' : 'disable';
        }
        data.screen_display_element_settings = elem;
        offset += 4;
        break;
      }

      case 0xf4:
        data.co2_calibration_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      default:
        offset += 1;
        break;
    }

    return { data, offset };
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    const p = command.params ?? {};

    switch (command.type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'stop_buzzer':
        bytes = [0xff, 0x3d, 0x00];
        break;

      case 'query_status':
        bytes = [0xff, 0x2c, 0x00];
        break;

      case 'set_report_interval': {
        const v = p.interval ?? 300;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_time_sync':
        bytes = [0xff, 0x3b, p.enable ? 2 : 0];
        break;

      case 'set_time_zone': {
        const tz = p.offset ?? 0;
        const v  = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0x17, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_tvoc_unit':
        // 0=iaq, 1=µg/m³
        bytes = [0xff, 0xeb, p.unit === 'µg/m³' ? 1 : 0];
        break;

      case 'set_co2_abc_calibration':
        bytes = [0xff, 0x39, p.enable ? 1 : 0, 0, 0, 0, 0];
        break;

      case 'set_co2_calibration_enable':
        bytes = [0xff, 0xf4, p.enable ? 1 : 0];
        break;

      case 'set_co2_calibration_settings': {
        const modeMap: Record<string, number> = { factory: 0, abc: 1, manual: 2, background: 3, zero: 4 };
        const mode = modeMap[p.mode ?? 'factory'] ?? 0;
        if (mode === 2) {
          const val = p.calibration_value ?? 400;
          bytes = [0xff, 0x1a, mode, val & 0xff, (val >> 8) & 0xff];
        } else {
          bytes = [0xff, 0x1a, mode];
        }
        break;
      }

      case 'set_buzzer':
        bytes = [0xff, 0x3e, p.enable ? 1 : 0];
        break;

      case 'set_led_indicator': {
        const modeMap: Record<string, number> = { off: 0, on: 1, blink: 2 };
        bytes = [0xff, 0x2e, modeMap[p.mode ?? 'off'] ?? 0];
        break;
      }

      case 'set_screen_display':
        bytes = [0xff, 0x2d, p.enable ? 1 : 0];
        break;

      case 'set_screen_display_alarm':
        bytes = [0xff, 0x66, p.enable ? 1 : 0];
        break;

      case 'set_screen_display_pattern': {
        const pat = p.pattern ?? 1;
        if (pat < 1 || pat > 3) throw new Error('screen_display_pattern must be 1, 2, or 3');
        bytes = [0xff, 0x3c, pat];
        break;
      }

      case 'set_screen_display_elements': {
        const bitMap: Record<string, number> = { temperature: 0, humidity: 1, co2: 2, light: 3, tvoc: 4, smile: 5, letter: 6 };
        let mask = 0, dval = 0;
        for (const [k, b] of Object.entries(bitMap)) {
          if (k in (p.elements ?? {})) {
            mask |= 1 << b;
            if (p.elements[k]) dval |= 1 << b;
          }
        }
        bytes = [0xff, 0xf0, mask & 0xff, (mask >> 8) & 0xff, dval & 0xff, (dval >> 8) & 0xff];
        break;
      }

      case 'set_child_lock': {
        const e = p.elements ?? {};
        const bits = (e.off_button ? 1 : 0) | (e.on_button ? 2 : 0) | (e.collection_button ? 4 : 0);
        bytes = [0xff, 0x25, bits];
        break;
      }

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, p.enable ? 1 : 0];
        break;

      case 'set_retransmit_interval': {
        const v = p.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('retransmit_interval must be 1–64800 s');
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_resend_interval': {
        const v = p.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('resend_interval must be 1–64800 s');
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, p.enable ? 1 : 0];
        break;

      case 'fetch_history': {
        const start = p.start_time ?? 0;
        const end   = p.end_time;
        if (end !== undefined) {
          bytes = [0xfd, 0x6c, start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
                               end   & 0xff, (end   >> 8) & 0xff, (end   >> 16) & 0xff, (end   >> 24) & 0xff];
        } else {
          bytes = [0xfd, 0x6b, start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff];
        }
        break;
      }

      case 'stop_transmit':
        bytes = [0xfd, 0x6d, 0xff];
        break;

      case 'clear_history':
        bytes = [0xff, 0x27, 0x01];
        break;

      default:
        throw new Error(`AM307: unsupported command "${command.type}"`);
    }

    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // AM307 is uniquely identified by TVOC channels: 0x08 0x7D or 0x08 0xE6
  // These channels don't appear in AM10x (no TVOC) or AM30xL (different arch).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x08 && (ty === 0x7d || ty === 0xe6)) return true; // TVOC — AM307 unique

      // Skip known fixed-length channels
      if (ch === 0x01 && ty === 0x75) { i += 3; continue; }
      if (ch === 0x03 && ty === 0x67) { i += 4; continue; }
      if (ch === 0x04 && ty === 0x68) { i += 3; continue; }
      if (ch === 0x05 && ty === 0x00) { i += 3; continue; }
      if (ch === 0x06 && ty === 0xcb) { i += 3; continue; }
      if (ch === 0x07 && ty === 0x7d) { i += 4; continue; }
      if (ch === 0x09 && ty === 0x73) { i += 4; continue; }
      if (ch === 0x0e && ty === 0x01) { i += 3; continue; }
      if (ch === 0xff) { i += 3; continue; }

      break;
    }

    return false;
  }
}