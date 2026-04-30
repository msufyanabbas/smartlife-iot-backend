// src/modules/devices/codecs/milesight/gs301.codec.ts
// Milesight GS301 — Bathroom Odor Detector (NH3 + H2S + Temp + Humidity)

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightGS301Codec extends BaseDeviceCodec {
  readonly codecId       = 'milesight-gs301';
  readonly manufacturer  = 'Milesight';
  readonly model         = 'GS301';
  readonly description   = 'Bathroom Odor Detector — NH3, H2S, Temperature, Humidity';
  readonly supportedModels = ['GS301'];
  readonly protocol      = 'lorawan' as const;
  readonly category      = 'Gas Sensor';
  readonly modelFamily   = 'GS301';
  readonly imageUrl      = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/gs-series/gs301/gs301.png';

  // ── Decode uplink ────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    for (let i = 0; i < bytes.length; ) {
      const channelId   = bytes[i++];
      const channelType = bytes[i++];

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
      // Device status
      else if (channelId === 0xff && channelType === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }
      // LoRaWAN class
      else if (channelId === 0xff && channelType === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i++]] ?? 'unknown';
      }
      // Serial number
      else if (channelId === 0xff && channelType === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join('');
        i += 8;
      }
      // TSL version
      else if (channelId === 0xff && channelType === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      // Reset event
      else if (channelId === 0xff && channelType === 0xfe) {
        decoded.reset_event = bytes[i++] === 1 ? 'reset' : 'normal';
      }
      // Sensor ID (v1.2+)
      else if (channelId === 0xff && channelType === 0x7c) {
        let str = '';
        for (let j = 0; j < 43; j++) {
          if (bytes[i + j] === 0) break;
          str += String.fromCharCode(bytes[i + j]);
        }
        decoded.sensor_id = str;
        i += 43;
      }

      // ── Telemetry channels ─────────────────────────────────────────────

      // Battery
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.batteryLevel = bytes[i++];
      }
      // Temperature
      else if (channelId === 0x02 && channelType === 0x67) {
        decoded.temperature = this.readInt16LE(bytes, i) / 10;
        i += 2;
      }
      // Humidity
      else if (channelId === 0x03 && channelType === 0x68) {
        decoded.humidity = bytes[i++] / 2;
      }
      // NH3 (0.01 ppm resolution)
      else if (channelId === 0x04 && channelType === 0x7d) {
        const raw = this.readUInt16LE(bytes, i);
        i += 2;
        if (raw === 0xfffe) {
          decoded.nh3_sensor_status = 'polarizing';
        } else if (raw === 0xffff) {
          decoded.nh3_sensor_status = 'device error';
        } else {
          decoded.nh3 = raw / 100;
        }
      }
      // H2S (0.01 ppm — older firmware)
      else if (channelId === 0x05 && channelType === 0x7d) {
        const raw = this.readUInt16LE(bytes, i);
        i += 2;
        if (raw === 0xfffe) {
          decoded.h2s_sensor_status = 'polarizing';
        } else if (raw === 0xffff) {
          decoded.h2s_sensor_status = 'device error';
        } else {
          decoded.h2s = raw / 100;
        }
      }
      // H2S (0.001 ppm — v1.2+)
      else if (channelId === 0x06 && channelType === 0x7d) {
        const raw = this.readUInt16LE(bytes, i);
        i += 2;
        if (raw === 0xfffe) {
          decoded.h2s_sensor_status = 'polarizing';
        } else if (raw === 0xffff) {
          decoded.h2s_sensor_status = 'device error';
        } else {
          decoded.h2s = raw / 1000;
        }
      }
      // Sensor calibration result (v1.2+)
      else if (channelId === 0x07 && channelType === 0xea) {
        const sensorId = bytes[i];
        const typeMap: Record<number, string>   = { 0: 'factory', 1: 'manual' };
        const resultMap: Record<number, string> = {
          0: 'success', 1: 'sensor version not match', 2: 'i2c communication error',
        };
        if (sensorId === 0x00) {
          decoded.nh3_calibration_result = {
            type:              typeMap[bytes[i + 1]] ?? 'unknown',
            calibration_value: this.readInt16LE(bytes, i + 2) / 100,
            result:            resultMap[bytes[i + 4]] ?? 'unknown',
          };
        } else if (sensorId === 0x01) {
          decoded.h2s_calibration_result = {
            type:              typeMap[bytes[i + 1]] ?? 'unknown',
            calibration_value: this.readInt16LE(bytes, i + 2) / 1000,
            result:            resultMap[bytes[i + 4]] ?? 'unknown',
          };
        }
        i += 5;
      }

      // ── Downlink response frames ───────────────────────────────────────

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

  // ── Encode downlink ──────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0x01];
        break;

      case 'set_report_interval': {
        const interval = params.interval ?? params.report_interval ?? 600;
        bytes = [0xff, 0x03, interval & 0xff, (interval >> 8) & 0xff];
        break;
      }

      case 'query_life_remain':
        bytes = [0xff, 0x7d, 0xff];
        break;

      case 'set_threshold_report_interval': {
        const interval = params.interval ?? params.threshold_report_interval ?? 120;
        bytes = [0xff, 0x66, interval & 0xff, (interval >> 8) & 0xff];
        break;
      }

      case 'set_led_indicator': {
        const enable = params.enable === true || params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0x2f, enable];
        break;
      }

      case 'set_buzzer': {
        const enable = params.enable === true || params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0x3e, enable];
        break;
      }

      case 'set_nh3_calibration': {
        // params: { mode: 'factory'|'manual', calibration_value: number (ppm) }
        const mode  = params.mode === 'manual' ? 1 : 0;
        const value = Math.round((params.calibration_value ?? 0) * 100);
        bytes = [0xff, 0x8d, 0x00, mode, value & 0xff, (value >> 8) & 0xff];
        break;
      }

      case 'set_h2s_calibration': {
        // params: { mode: 'factory'|'manual', calibration_value: number (ppm) }
        const mode  = params.mode === 'manual' ? 1 : 0;
        const value = Math.round((params.calibration_value ?? 0) * 1000);
        bytes = [0xff, 0x8d, 0x01, mode, value & 0xff, (value >> 8) & 0xff];
        break;
      }

      case 'set_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const srcMap: Record<string, number>  = {
          nh3: 1, h2s: 2, nh3_d2d: 3, h2s_d2d: 4,
          nh3_d2d_release: 5, h2s_d2d_release: 6,
          h2s_v2: 7, h2s_d2d_v2: 8, h2s_release_v2: 9,
        };

        const enableFlag    = params.enable === 'disable' || params.enable === 0 ? 0 : 1;
        const conditionCode = condMap[params.condition ?? 'disable'] ?? 0;
        const sourceCode    = srcMap[params.trigger_source ?? 'nh3'] ?? 1;
        const data          = enableFlag === 0 ? 0 : conditionCode | (sourceCode << 3);

        const tMin = params.threshold_min ?? 0;
        const tMax = params.threshold_max ?? 1000;
        const lock = params.lock_time     ?? 10;
        const cont = params.continue_time ?? 10;

        bytes = [
          0xff, 0x06, data,
          tMin & 0xff, (tMin >> 8) & 0xff,
          tMax & 0xff, (tMax >> 8) & 0xff,
          lock & 0xff, (lock >> 8) & 0xff,
          cont & 0xff, (cont >> 8) & 0xff,
        ];
        break;
      }

      default:
        throw new Error(`GS301: unsupported command: ${type}`);
    }

    return {
      data:  this.bytesToBase64(bytes),
      fPort: 85,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private readUInt16LE(bytes: number[], offset: number): number {
    return ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
  }

  private readInt16LE(bytes: number[], offset: number): number {
    const v = this.readUInt16LE(bytes, offset);
    return v > 0x7fff ? v - 0x10000 : v;
  }

  private bytesToBase64(bytes: number[]): string {
    return Buffer.from(bytes).toString('base64');
  }

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
      case 0x06: {
        const raw = bytes[offset];
        const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };
        const srcMap: Record<number, string>  = {
          1: 'nh3', 2: 'h2s', 3: 'nh3_d2d', 4: 'h2s_d2d',
          5: 'nh3_d2d_release', 6: 'h2s_d2d_release',
          7: 'h2s_v2', 8: 'h2s_d2d_v2', 9: 'h2s_release_v2',
        };
        data.alarm_config = {
          enable:         (raw & 0x07) === 0 ? 'disable' : 'enable',
          condition:      condMap[raw & 0x07] ?? 'unknown',
          trigger_source: srcMap[(raw >> 3) & 0x1f] ?? 'unknown',
          threshold_min:  this.readUInt16LE(bytes, offset + 1),
          threshold_max:  this.readUInt16LE(bytes, offset + 3),
          lock_time:      this.readUInt16LE(bytes, offset + 5),
          continue_time:  this.readUInt16LE(bytes, offset + 7),
        };
        offset += 9;
        break;
      }
      case 0x10:
        data.reboot = 'yes';
        offset += 1;
        break;
      case 0x66:
        data.threshold_report_interval = this.readUInt16LE(bytes, offset);
        offset += 2;
        break;
      case 0x2f:
        data.led_indicator_enable = bytes[offset++] === 1 ? 'enable' : 'disable';
        break;
      case 0x3e:
        data.buzzer_enable = bytes[offset++] === 1 ? 'enable' : 'disable';
        break;
      case 0x7d:
        data.query_life_remain = 'yes';
        offset += 1;
        break;
      case 0x8d: {
        const sensorId = bytes[offset];
        const modeMap: Record<number, string> = { 0: 'factory', 1: 'manual' };
        if (sensorId === 0x00) {
          data.nh3_calibration_settings = {
            mode:              modeMap[bytes[offset + 1]] ?? 'unknown',
            calibration_value: this.readInt16LE(bytes, offset + 2) / 100,
          };
        } else if (sensorId === 0x01) {
          data.h2s_calibration_settings = {
            mode:              modeMap[bytes[offset + 1]] ?? 'unknown',
            calibration_value: this.readInt16LE(bytes, offset + 2) / 1000,
          };
        }
        offset += 6;
        break;
      }
      default:
        throw new Error(`GS301: unknown downlink response: 0x${channelType.toString(16)}`);
    }

    return { data, offset };
  }
}