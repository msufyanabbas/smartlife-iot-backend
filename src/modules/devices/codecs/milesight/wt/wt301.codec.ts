// src/modules/devices/codecs/milesight/wt301.codec.ts
// Milesight WT301 / WT302 — Smart Fan Coil Thermostat
//
// Wire protocol: PROPRIETARY FRAMED (not classic channel_id+type, not flat command IDs)
//
// Frame structure:
//   [0x55] [cmd:1B] [length:2B BE] [data_id:1B] [data:N bytes] [checksum:1B]
//
// cmd: 0x01 = control/response, 0x02 = query request
// Checksum: sum of all preceding bytes & 0xFF
//
// Also covers WT302 (same decoder, same protocol).

import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightWT301Codec extends BaseDeviceCodec {
  readonly codecId: string        = 'milesight-wt301';
  readonly manufacturer: string    = 'Milesight';
  readonly model           = 'WT301';
  readonly description     = 'Smart Fan Coil Thermostat — Framed Protocol (0x55 header)';
  readonly supportedModels: string[] = ['WT301', 'WT302'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode uplink ─────────────────────────────────────────────────────────
  // The device sends one frame per uplink. Frame:
  //   byte[0]   = 0x55  (header)
  //   byte[1]   = command (0x01=control, 0x02=request)
  //   byte[2:3] = data_length uint16 BE
  //   byte[4]   = data_id
  //   byte[5..] = data payload (data_length - 1 bytes, since data_id is counted)
  //   byte[last]= checksum

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    if (bytes.length < 6) return decoded;

    // Parse frame header
    decoded.head    = bytes[0];
    decoded.command = bytes[1] === 0x01 ? 'control' : bytes[1] === 0x02 ? 'request' : 'unknown';

    const dataLength = (bytes[2] << 8) | bytes[3]; // uint16 BE
    const dataId     = bytes[4];

    // data payload starts at byte[5], length = dataLength - 1 (dataId is 1 of the dataLength bytes)
    // So actual value bytes start at bytes[5] and run for dataLength-1 bytes

    switch (dataId) {
      case 0x01:
        decoded.thermostat_status = bytes[5] === 1 ? 'on' : 'off';
        break;
      case 0x02:
        decoded.btn_lock_enable = bytes[5] === 1 ? 'enable' : 'disable';
        break;
      case 0x03:
        decoded.mode = this.decodeMode(bytes[5]);
        break;
      case 0x04:
        decoded.fan_speed = this.decodeFanSpeed(bytes[5]);
        break;
      case 0x05:
        // temperature: raw byte / 2
        decoded.temperature = bytes[5] / 2;
        break;
      case 0x06:
        decoded.target_temperature = bytes[5] / 2;
        break;
      case 0x07:
        decoded.card_mode = bytes[5] === 1 ? 'insert' : 'remove';
        break;
      case 0x08:
        decoded.control_mode = bytes[5] === 1 ? 'manual' : 'auto';
        break;
      case 0x09:
        decoded.server_temperature = bytes[5] / 2;
        break;

      case 0x0f:
        // All-in-one response — 9 data bytes starting at byte[5]
        decoded.thermostat_status  = bytes[5]  === 1 ? 'on'     : 'off';
        decoded.btn_lock_enable    = bytes[6]  === 1 ? 'enable' : 'disable';
        decoded.mode               = this.decodeMode(bytes[7]);
        decoded.fan_speed          = this.decodeFanSpeed(bytes[8]);
        decoded.temperature        = bytes[9]  / 2;
        decoded.target_temperature = bytes[10] / 2;
        decoded.card_mode          = bytes[11] === 1 ? 'insert' : 'remove';
        decoded.control_mode       = bytes[12] === 1 ? 'manual' : 'auto';
        decoded.server_temperature = bytes[13] / 2;
        break;

      default:
        decoded.raw_data_id = `0x${dataId.toString(16).padStart(2, '0')}`;
        break;
    }

    // Store raw frame metadata
    decoded.data_length = dataLength;
    decoded.crc         = bytes[5 + dataLength - 1] ?? bytes[bytes.length - 1];

    return decoded;
  }

  // ── Encode downlink ───────────────────────────────────────────────────────
  // All set commands: [0x55, 0x01, 0x00, 0x02, data_id, value, checksum]
  // All query commands: [0x55, 0x02, 0x00, 0x01, data_id, checksum]

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      // ── Set commands ────────────────────────────────────────────────────

      case 'set_thermostat_status': {
        const val = params.status === 'on' || params.status === 1 ? 1 : 0;
        bytes = this.buildSetFrame(0x01, val);
        break;
      }
      case 'set_btn_lock': {
        const val = params.enable === 'enable' || params.enable === 1 ? 1 : 0;
        bytes = this.buildSetFrame(0x02, val);
        break;
      }
      case 'set_mode': {
        const modeMap: Record<string, number> = { cool: 0, heat: 1, fan: 2 };
        const val = typeof params.mode === 'string' ? (modeMap[params.mode] ?? 0) : (params.mode ?? 0);
        bytes = this.buildSetFrame(0x03, val);
        break;
      }
      case 'set_fan_speed': {
        const speedMap: Record<string, number> = { auto: 0, high: 1, medium: 2, low: 3 };
        const val = typeof params.speed === 'string' ? (speedMap[params.speed] ?? 0) : (params.speed ?? 0);
        bytes = this.buildSetFrame(0x04, val);
        break;
      }
      case 'set_target_temperature': {
        // temperature encoded as value * 2 (supports 0.5°C steps)
        const val = Math.round((params.temperature ?? 20) * 2) & 0xff;
        bytes = this.buildSetFrame(0x05, val);
        break;
      }
      case 'set_control_mode': {
        const val = params.mode === 'manual' || params.mode === 1 ? 1 : 0;
        bytes = this.buildSetFrame(0x06, val);
        break;
      }
      case 'set_server_temperature': {
        // server temperature also * 2
        const val = Math.round((params.temperature ?? 20) * 2) & 0xff;
        bytes = this.buildSetFrame(0x07, val);
        break;
      }

      case 'set_all': {
        // All-in-one set: [0x55, 0x01, 0x00, 0x08, 0x0f, status, lock, mode, fan, target*2, ctrl_mode, server*2, crc]
        const status   = params.thermostat_status === 'on'  || params.thermostat_status === 1 ? 1 : 0;
        const lock     = params.btn_lock_enable   === 'enable' || params.btn_lock_enable === 1 ? 1 : 0;
        const modeMap: Record<string, number> = { cool: 0, heat: 1, fan: 2 };
        const ctrlMap: Record<string, number> = { auto: 0, manual: 1 };
        const speedMap: Record<string, number> = { auto: 0, high: 1, medium: 2, low: 3 };
        const mode     = typeof params.mode         === 'string' ? (modeMap[params.mode]         ?? 0) : (params.mode         ?? 0);
        const fan      = typeof params.fan_speed    === 'string' ? (speedMap[params.fan_speed]   ?? 0) : (params.fan_speed    ?? 0);
        const ctrl     = typeof params.control_mode === 'string' ? (ctrlMap[params.control_mode] ?? 0) : (params.control_mode ?? 0);
        const tgt      = Math.round((params.target_temperature ?? 20) * 2) & 0xff;
        const srvt     = Math.round((params.server_temperature ?? 20) * 2) & 0xff;

        const body    = [0x55, 0x01, 0x00, 0x08, 0x0f, status, lock, mode, fan, tgt, ctrl, srvt];
        const crc     = body.reduce((a, b) => a + b, 0) & 0xff;
        bytes         = [...body, crc];
        break;
      }

      // ── Query commands ──────────────────────────────────────────────────

      case 'query_thermostat_status':    bytes = this.buildQueryFrame(0x01); break;
      case 'query_btn_lock':             bytes = this.buildQueryFrame(0x02); break;
      case 'query_mode':                 bytes = this.buildQueryFrame(0x03); break;
      case 'query_fan_speed':            bytes = this.buildQueryFrame(0x04); break;
      case 'query_temperature':          bytes = this.buildQueryFrame(0x05); break;
      case 'query_target_temperature':   bytes = this.buildQueryFrame(0x06); break;
      case 'query_card_mode':            bytes = this.buildQueryFrame(0x07); break;
      case 'query_control_mode':         bytes = this.buildQueryFrame(0x08); break;
      case 'query_server_temperature':   bytes = this.buildQueryFrame(0x09); break;
      case 'query_all':                  bytes = this.buildQueryFrame(0x0f); break;

      default:
        throw new Error(`WT301: unsupported command: ${type}`);
    }

    return { data: Buffer.from(bytes).toString('base64'), fPort: 85 };
  }

  // ── Frame builders ────────────────────────────────────────────────────────

  // Set frame: [0x55, 0x01, 0x00, 0x02, data_id, value, checksum]
  private buildSetFrame(dataId: number, value: number): number[] {
    const body = [0x55, 0x01, 0x00, 0x02, dataId, value];
    const crc  = body.reduce((a, b) => a + b, 0) & 0xff;
    return [...body, crc];
  }

  // Query frame: [0x55, 0x02, 0x00, 0x01, data_id, checksum]
  private buildQueryFrame(dataId: number): number[] {
    const body = [0x55, 0x02, 0x00, 0x01, dataId];
    const crc  = body.reduce((a, b) => a + b, 0) & 0xff;
    return [...body, crc];
  }

  // ── Decode helpers ────────────────────────────────────────────────────────

  private decodeMode(val: number): string {
    return ({ 0: 'cool', 1: 'heat', 2: 'fan' } as Record<number, string>)[val] ?? 'unknown';
  }

  private decodeFanSpeed(val: number): string {
    return ({ 0: 'auto', 1: 'high', 2: 'medium', 3: 'low' } as Record<number, string>)[val] ?? 'unknown';
  }
}