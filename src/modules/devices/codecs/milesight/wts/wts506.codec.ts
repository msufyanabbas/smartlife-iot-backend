// src/modules/devices/codecs/milesight/wts506.codec.ts
// Milesight WTS506 — Weather Station
// Channels: Temperature, Humidity, Wind Direction, Wind Speed, Pressure, Rainfall
// Also covers WTS305 and WTS505 (same payload format)

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightWTS506Codec extends BaseDeviceCodec {
  readonly codecId       = 'milesight-wts506';
  readonly manufacturer  = 'Milesight';
  readonly model         = 'WTS506';
  readonly description   = 'Weather Station — Temperature, Humidity, Wind, Pressure, Rainfall';
  readonly supportedModels = ['WTS506', 'WTS505', 'WTS305'];
  readonly protocol      = 'lorawan' as const;

  // ── Timezone map ─────────────────────────────────────────────────────────

  private readonly TZ_MAP: Record<number, string> = {
    '-120': 'UTC-12', '-110': 'UTC-11', '-100': 'UTC-10', '-95': 'UTC-9:30',
    '-90': 'UTC-9',   '-80': 'UTC-8',   '-70': 'UTC-7',   '-60': 'UTC-6',
    '-50': 'UTC-5',   '-40': 'UTC-4',   '-35': 'UTC-3:30','-30': 'UTC-3',
    '-20': 'UTC-2',   '-10': 'UTC-1',     0: 'UTC',         10: 'UTC+1',
     20: 'UTC+2',      30: 'UTC+3',       35: 'UTC+3:30',   40: 'UTC+4',
     45: 'UTC+4:30',   50: 'UTC+5',       55: 'UTC+5:30',   57: 'UTC+5:45',
     60: 'UTC+6',      65: 'UTC+6:30',    70: 'UTC+7',      80: 'UTC+8',
     90: 'UTC+9',      95: 'UTC+9:30',   100: 'UTC+10',    105: 'UTC+10:30',
    110: 'UTC+11',    120: 'UTC+12',     127: 'UTC+12:45', 130: 'UTC+13',
    140: 'UTC+14',
  } as any;

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    for (let i = 0; i < bytes.length; ) {
      const channelId   = bytes[i++];
      const channelType = bytes[i++];

      // ── Attribute channels ───────────────────────────────────────────────

      // IPSO version
      if (channelId === 0xff && channelType === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      // Hardware version
      else if (channelId === 0xff && channelType === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      // Firmware version
      else if (channelId === 0xff && channelType === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      // TSL version
      else if (channelId === 0xff && channelType === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      // Serial number
      else if (channelId === 0xff && channelType === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join('');
        i += 8;
      }
      // LoRaWAN class
      else if (channelId === 0xff && channelType === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i++]] ?? 'unknown';
      }
      // Reset event
      else if (channelId === 0xff && channelType === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }
      // Device status
      else if (channelId === 0xff && channelType === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Telemetry channels ───────────────────────────────────────────────

      // Battery
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.batteryLevel = bytes[i++];
      }
      // Temperature
      else if (channelId === 0x03 && channelType === 0x67) {
        decoded.temperature = this.readInt16LE(bytes, i) / 10;
        i += 2;
      }
      // Humidity
      else if (channelId === 0x04 && channelType === 0x68) {
        decoded.humidity = bytes[i++] / 2;
      }
      // Wind direction (°)
      else if (channelId === 0x05 && channelType === 0x84) {
        decoded.wind_direction = this.readInt16LE(bytes, i) / 10;
        i += 2;
      }
      // Barometric pressure (hPa)
      else if (channelId === 0x06 && channelType === 0x73) {
        decoded.pressure = this.readUInt16LE(bytes, i) / 10;
        i += 2;
      }
      // Wind speed (m/s)
      else if (channelId === 0x07 && channelType === 0x92) {
        decoded.wind_speed = this.readUInt16LE(bytes, i) / 10;
        i += 2;
      }
      // Rainfall v1 — uint16 total + uint8 counter
      else if (channelId === 0x08 && channelType === 0x77) {
        decoded.rainfall_total   = this.readUInt16LE(bytes, i) / 100;
        decoded.rainfall_counter = bytes[i + 2];
        i += 3;
      }
      // Rainfall v2/v3 — uint32 total + uint8 counter
      else if (channelId === 0x08 && channelType === 0xec) {
        decoded.rainfall_total   = this.readUInt32LE(bytes, i) / 100;
        decoded.rainfall_counter = bytes[i + 4];
        i += 5;
      }

      // ── Alarm channels ───────────────────────────────────────────────────

      // Temperature alarm
      else if (channelId === 0x83 && channelType === 0x67) {
        decoded.temperature       = this.readInt16LE(bytes, i) / 10;
        decoded.temperature_alarm = bytes[i + 2] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 3;
      }
      // Barometric pressure alarm
      else if (channelId === 0x86 && channelType === 0x73) {
        decoded.pressure       = this.readUInt16LE(bytes, i) / 10;
        decoded.pressure_alarm = bytes[i + 2] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 3;
      }
      // Wind speed alarm
      else if (channelId === 0x87 && channelType === 0x92) {
        decoded.wind_speed       = this.readUInt16LE(bytes, i) / 10;
        decoded.wind_speed_alarm = bytes[i + 2] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 3;
      }
      // Rainfall alarm (v2 with uint32)
      else if (channelId === 0x88 && channelType === 0xec) {
        decoded.rainfall_total   = this.readUInt32LE(bytes, i) / 100;
        decoded.rainfall_counter = bytes[i + 4];
        decoded.rainfall_alarm   = bytes[i + 5] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 6;
      }

      // ── Historical data ───────────────────────────────────────────────────

      // Historical data v1 — uint16 rainfall (15 bytes total)
      else if (channelId === 0x20 && channelType === 0xce) {
        if (!decoded.history) decoded.history = [];
        decoded.history.push({
          timestamp:      this.readUInt32LE(bytes, i),
          temperature:    this.readInt16LE(bytes, i + 4) / 10,
          humidity:       bytes[i + 6] / 2,
          pressure:       this.readUInt16LE(bytes, i + 7) / 10,
          wind_direction: this.readInt16LE(bytes, i + 9) / 10,
          wind_speed:     this.readUInt16LE(bytes, i + 11) / 10,
          rainfall_total: this.readUInt16LE(bytes, i + 13) / 100,
        });
        i += 15;
      }
      // Historical data v2 — uint32 rainfall (17 bytes total)
      else if (channelId === 0x21 && channelType === 0xce) {
        if (!decoded.history) decoded.history = [];
        decoded.history.push({
          timestamp:      this.readUInt32LE(bytes, i),
          temperature:    this.readInt16LE(bytes, i + 4) / 10,
          humidity:       bytes[i + 6] / 2,
          pressure:       this.readUInt16LE(bytes, i + 7) / 10,
          wind_direction: this.readInt16LE(bytes, i + 9) / 10,
          wind_speed:     this.readUInt16LE(bytes, i + 11) / 10,
          rainfall_total: this.readUInt32LE(bytes, i + 13) / 100,
        });
        i += 17;
      }

      // ── Downlink responses ────────────────────────────────────────────────

      else if (channelId === 0xfe || channelId === 0xff) {
        const result = this.handleDownlinkResponse(channelType, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else {
        break;
      }
    }

    return decoded;
  }

  // ── Encode downlink ───────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_timestamp': {
        // params: { timestamp: number } — Unix seconds
        const ts = params.timestamp ?? Math.floor(Date.now() / 1000);
        bytes = [
          0xff, 0x11,
          ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff,
        ];
        break;
      }

      case 'set_time_zone': {
        // params: { time_zone: string } — e.g. 'UTC+3' for Saudi Arabia → value 30
        const tzName  = params.time_zone ?? 'UTC+3';
        const tzValue = this.getTzValue(tzName);
        const signed  = tzValue < 0 ? tzValue + 0x10000 : tzValue;
        bytes = [0xff, 0x17, signed & 0xff, (signed >> 8) & 0xff];
        break;
      }

      case 'set_report_interval': {
        // params: { interval: number } — seconds, range 60–64800
        const interval = Math.min(64800, Math.max(60, params.interval ?? 600));
        bytes = [0xff, 0x03, interval & 0xff, (interval >> 8) & 0xff];
        break;
      }

      case 'set_power_on_run_mode': {
        // params: { mode: 'off'|'on'|'keep' }
        const modeMap: Record<string, number> = { off: 0, on: 1, keep: 2 };
        const mode = modeMap[params.mode ?? 'keep'] ?? 2;
        bytes = [0xff, 0x67, mode];
        break;
      }

      case 'clear_history':
        bytes = [0xff, 0x27, 0x01];
        break;

      default:
        throw new Error(`WTS506: unsupported command: ${type}`);
    }

    return {
      data:  Buffer.from(bytes).toString('base64'),
      fPort: 85,
    };
  }

  // ── Downlink response handler ─────────────────────────────────────────────

  private handleDownlinkResponse(
    channelType: number,
    bytes: number[],
    offset: number,
  ): { data: DecodedTelemetry; offset: number } {
    const data: DecodedTelemetry = {};

    switch (channelType) {
      case 0x03:
        data.report_interval = this.readUInt16LE(bytes, offset);
        offset += 2;
        break;
      case 0x10:
        data.reboot = 'yes';
        offset += 1;
        break;
      case 0x11:
        data.timestamp = this.readUInt32LE(bytes, offset);
        offset += 4;
        break;
      case 0x17:
        data.time_zone = this.TZ_MAP[this.readInt16LE(bytes, offset)] ?? 'unknown';
        offset += 2;
        break;
      case 0x27:
        data.clear_history = 'yes';
        offset += 1;
        break;
      case 0x67: {
        const modeMap: Record<number, string> = { 0: 'off', 1: 'on', 2: 'keep' };
        data.power_on_run_mode = modeMap[bytes[offset++]] ?? 'unknown';
        break;
      }
      default:
        throw new Error(`WTS506: unknown downlink response: 0x${channelType.toString(16)}`);
    }

    return { data, offset };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private readUInt16LE(bytes: number[], offset: number): number {
    return ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
  }

  private readInt16LE(bytes: number[], offset: number): number {
    const v = this.readUInt16LE(bytes, offset);
    return v > 0x7fff ? v - 0x10000 : v;
  }

  private readUInt32LE(bytes: number[], offset: number): number {
    return (
      ((bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) |
       (bytes[offset + 1] << 8)  |  bytes[offset]) >>> 0
    );
  }

  private getTzValue(tzName: string): number {
    for (const [key, val] of Object.entries(this.TZ_MAP)) {
      if (val === tzName) return parseInt(key);
    }
    return 30; // default UTC+3 (Saudi Arabia)
  }
}