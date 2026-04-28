// src/modules/devices/codecs/milesight/vs351.codec.ts
// Milesight VS351 — Mini AI Thermopile People Counter
//
// Superset of VS350 with additional channels:
//   0xFF 0xCC — power_status (1B): 0=battery, 1=external, 2=charging
//
// Additional downlink responses vs VS350:
//   0x04 — confirm_mode_enable
//   0x05 — lora_channel_mask_config (id + uint16 mask)
//   0x27 — clear_history
//   0x40 — adr_enable
//   0x41 — lora_port
//   0x75 — hibernate_config (enable + start(2B) + end(2B) + skip 1B)
//   0x77 — installation_height (uint16 LE, mm)
//   0x8F — report_interval (uint16 LE, alternate form)
//   0xEC — detection_direction
//   0xED — reset_cumulative_schedule_config (weekday + hour + minute)
//
// Additional extended downlink (0xF9/0xF8):
//   0x85 — rejoin_config
//   0x86 — data_rate
//   0x87 — tx_power_level
//   0x8B — lorawan_version
//   0x8C — rx2_data_rate
//   0x8D — rx2_frequency
//   0xA2 — installation_scene
//   0xA3 — lora_join_mode
//
// Counter/alarm/history channels are identical to VS350.

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightVS351Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-vs351';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['VS351'];
  readonly protocol        = 'lorawan' as const;

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

      // ── VS351-only: power status (0xFF 0xCC) ──────────────────────────────
      else if (ch === 0xff && ty === 0xcc) {
        const powerMap: Record<number, string> = { 0: 'battery supply', 1: 'external power supply', 2: 'battery charging' };
        decoded.power_status = powerMap[bytes[i]] ?? 'unknown'; i += 1;
      }

      // ── Battery (0x01 0x75) ───────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery;
        i += 1;
      }

      // ── Temperature (0x03 0x67) — int16 LE /10 ───────────────────────────
      else if (ch === 0x03 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        i += 2;
      }

      // ── Total IN/OUT (0x04 0xCC) ──────────────────────────────────────────
      else if (ch === 0x04 && ty === 0xcc) {
        decoded.total_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // ── Period IN/OUT (0x05 0xCC) ─────────────────────────────────────────
      else if (ch === 0x05 && ty === 0xcc) {
        decoded.period_in  = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        i += 4;
      }

      // ── Timestamp (0x0A 0xEF) ─────────────────────────────────────────────
      else if (ch === 0x0a && ty === 0xef) {
        decoded.timestamp = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
          (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // ── Temperature alarm (0x83 0x67) ─────────────────────────────────────
      else if (ch === 0x83 && ty === 0x67) {
        const raw = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.temperature = (raw > 0x7fff ? raw - 0x10000 : raw) / 10;
        const alarmMap: Record<number, string> = {
          0: 'threshold alarm release', 1: 'threshold alarm',
          3: 'high temperature alarm',  4: 'high temperature alarm release',
        };
        decoded.temperature_alarm = alarmMap[bytes[i + 2]] ?? 'unknown';
        i += 3;
      }

      // ── Total IN/OUT alarm (0x84 0xCC) ────────────────────────────────────
      else if (ch === 0x84 && ty === 0xcc) {
        decoded.total_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.total_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.total_count_alarm = bytes[i + 4] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 5;
      }

      // ── Period IN/OUT alarm (0x85 0xCC) ───────────────────────────────────
      else if (ch === 0x85 && ty === 0xcc) {
        decoded.period_in          = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        decoded.period_out         = ((bytes[i + 3] << 8) | bytes[i + 2]) & 0xffff;
        decoded.period_count_alarm = bytes[i + 4] === 1 ? 'threshold alarm' : 'threshold alarm release';
        i += 5;
      }

      // ── History (0x20 0xCE) ───────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const ts   = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        const type = bytes[i + 4];
        const entry: Record<string, any> = { timestamp: ts };
        if (type === 0) {
          entry.period_in  = ((bytes[i + 6] << 8) | bytes[i + 5]) & 0xffff;
          entry.period_out = ((bytes[i + 8] << 8) | bytes[i + 7]) & 0xffff;
          i += 9;
        } else if (type === 1) {
          entry.period_in  = ((bytes[i +  6] << 8) | bytes[i +  5]) & 0xffff;
          entry.period_out = ((bytes[i +  8] << 8) | bytes[i +  7]) & 0xffff;
          entry.total_in   = ((bytes[i + 10] << 8) | bytes[i +  9]) & 0xffff;
          entry.total_out  = ((bytes[i + 12] << 8) | bytes[i + 11]) & 0xffff;
          i += 13;
        } else {
          i += 5;
        }
        if (!decoded.history) decoded.history = [];
        decoded.history.push(entry);
      }

      // ── Standard downlink responses (0xFF / 0xFE) ─────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleStdDownlink(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      // ── Extended downlink responses (0xF9 / 0xF8) ─────────────────────────
      else if (ch === 0xf9 || ch === 0xf8) {
        const result = this.handleExtDownlink(ch, ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleStdDownlink(ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;
    const i16 = (o: number) => { const v = u16(o); return v > 0x7fff ? v - 0x10000 : v; };
    const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };

    switch (ty) {
      case 0x04:
        data.confirm_mode_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x05: {
        const cfg = { id: bytes[offset] & 0xff, mask: u16(offset + 1) };
        if (!data.lora_channel_mask_config) data.lora_channel_mask_config = [];
        data.lora_channel_mask_config.push(cfg);
        offset += 3; break;
      }
      case 0x06: {
        const byte0 = bytes[offset] & 0xff;
        const cond  = condMap[byte0 & 0x07] ?? 'unknown';
        const src   = (byte0 >>> 3) & 0x07;
        if (src === 1) {
          data.people_period_alarm_config = { condition: cond, threshold_out: u16(offset + 1), threshold_in: u16(offset + 3) };
        } else if (src === 2) {
          data.people_cumulative_alarm_config = { condition: cond, threshold_out: u16(offset + 1), threshold_in: u16(offset + 3) };
        } else if (src === 3) {
          data.temperature_alarm_config = { condition: cond, threshold_min: i16(offset + 1) / 10, threshold_max: i16(offset + 3) / 10 };
        }
        offset += 9; break;
      }
      case 0x10:
        data.reboot = 'yes'; offset += 1; break;
      case 0x27:
        data.clear_history = 'yes'; offset += 1; break;
      case 0x28:
        data.query_device_status = 'yes'; offset += 1; break;
      case 0x35:
        data.d2d_key = bytes.slice(offset, offset + 8)
          .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        offset += 8; break;
      case 0x40:
        data.adr_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x41:
        data.lora_port = bytes[offset] & 0xff; offset += 1; break;
      case 0x68:
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x69:
        data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x6a: {
        const t = bytes[offset] & 0xff;
        if (t === 0) data.retransmit_interval = u16(offset + 1);
        else         data.resend_interval     = u16(offset + 1);
        offset += 3; break;
      }
      case 0x6d:
        data.stop_transmit = 'yes'; offset += 1; break;
      case 0x75:
        data.hibernate_config = {
          enable:     bytes[offset] === 1 ? 'enable' : 'disable',
          start_time: u16(offset + 1),
          end_time:   u16(offset + 3),
        };
        offset += 6; break; // skip 1 reserved byte
      case 0x77:
        data.installation_height = u16(offset); offset += 2; break;
      case 0x84:
        data.d2d_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0x8e:
        // skip first byte (sub-type), uint16 LE
        data.report_interval = u16(offset + 1); offset += 3; break;
      case 0x8f:
        data.report_interval = u16(offset); offset += 2; break;
      case 0x96: {
        const modeMap: Record<number, string> = {
          1: 'someone enter', 2: 'someone leave', 3: 'counting threshold alarm',
          4: 'temperature alarm', 5: 'temperature alarm release',
        };
        const cfg: Record<string, any> = {
          mode:               modeMap[bytes[offset]] ?? 'unknown',
          enable:             bytes[offset + 1] === 1 ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset + 2] === 1 ? 'enable' : 'disable',
          d2d_cmd:            ('0' + (bytes[offset + 4] & 0xff).toString(16)).slice(-2) +
                              ('0' + (bytes[offset + 3] & 0xff).toString(16)).slice(-2),
          time:               u16(offset + 5),
          time_enable:        bytes[offset + 7] === 1 ? 'enable' : 'disable',
        };
        if (!data.d2d_master_config) data.d2d_master_config = [];
        data.d2d_master_config.push(cfg);
        offset += 8; break;
      }
      case 0xa6:
        data.reset_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xa8: {
        const t = bytes[offset] & 0xff;
        if (t === 0x01) data.reset_cumulative_in  = 'yes';
        else            data.reset_cumulative_out = 'yes';
        offset += 1; break;
      }
      case 0xa9:
        data.report_cumulative_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xaa:
        data.report_temperature_enable = bytes[offset] === 1 ? 'enable' : 'disable'; offset += 1; break;
      case 0xab:
        data.temperature_calibration_settings = {
          enable:            bytes[offset] === 1 ? 'enable' : 'disable',
          calibration_value: i16(offset + 1) / 10,
        };
        offset += 3; break;
      case 0xec: {
        const dirMap: Record<number, string> = { 0: 'forward', 1: 'reverse' };
        data.detection_direction = dirMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0xed: {
        const wdMap: Record<number, string> = { 0: 'everyday', 1: 'sunday', 2: 'monday', 3: 'tuesday', 4: 'wednesday', 5: 'thursday', 6: 'friday', 7: 'saturday' };
        data.reset_cumulative_schedule_config = {
          weekday: wdMap[bytes[offset]] ?? 'unknown',
          hour:    bytes[offset + 1] & 0xff,
          minute:  bytes[offset + 2] & 0xff,
        };
        offset += 3; break;
      }
      default:
        offset += 1; break;
    }
    return { data, offset };
  }

  private handleExtDownlink(code: number, ty: number, bytes: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    const u16 = (o: number) => ((bytes[o + 1] << 8) | bytes[o]) & 0xffff;
    const u32 = (o: number) => (((bytes[o + 3] << 24) | (bytes[o + 2] << 16) | (bytes[o + 1] << 8) | bytes[o]) >>> 0);

    switch (ty) {
      case 0x10: {
        const typeMap: Record<number, string> = { 0: 'period', 1: 'immediately' };
        data.report_type = typeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x85:
        data.rejoin_config = {
          enable:    bytes[offset] === 1 ? 'enable' : 'disable',
          max_count: bytes[offset + 1] & 0xff,
        };
        offset += 2; break;
      case 0x86:
        data.data_rate = bytes[offset] & 0xff; offset += 1; break;
      case 0x87:
        data.tx_power_level = bytes[offset] & 0xff; offset += 1; break;
      case 0x8b: {
        const vMap: Record<number, string> = { 1: 'v1.0.2', 2: 'v1.0.3' };
        data.lorawan_version = vMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0x8c:
        data.rx2_data_rate = bytes[offset] & 0xff; offset += 1; break;
      case 0x8d:
        data.rx2_frequency = u32(offset); offset += 4; break;
      case 0xa2: {
        const sceneMap: Record<number, string> = { 0: 'no_door_access', 1: 'door_controlled_access' };
        data.installation_scene = sceneMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      case 0xa3: {
        const modeMap: Record<number, string> = { 0: 'ABP', 1: 'OTAA' };
        data.lora_join_mode = modeMap[bytes[offset]] ?? 'unknown'; offset += 1; break;
      }
      default:
        offset += 1; break;
    }

    // 0xF8 carries result flag
    if (code === 0xf8) {
      const rv = bytes[offset++] & 0xff;
      if (rv !== 0) {
        const resultMap: Record<number, string> = { 0: 'success', 1: 'forbidden', 2: 'invalid parameter' };
        const req = { ...data };
        return {
          data: { device_response_result: { channel_type: ty, result: resultMap[rv] ?? 'unknown', request: req } },
          offset,
        };
      }
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const i16 = (v: number) => { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; };
    const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
    const hexBytes = (hex: string) => { const o: number[] = []; for (let i = 0; i < hex.length; i += 2) o.push(parseInt(hex.substr(i, 2), 16)); return o; };
    const d2dCmd  = (cmd: string) => [parseInt(cmd.substr(2, 2), 16), parseInt(cmd.substr(0, 2), 16)];

    switch (type) {
      // ── System ───────────────────────────────────────────────────────────
      case 'reboot':              bytes = [0xff, 0x10, 0xff]; break;
      case 'query_device_status': bytes = [0xff, 0x28, 0xff]; break;

      case 'set_report_interval': {
        const v = params.report_interval ?? 60;
        if (v < 1 || v > 1440) throw new Error('report_interval must be 1–1440 minutes');
        bytes = [0xff, 0x8e, 0x00, ...u16(v)]; break;
      }

      case 'set_installation_height': {
        const v = params.installation_height ?? 2700;
        if (v < 2000 || v > 3500) throw new Error('installation_height must be 2000–3500 mm');
        bytes = [0xff, 0x77, ...u16(v)]; break;
      }

      // ── Cumulative reset ──────────────────────────────────────────────────
      case 'set_reset_cumulative_enable':
        bytes = [0xff, 0xa6, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_reset_cumulative_schedule': {
        const wdMap: Record<string, number> = { everyday: 0, sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7 };
        const wd  = wdMap[params.weekday ?? 'everyday'] ?? 0;
        const hr  = params.hour   ?? 0;
        const min = params.minute ?? 0;
        if (hr < 0 || hr > 23)  throw new Error('hour must be 0–23');
        if (min < 0 || min > 59) throw new Error('minute must be 0–59');
        bytes = [0xff, 0xed, wd, hr, min]; break;
      }

      case 'reset_cumulative_in':  bytes = [0xff, 0xa8, 0x01]; break;
      case 'reset_cumulative_out': bytes = [0xff, 0xa8, 0x02]; break;

      case 'set_report_cumulative_enable':
        bytes = [0xff, 0xa9, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_report_temperature_enable':
        bytes = [0xff, 0xaa, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_temperature_calibration': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const val    = params.calibration_value ?? 0;
        bytes = [0xff, 0xab, enable, ...i16(Math.round(val * 10))]; break;
      }

      case 'set_detection_direction': {
        const dirMap: Record<string, number> = { forward: 0, reverse: 1 };
        bytes = [0xff, 0xec, dirMap[params.detection_direction ?? 'forward'] ?? 0]; break;
      }

      case 'set_hibernate_config': {
        const enable = params.enable === 'enable' ? 1 : 0;
        const start  = params.start_time ?? 0;
        const end    = params.end_time   ?? 0;
        if (start < 0 || start > 1439) throw new Error('start_time must be 0–1439');
        if (end   < 0 || end   > 1439) throw new Error('end_time must be 0–1439');
        bytes = [0xff, 0x75, enable, ...u16(start), ...u16(end), 0xff]; break;
      }

      // ── Alarm configs ─────────────────────────────────────────────────────
      case 'set_people_period_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x01 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte, ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0), 0, 0, 0, 0]; break;
      }

      case 'set_people_cumulative_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x02 << 3) | (0x01 << 6);
        bytes = [0xff, 0x06, dataByte, ...u16(params.threshold_out ?? 0), ...u16(params.threshold_in ?? 0), 0, 0, 0, 0]; break;
      }

      case 'set_temperature_alarm_config': {
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const cond = condMap[params.condition ?? 'disable'] ?? 0;
        const dataByte = cond | (0x03 << 3) | (0x01 << 6);
        const min = params.threshold_min ?? 0;
        const max = params.threshold_max ?? 0;
        bytes = [0xff, 0x06, dataByte, ...u16(Math.round(min * 10)), ...u16(Math.round(max * 10)), 0, 0, 0, 0]; break;
      }

      // ── Retransmit / history ──────────────────────────────────────────────
      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 600;
        if (v < 1 || v > 64800) throw new Error('retransmit_interval must be 1–64800');
        bytes = [0xff, 0x6a, 0x00, ...u16(v)]; break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 600;
        if (v < 1 || v > 64800) throw new Error('resend_interval must be 1–64800');
        bytes = [0xff, 0x6a, 0x01, ...u16(v)]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, params.enable === 'enable' ? 1 : 0]; break;

      case 'fetch_history': {
        const start = params.start_time ?? 0;
        const end   = params.end_time ?? 0;
        bytes = (end === 0)
          ? [0xfd, 0x6b, ...u32(start)]
          : [0xfd, 0x6c, ...u32(start), ...u32(end)];
        break;
      }

      case 'stop_transmit':    bytes = [0xfd, 0x6d, 0xff]; break;
      case 'clear_history':    bytes = [0xff, 0x27, 0x01]; break;

      // ── D2D ───────────────────────────────────────────────────────────────
      case 'set_d2d_key': {
        const key = params.d2d_key ?? '0000000000000000';
        if (key.length !== 16) throw new Error('d2d_key must be 16 hex characters');
        bytes = [0xff, 0x35, ...hexBytes(key)]; break;
      }

      case 'set_d2d_enable':
        bytes = [0xff, 0x84, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_d2d_master_config': {
        const modeMap: Record<string, number> = {
          'someone enter': 1, 'someone leave': 2, 'counting threshold alarm': 3,
          'temperature alarm': 4, 'temperature alarm release': 5,
        };
        const mode       = modeMap[params.mode ?? 'someone enter'] ?? 1;
        const enable     = params.enable             === 'enable' ? 1 : 0;
        const loraUplink = params.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd        = params.d2d_cmd ?? '0000';
        const time       = params.time ?? 0;
        const timeEnable = params.time_enable === 'enable' ? 1 : 0;
        if (cmd.length !== 4) throw new Error('d2d_cmd must be 4 hex characters');
        bytes = [0xff, 0x96, mode, enable, loraUplink, ...d2dCmd(cmd), ...u16(time), timeEnable]; break;
      }

      // ── LoRaWAN advanced ──────────────────────────────────────────────────
      case 'set_confirm_mode_enable':
        bytes = [0xff, 0x04, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_lora_channel_mask': {
        const id   = params.id ?? 1;
        const mask = params.mask ?? 0xff;
        if (id < 1 || id > 16) throw new Error('id must be 1–16');
        bytes = [0xff, 0x05, id & 0xff, ...u16(mask)]; break;
      }

      case 'set_adr_enable':
        bytes = [0xff, 0x40, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_lora_port': {
        const v = params.lora_port ?? 85;
        if (v < 1 || v > 223) throw new Error('lora_port must be 1–223');
        bytes = [0xff, 0x41, v & 0xff]; break;
      }

      case 'set_rejoin_config': {
        const enable   = params.enable === 'enable' ? 1 : 0;
        const maxCount = params.max_count ?? 10;
        bytes = [0xf9, 0x85, enable, maxCount & 0xff]; break;
      }

      case 'set_data_rate':
        bytes = [0xf9, 0x86, params.data_rate ?? 0]; break;

      case 'set_tx_power_level':
        bytes = [0xf9, 0x87, params.tx_power_level ?? 0]; break;

      case 'set_lorawan_version': {
        const vMap: Record<string, number> = { 'v1.0.2': 1, 'v1.0.3': 2 };
        bytes = [0xf9, 0x8b, vMap[params.lorawan_version ?? 'v1.0.2'] ?? 1]; break;
      }

      case 'set_rx2_data_rate':
        bytes = [0xf9, 0x8c, params.rx2_data_rate ?? 0]; break;

      case 'set_rx2_frequency':
        bytes = [0xf9, 0x8d, ...u32(params.rx2_frequency ?? 923500000)]; break;

      case 'set_lora_join_mode': {
        const modeMap: Record<string, number> = { ABP: 0, OTAA: 1 };
        bytes = [0xf9, 0xa3, modeMap[params.lora_join_mode ?? 'OTAA'] ?? 1]; break;
      }

      case 'set_report_type': {
        const m: Record<string, number> = { period: 0, immediately: 1 };
        bytes = [0xf9, 0x10, m[params.report_type ?? 'period'] ?? 0]; break;
      }

      case 'set_installation_scene': {
        const sceneMap: Record<string, number> = { no_door_access: 0, door_controlled_access: 1 };
        bytes = [0xf9, 0xa2, sceneMap[params.installation_scene ?? 'no_door_access'] ?? 0]; break;
      }

      default:
        throw new Error(`VS351: unsupported command "${type}"`);
    }

    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  // ── canDecode ───────────────────────────────────────────────────────────────
  // VS351 shares counter channels with VS350. Differentiate by:
  //   0xFF 0xCC — power_status (VS351-only)
  // Fall back to counter channels if power_status not present.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    let hasCounter = false;
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if (ch === 0xff && ty === 0xcc) return true; // power_status: VS351 unique
      if ((ch === 0x04 || ch === 0x05 || ch === 0x84 || ch === 0x85) && ty === 0xcc) hasCounter = true;
    }
    return hasCounter;
  }
}