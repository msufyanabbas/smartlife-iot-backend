// src/modules/devices/codecs/milesight/am103.codec.ts
/**
 * Milesight AM103 / AM103L Codec
 * Ambience Monitoring Sensor — Temperature + Humidity + CO2
 *
 * AM103  = with display screen
 * AM103L = without display screen (same payload, subset of downlink commands)
 *
 * Telemetry:
 *   - battery / batteryLevel (%)
 *   - temperature (°C, int16/10)
 *   - humidity (%, uint8/2)
 *   - co2 (ppm, uint16)
 *   - history[] — { timestamp, temperature, humidity, co2 }  (9B per record)
 *   - sensor_enable: { temperature, humidity, co2 }
 *
 * Reference payload: "017564 03671801 04686D 077DC501"
 *   → { battery: 100, temperature: 28.0, humidity: 54.5, co2: 453 }
 *
 * Based on official Milesight decoder/encoder v1.0.0
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

export class MilesightAM103Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-am103';
  readonly manufacturer: string    = 'Milesight';
  // AM103L has identical payload — same codec, just listed as a supported model
  readonly supportedModels: string[] = ['AM103', 'AM103L'];
  readonly protocol: 'lorawan'    = 'lorawan';
  readonly modelFamily: string    = 'AM103';
  readonly category: string       = 'Ambience Monitoring';
  readonly imageUrl: string       = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/am-series/am103/am103.png';

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
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // TEMPERATURE (0x03 0x67) — int16 LE / 10
      else if (ch === 0x03 && ty === 0x67) {
        const raw    = (bytes[i + 1] << 8) | bytes[i];
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }

      // HUMIDITY (0x04 0x68) — uint8 / 2
      else if (ch === 0x04 && ty === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }

      // CO2 (0x07 0x7D) — uint16 LE, ppm
      else if (ch === 0x07 && ty === 0x7d) {
        decoded.co2 = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        i += 2;
      }

      // HISTORY DATA (0x20 0xCE) — 9 bytes: ts(4) + temp(2) + hum(1) + co2(2)
      else if (ch === 0x20 && ty === 0xce) {
        const ts      = ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0;
        const rawTemp = (bytes[i + 5] << 8) | bytes[i + 4];
        const co2Val  = ((bytes[i + 8] << 8) | bytes[i + 7]) & 0xffff;

        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({
          timestamp:   ts,
          temperature: (rawTemp > 0x7fff ? rawTemp - 0x10000 : rawTemp) / 10,
          humidity:    (bytes[i + 6] & 0xff) / 2,
          co2:         co2Val,
        });
        i += 9;
      }

      // SENSOR ENABLE (0xFF 0x18)
      else if (ch === 0xff && ty === 0x18) {
        const data = bytes[i + 1] & 0xff;
        decoded.sensor_enable = {
          temperature: (data >> 0) & 0x01 ? 'enable' : 'disable',
          humidity:    (data >> 1) & 0x01 ? 'enable' : 'disable',
          co2:         (data >> 4) & 0x01 ? 'enable' : 'disable',
        };
        i += 2;
      }

      // ── Downlink response ───────────────────────────────────────────────
      else if (ch === 0xfe || ch === 0xff) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded;
  }


  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'AM103',
    description:  'Ambience Monitoring Sensor — Temperature, Humidity, and CO₂',
    telemetryKeys: [
      { key: 'battery',     label: 'Battery',     type: 'number' as const, unit: '%'   },
      { key: 'temperature', label: 'Temperature', type: 'number' as const, unit: '°C'  },
      { key: 'humidity',    label: 'Humidity',    type: 'number' as const, unit: '%'   },
      { key: 'co2',         label: 'CO₂',         type: 'number' as const, unit: 'ppm' },
    ],
    commands: [
      { type: 'reboot',        label: 'Reboot Device', params: [] },
      { type: 'clear_history', label: 'Clear History', params: [] },
      { type: 'reset_battery', label: 'Reset Battery', params: [] },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60, max: 86400 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'offset', label: 'UTC Offset (tenths of hours)', type: 'number' as const, required: true, default: 0 }],
      },
      {
        type:   'set_timestamp',
        label:  'Set Timestamp',
        params: [{ key: 'timestamp', label: 'Unix Epoch (seconds)', type: 'number' as const, required: false }],
      },
      {
        type:   'set_time_sync_enable',
        label:  'Set Time Sync',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_screen_display',
        label:  'Set Screen Display',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_led_indicator_mode',
        label:  'Set LED Indicator Mode',
        params: [{ key: 'mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Off', value: 'off' }, { label: 'Blink', value: 'blink' }] }],
      },
      {
        type:   'set_temperature_alarm',
        label:  'Set Temperature Alarm',
        params: [
          { key: 'condition',     label: 'Condition',           type: 'select' as const,  required: true,  options: [{ label: 'Disable', value: 'disable' }, { label: 'Below', value: 'below' }, { label: 'Above', value: 'above' }, { label: 'Between', value: 'between' }, { label: 'Outside', value: 'outside' }] },
          { key: 'threshold_min', label: 'Min Threshold (°C)',  type: 'number' as const,  required: false, default: 0  },
          { key: 'threshold_max', label: 'Max Threshold (°C)',  type: 'number' as const,  required: false, default: 40 },
        ],
      },
      {
        type:   'set_co2_alarm',
        label:  'Set CO₂ Alarm',
        params: [
          { key: 'enable',      label: 'Enable',               type: 'boolean' as const, required: true  },
          { key: 'threshold_1', label: 'Threshold 1 (ppm)',    type: 'number'  as const, required: true, default: 1000, min: 400, max: 5000 },
          { key: 'threshold_2', label: 'Threshold 2 (ppm)',    type: 'number'  as const, required: true, default: 2000, min: 400, max: 5000 },
        ],
      },
      {
        type:   'set_co2_calibration',
        label:  'Set CO₂ Calibration',
        params: [
          { key: 'mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'Factory', value: 'factory' }, { label: 'ABC', value: 'abc' }, { label: 'Manual', value: 'manual' }, { label: 'Background', value: 'background' }, { label: 'Zero', value: 'zero' }] },
          { key: 'calibration_value', label: 'Calibration Value (ppm)', type: 'number' as const, required: false },
        ],
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
      { type: 'gauge' as const, label: 'CO₂',         keys: ['co2'],         unit: 'ppm' },
    ],
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

      case 0x06: {
        const cond    = bytes[offset] & 0x07;
        const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };
        const rawMin  = (bytes[offset + 2] << 8) | bytes[offset + 1];
        const rawMax  = (bytes[offset + 4] << 8) | bytes[offset + 3];
        data.temperature_alarm_config = {
          condition:     condMap[cond] ?? 'unknown',
          threshold_min: (rawMin > 0x7fff ? rawMin - 0x10000 : rawMin) / 10,
          threshold_max: (rawMax > 0x7fff ? rawMax - 0x10000 : rawMax) / 10,
        };
        offset += 9;
        break;
      }

      case 0x10:
        data.reboot = 'yes';
        offset += 1;
        break;

      case 0x11:
        data.timestamp = ((bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 1] << 8) | bytes[offset]) >>> 0;
        offset += 4;
        break;

      case 0x17: {
        const raw = (bytes[offset + 1] << 8) | bytes[offset];
        const tz  = raw > 0x7fff ? raw - 0x10000 : raw;
        data.time_zone = TIMEZONE_MAP[String(tz)] ?? `UTC offset ${tz}`;
        offset += 2;
        break;
      }

      case 0x1a: {
        const modeVal = bytes[offset] & 0xff;
        const modeMap: Record<number, string> = { 0: 'factory', 1: 'abc', 2: 'manual', 3: 'background', 4: 'zero' };
        data.co2_calibration_settings = { mode: modeMap[modeVal] ?? 'unknown' };
        if (modeVal === 2) {
          const raw = (bytes[offset + 2] << 8) | bytes[offset + 1];
          data.co2_calibration_settings.calibration_value = raw > 0x7fff ? raw - 0x10000 : raw;
          offset += 3;
        } else {
          offset += 1;
        }
        break;
      }

      case 0x27:
        data.clear_history = 'yes';
        offset += 1;
        break;

      case 0x2d:
        data.screen_display_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x2f:
        data.led_indicator_mode = bytes[offset] === 2 ? 'blink' : 'off';
        offset += 1;
        break;

      case 0x39:
        data.co2_abc_calibration_settings = {
          enable:             bytes[offset]     === 1 ? 'enable' : 'disable',
          period:             ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff,
          calibration_value:  ((bytes[offset + 4] << 8) | bytes[offset + 3]) & 0xffff,
        };
        offset += 5;
        break;

      case 0x3a: {
        const num = bytes[offset] & 0xff;
        offset += 1;
        data.report_schedule_config = [];
        for (let j = 0; j < num; j++) {
          data.report_schedule_config.push({
            start_time:              (bytes[offset]     & 0xff) / 10,
            end_time:                (bytes[offset + 1] & 0xff) / 10,
            report_interval:         ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff,
            co2_collection_interval:  bytes[offset + 4] & 0xff,
            collection_interval:      bytes[offset + 5] & 0xff,
          });
          offset += 6;
        }
        break;
      }

      case 0x3b:
        data.time_sync_enable = bytes[offset] === 2 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x54:
        data.co2_alarm_config = {
          enable:      bytes[offset]     === 1 ? 'enable' : 'disable',
          threshold_1: ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff,
          threshold_2: ((bytes[offset + 4] << 8) | bytes[offset + 3]) & 0xffff,
        };
        offset += 5;
        break;

      case 0x56:
        data.screen_intelligent_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x57:
        data.clear_report_schedule = 'yes';
        offset += 1;
        break;

      case 0x59:
        data.reset_battery = 'yes';
        offset += 1;
        break;

      case 0x5a:
        data.screen_refresh_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
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

      case 0x75: {
        const wb   = bytes[offset + 6] & 0xff;
        const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        const weekdays: Record<string, string> = {};
        days.forEach((d, idx) => { weekdays[d] = (wb >> (idx + 1)) & 0x01 ? 'enable' : 'disable'; });
        data.hibernate_config = {
          enable:             bytes[offset]     === 1 ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset + 1] === 1 ? 'enable' : 'disable',
          start_time:         ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff,
          end_time:           ((bytes[offset + 5] << 8) | bytes[offset + 4]) & 0xffff,
          weekdays,
        };
        offset += 7;
        break;
      }

      case 0x85:
        data.screen_display_time_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x86:
        data.screen_last_refresh_interval = bytes[offset] & 0xff;
        offset += 1;
        break;

      case 0x87:
        data.altitude_calibration_settings = {
          enable:            bytes[offset]     === 1 ? 'enable' : 'disable',
          calibration_value: ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff,
        };
        offset += 3;
        break;

      case 0xf0: {
        const mask = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        const dval = ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff;
        const elem: Record<string, string> = {};
        const bits: Record<string, number> = { temperature: 0, humidity: 1, co2: 2, smile: 3 };
        for (const [k, b] of Object.entries(bits)) {
          if ((mask >> b) & 0x01) elem[k] = (dval >> b) & 0x01 ? 'enable' : 'disable';
        }
        data.screen_display_element_settings = elem;
        offset += 4;
        break;
      }

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

      case 'set_report_interval': {
        const v = p.interval ?? 300;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_time_zone': {
        const tz = p.offset ?? 0;
        const v  = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0x17, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_timestamp': {
        const ts = p.timestamp ?? Math.floor(Date.now() / 1000);
        bytes = [0xff, 0x11, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff];
        break;
      }

      case 'set_time_sync_enable':
        bytes = [0xff, 0x3b, p.enable ? 2 : 0];
        break;

      case 'set_screen_display':
        bytes = [0xff, 0x2d, p.enable ? 1 : 0];
        break;

      case 'set_screen_display_time':
        bytes = [0xff, 0x85, p.enable ? 1 : 0];
        break;

      case 'set_screen_intelligent':
        bytes = [0xff, 0x56, p.enable ? 1 : 0];
        break;

      case 'set_screen_last_refresh': {
        const v = p.minutes ?? 5;
        if (v < 2 || v > 1080) throw new Error('screen_last_refresh_interval must be 2–1080 min');
        bytes = [0xff, 0x86, v & 0xff];
        break;
      }

      case 'set_screen_refresh': {
        const v = p.seconds ?? 10;
        if (v < 1 || v > 65535) throw new Error('screen_refresh_interval must be 1–65535 s');
        bytes = [0xff, 0x5a, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_screen_display_elements': {
        // p.elements: { temperature?, humidity?, co2?, smile? } each true/false
        const bits: Record<string, number> = { temperature: 0, humidity: 1, co2: 2, smile: 3 };
        let mask = 0, data = 0;
        for (const [k, b] of Object.entries(bits)) {
          if (k in (p.elements ?? {})) {
            mask |= 1 << b;
            if (p.elements[k]) data |= 1 << b;
          }
        }
        bytes = [0xff, 0xf0, mask & 0xff, (mask >> 8) & 0xff, data & 0xff, (data >> 8) & 0xff];
        break;
      }

      case 'set_led_indicator_mode':
        bytes = [0xff, 0x2f, p.mode === 'blink' ? 2 : 0];
        break;

      case 'set_temperature_alarm': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond   = condMap[p.condition ?? 'disable'] ?? 0;
        const dat    = cond | (1 << 3);
        const minR   = Math.round((p.threshold_min ?? 0)  * 10);
        const maxR   = Math.round((p.threshold_max ?? 40) * 10);
        const minLE  = minR < 0 ? minR + 0x10000 : minR;
        const maxLE  = maxR < 0 ? maxR + 0x10000 : maxR;
        bytes = [0xff, 0x06, dat, minLE & 0xff, (minLE >> 8) & 0xff, maxLE & 0xff, (maxLE >> 8) & 0xff, 0, 0, 0, 0];
        break;
      }

      case 'set_co2_calibration': {
        const modeMap: Record<string, number> = { factory: 0, abc: 1, manual: 2, background: 3, zero: 4 };
        const mode = modeMap[p.mode ?? 'factory'] ?? 0;
        if (mode === 2) {
          const v = p.calibration_value ?? 0;
          const vLE = v < 0 ? v + 0x10000 : v;
          bytes = [0xff, 0x1a, mode, vLE & 0xff, (vLE >> 8) & 0xff];
        } else {
          bytes = [0xff, 0x1a, mode];
        }
        break;
      }

      case 'set_co2_alarm': {
        const t1 = p.threshold_1 ?? 1000;
        const t2 = p.threshold_2 ?? 2000;
        if (t1 < 400 || t1 > 5000) throw new Error('co2 threshold_1 must be 400–5000 ppm');
        if (t2 < 400 || t2 > 5000) throw new Error('co2 threshold_2 must be 400–5000 ppm');
        if (t1 > t2)                throw new Error('co2 threshold_1 must be ≤ threshold_2');
        bytes = [0xff, 0x54, p.enable ? 1 : 0, t1 & 0xff, (t1 >> 8) & 0xff, t2 & 0xff, (t2 >> 8) & 0xff];
        break;
      }

      case 'set_co2_abc': {
        const period = p.period ?? 168;
        const calVal = p.calibration_value ?? 400;
        if (period < 1 || period > 65535) throw new Error('co2_abc period must be 1–65535 h');
        if (calVal < 1 || calVal > 65535)  throw new Error('co2_abc calibration_value must be 1–65535 ppm');
        bytes = [0xff, 0x39, p.enable ? 1 : 0, period & 0xff, (period >> 8) & 0xff, calVal & 0xff, (calVal >> 8) & 0xff];
        break;
      }

      case 'set_altitude': {
        const alt = p.calibration_value ?? 0;
        if (alt < 0 || alt > 5000) throw new Error('altitude must be 0–5000 m');
        bytes = [0xff, 0x87, p.enable ? 1 : 0, alt & 0xff, (alt >> 8) & 0xff];
        break;
      }

      case 'set_hibernate': {
        const enable = p.enable  ? 1 : 0;
        const loraEn = p.lora_uplink_enable ? 1 : 0;
        const start  = p.start_time ?? 0;
        const end    = p.end_time   ?? 0;
        const dayMap = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        let dayByte  = 0;
        dayMap.forEach((d, idx) => { if ((p.weekdays ?? {})[d]) dayByte |= 1 << (idx + 1); });
        bytes = [0xff, 0x75, enable, loraEn, start & 0xff, (start >> 8) & 0xff, end & 0xff, (end >> 8) & 0xff, dayByte];
        break;
      }

      case 'reset_battery':
        bytes = [0xff, 0x59, 0xff];
        break;

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
        throw new Error(`AM103: unsupported command "${command.type}"`);
    }

    return { fPort: 85, data: this.bytesToHex(bytes), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // AM103 is uniquely identified by the CO2 channel (0x07 0x7D).
  // Walk bytes looking for it.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x07 && ty === 0x7d) return true; // CO2 — unique to AM103

      // Skip known channels to keep walking
      if (ch === 0x01 && ty === 0x75) { i += 3; continue; }
      if (ch === 0x03 && ty === 0x67) { i += 4; continue; }
      if (ch === 0x04 && ty === 0x68) { i += 3; continue; }
      if (ch === 0xff && ty === 0x01) { i += 3; continue; }
      if (ch === 0xff && (ty === 0x09 || ty === 0x0a)) { i += 4; continue; }
      if (ch === 0xff && ty === 0xff) { i += 4; continue; }
      if (ch === 0xff && ty === 0x16) { i += 10; continue; }
      if (ch === 0xff && ty === 0x0f) { i += 3; continue; }
      if (ch === 0xff && (ty === 0xfe || ty === 0x0b)) { i += 3; continue; }

      break;
    }

    return false;
  }
}