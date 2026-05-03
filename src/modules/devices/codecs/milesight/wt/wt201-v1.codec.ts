// src/modules/devices/codecs/milesight/wt201-v1.codec.ts
// Milesight WT201 v1 — Smart Thermostat
//
// Wire protocol: IPSO channel_id + channel_type (classic Milesight LoRaWAN format)
//
// Key differences from WT201 v2:
//   - Plan types: wake/away/home/sleep only (no occupied/vacant/eco)
//   - History frame: 2×uint16 packed (fan+sys+temp, mode+status+target), 8 bytes total
//   - setTemperatureControl: 0xff/0xb7, byte-packed with unit in bit7 (not int16×10)
//   - D2D slave: flat action_type + action fields (not nested object)
//   - ob_mode values: on_cool/on_heat (underscores, not spaces)
//   - Extra commands: fan_delay, retransmit, history, fetch_history, plan_config (0xff/0xc8)
//   - No v2-only fields: target_temperature_2, dual-temp plans, current_temperature_control_mode

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightWT201V1Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-wt201-v1';
  readonly manufacturer    = 'Milesight';
  readonly model           = 'WT201';
  readonly description     = 'Smart Thermostat v1 — IPSO Channel Protocol';
  readonly supportedModels = ['WT201'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WT201',
    description:  'Smart Thermostat v1 — HVAC control, 4 plan types, fan, wires, D2D',
    telemetryKeys: [
      { key: 'temperature',              label: 'Temperature',     type: 'number' as const, unit: '°C' },
      { key: 'target_temperature',       label: 'Target Temp',     type: 'number' as const, unit: '°C' },
      { key: 'humidity',                 label: 'Humidity',        type: 'number' as const, unit: '%'  },
      { key: 'temperature_control_mode', label: 'Control Mode',    type: 'string' as const, enum: ['heat', 'em_heat', 'cool', 'auto'] },
      { key: 'fan_mode',                 label: 'Fan Mode',        type: 'string' as const, enum: ['auto', 'on', 'circulate'] },
      { key: 'plan_type',                label: 'Plan Type',       type: 'string' as const, enum: ['wake', 'away', 'home', 'sleep'] },
      { key: 'system_status',            label: 'System Status',   type: 'string' as const, enum: ['on', 'off'] },
    ],
    commands: [
      { type: 'reboot',    label: 'Reboot Device', params: [] },
      { type: 'sync_time', label: 'Sync Time',      params: [] },
      {
        type:   'report_status',
        label:  'Report Status',
        params: [{ key: 'report_status', label: 'Type', type: 'select' as const, required: true, options: [{ label: 'Plan', value: 'plan' }, { label: 'Periodic', value: 'periodic' }] }],
      },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'report_interval', label: 'Interval (minutes)', type: 'number' as const, required: true, default: 20, min: 1 }],
      },
      {
        type:   'set_temperature_control',
        label:  'Set Temperature Control',
        params: [
          { key: 'temperature_control_mode', label: 'Mode',           type: 'select' as const, required: true, options: ['heat','em_heat','cool','auto'].map(v => ({ label: v, value: v })) },
          { key: 'target_temperature',       label: 'Target Temp (°C)', type: 'number' as const, required: true, default: 20, min: 5, max: 35 },
        ],
      },
      {
        type:   'set_fan_mode',
        label:  'Set Fan Mode',
        params: [{ key: 'fan_mode', label: 'Mode', type: 'select' as const, required: true, options: ['auto','on','circulate'].map(v => ({ label: v, value: v })) }],
      },
      {
        type:   'set_plan_type',
        label:  'Set Plan Type',
        params: [{ key: 'plan_type', label: 'Plan', type: 'select' as const, required: true, options: ['wake','away','home','sleep'].map(v => ({ label: v, value: v })) }],
      },
      {
        type:   'set_freeze_protection_config',
        label:  'Set Freeze Protection',
        params: [
          { key: 'enable',      label: 'Enable',         type: 'boolean' as const, required: true  },
          { key: 'temperature', label: 'Temperature (°C)', type: 'number' as const, required: false, default: 5 },
        ],
      },
      {
        type:   'set_temperature_calibration_settings',
        label:  'Set Temperature Calibration',
        params: [
          { key: 'enable',            label: 'Enable',    type: 'boolean' as const, required: true  },
          { key: 'calibration_value', label: 'Offset (°C)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'time_zone', label: 'Offset (minutes, UTC+3=180)', type: 'number' as const, required: true, default: 180 }],
      },
      {
        type:   'set_ob_mode',
        label:  'Set O/B Mode',
        params: [{ key: 'ob_mode', label: 'Mode', type: 'select' as const, required: true, options: [{ label: 'On Cool', value: 'on_cool' }, { label: 'On Heat', value: 'on_heat' }] }],
      },
      {
        type:   'set_offline_control_mode',
        label:  'Set Offline Control Mode',
        params: [{ key: 'offline_control_mode', label: 'Mode', type: 'select' as const, required: true, options: ['keep','thermostat','off'].map(v => ({ label: v, value: v })) }],
      },
    ],
    uiComponents: [
      { type: 'gauge'  as const, label: 'Temperature',   keys: ['temperature'],              unit: '°C' },
      { type: 'value'  as const, label: 'Target Temp',   keys: ['target_temperature'],       unit: '°C' },
      { type: 'value'  as const, label: 'Humidity',      keys: ['humidity'],                 unit: '%'  },
      { type: 'status' as const, label: 'Control Mode',  keys: ['temperature_control_mode']             },
      { type: 'status' as const, label: 'System Status', keys: ['system_status']                        },
      { type: 'status' as const, label: 'Plan Type',     keys: ['plan_type']                            },
    ],
  };
}

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const channel_id   = bytes[i++];
      const channel_type = bytes[i++];

      // ── Device attributes ────────────────────────────────────────────

      if (channel_id === 0xff && channel_type === 0x01) {
        const b = bytes[i++];
        decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (channel_id === 0xff && channel_type === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (channel_id === 0xff && channel_type === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join('');
        i += 8;
      }
      else if (channel_id === 0xff && channel_type === 0x0f) {
        decoded.lorawan_class = (['Class A', 'Class B', 'Class C', 'Class CtoB'])[bytes[i++]] ?? 'unknown';
      }
      else if (channel_id === 0xff && channel_type === 0xfe) {
        decoded.reset_event = 'reset';
        i += 1;
      }
      else if (channel_id === 0xff && channel_type === 0x0b) {
        decoded.device_status = bytes[i++] === 1 ? 'on' : 'off';
      }

      // ── Core telemetry ───────────────────────────────────────────────

      else if (channel_id === 0x03 && channel_type === 0x67) {
        decoded.temperature = this.readInt16LE(bytes, i) / 10; i += 2;
      }
      else if (channel_id === 0x04 && channel_type === 0x67) {
        decoded.target_temperature = this.readInt16LE(bytes, i) / 10; i += 2;
      }
      else if (channel_id === 0x05 && channel_type === 0xe7) {
        const v = bytes[i++];
        decoded.temperature_control_mode   = this.decodeTemperatureControlMode((v >>> 0) & 0x03);
        decoded.temperature_control_status = this.decodeTemperatureControlStatus((v >>> 4) & 0x0f);
      }
      else if (channel_id === 0x06 && channel_type === 0xe8) {
        const v = bytes[i++];
        decoded.fan_mode   = this.decodeFanMode((v >>> 0) & 0x03);
        decoded.fan_status = this.decodeFanStatus((v >>> 2) & 0x03);
      }
      else if (channel_id === 0x07 && channel_type === 0xbc) {
        decoded.plan_type = this.decodeExecutePlanType((bytes[i++] >>> 0) & 0x0f);
      }
      else if (channel_id === 0x08 && channel_type === 0x8e) {
        decoded.system_status = bytes[i++] === 1 ? 'on' : 'off';
      }
      else if (channel_id === 0x09 && channel_type === 0x68) {
        decoded.humidity = (bytes[i++] & 0xff) / 2;
      }
      else if (channel_id === 0x0a && channel_type === 0x6e) {
        const s = bytes[i++];
        decoded.wires_relay = {
          y1:     (s >>> 0) & 0x01 ? 'on' : 'off',
          y2_gl:  (s >>> 1) & 0x01 ? 'on' : 'off',
          w1:     (s >>> 2) & 0x01 ? 'on' : 'off',
          w2_aux: (s >>> 3) & 0x01 ? 'on' : 'off',
          e:      (s >>> 4) & 0x01 ? 'on' : 'off',
          g:      (s >>> 5) & 0x01 ? 'on' : 'off',
          ob:     (s >>> 6) & 0x01 ? 'on' : 'off',
        };
      }
      else if (channel_id === 0xff && channel_type === 0xcb) {
        const mode = bytes[i]; const heat = bytes[i + 1]; const cool = bytes[i + 2]; i += 3;
        decoded.temperature_control_support_mode = {
          heat:    (mode >>> 0) & 0x01 ? 'enable' : 'disable',
          em_heat: (mode >>> 1) & 0x01 ? 'enable' : 'disable',
          cool:    (mode >>> 2) & 0x01 ? 'enable' : 'disable',
          auto:    (mode >>> 3) & 0x01 ? 'enable' : 'disable',
        };
        decoded.temperature_control_support_status = {
          stage_1_heat: (heat >>> 0) & 0x01 ? 'enable' : 'disable',
          stage_2_heat: (heat >>> 1) & 0x01 ? 'enable' : 'disable',
          stage_3_heat: (heat >>> 2) & 0x01 ? 'enable' : 'disable',
          stage_4_heat: (heat >>> 3) & 0x01 ? 'enable' : 'disable',
          aux_heat:     (heat >>> 4) & 0x01 ? 'enable' : 'disable',
          stage_1_cool: (cool >>> 0) & 0x01 ? 'enable' : 'disable',
          stage_2_cool: (cool >>> 1) & 0x01 ? 'enable' : 'disable',
        };
      }
      // TEMPERATURE ALARM — ref decoder has i += 2 bug; corrected here to i += 3
      else if (channel_id === 0x83 && channel_type === 0x67) {
        decoded.temperature       = this.readInt16LE(bytes, i) / 10;
        decoded.temperature_alarm = this.decodeTemperatureAlarm(bytes[i + 2]);
        i += 3;
      }
      else if (channel_id === 0xb3 && channel_type === 0x67) {
        decoded.temperature_sensor_status = bytes[i++] === 1 ? 'read failed' : 'out of range';
      }
      else if (channel_id === 0xb9 && channel_type === 0x68) {
        decoded.humidity_sensor_status = bytes[i++] === 1 ? 'read failed' : 'out of range';
      }

      // ── Historical data — v1 packed format (8 bytes) ─────────────────
      // value1: fan_mode(0..1) + fan_status(2..3) + system_status(4) + temperature(5..15)
      // value2: temperature_control_mode(0..1) + temperature_control_status(2..4) + target_temperature(5..15)
      // temperature = bits/10 - 100
      else if (channel_id === 0x20 && channel_type === 0xce) {
        const ts   = this.readUInt32LE(bytes, i);
        const val1 = this.readUInt16LE(bytes, i + 4);
        const val2 = this.readUInt16LE(bytes, i + 6);
        const temp = Number((((val1 >>> 5) & 0x7ff) / 10 - 100).toFixed(1));
        const tgt  = Number((((val2 >>> 5) & 0x7ff) / 10 - 100).toFixed(1));
        const entry: any = {
          timestamp:                  ts,
          fan_mode:                   this.decodeFanMode((val1 >>> 0) & 0x03),
          fan_status:                 this.decodeFanStatus((val1 >>> 2) & 0x03),
          system_status:              (val1 >>> 4) & 0x01 ? 'on' : 'off',
          temperature:                temp,
          temperature_control_mode:   this.decodeTemperatureControlMode((val2 >>> 0) & 0x03),
          temperature_control_status: this.decodeTemperatureControlStatus((val2 >>> 2) & 0x07),
          target_temperature:         tgt,
        };
        i += 8;
        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push(entry);
      }

      // ── Downlink responses ───────────────────────────────────────────
      else if (channel_id === 0xfe || channel_id === 0xff) {
        const result = this.handleDownlinkResponse(channel_type, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }
      else if (channel_id === 0xf8 || channel_id === 0xf9) {
        const result = this.handleDownlinkResponseExt(channel_id, channel_type, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }
      else {
        decoded.raw_channel_id = `0x${channel_id.toString(16).padStart(2, '0')}`;
        break;
      }
    }

    return decoded;
  }

  // ── Downlink response handler (0xff / 0xfe) ───────────────────────────────

  private handleDownlinkResponse(channel_type: number, bytes: number[], offset: number): { data: any; offset: number } {
    const decoded: any = {};

    switch (channel_type) {
      case 0x02:
        decoded.collection_interval = this.readUInt16LE(bytes, offset); offset += 2; break;

      case 0x03:
        decoded.outside_temperature = this.readInt16LE(bytes, offset) / 10; offset += 2; break;

      case 0x06: {
        const ctl       = bytes[offset];
        const condition = ctl & 0x07;
        const alarmType = (ctl >>> 3) & 0x07;
        const condMap   = ['disable', 'below', 'above', 'between', 'outside'];
        const atMap     = ['temperature threshold', 'continuous low temperature', 'continuous high temperature'];
        const d: any    = { condition: condMap[condition] ?? 'unknown', alarm_type: atMap[alarmType] ?? 'unknown' };
        if (condition === 1 || condition === 3 || condition === 4 || alarmType === 1) d.threshold_min = this.readInt16LE(bytes, offset + 1) / 10;
        if (condition === 2 || condition === 3 || condition === 4 || alarmType === 2) d.threshold_max = this.readInt16LE(bytes, offset + 3) / 10;
        d.lock_time     = this.readInt16LE(bytes, offset + 5);
        d.continue_time = this.readInt16LE(bytes, offset + 7);
        offset += 9;
        decoded.temperature_alarm_config = d; break;
      }

      case 0x10:
        decoded.reboot = 'yes'; offset += 1; break;

      case 0x25: {
        const masked = bytes[offset]; const status = bytes[offset + 1]; offset += 2;
        const btns: Record<string, number> = { power_button: 0, up_button: 1, down_button: 2, fan_button: 3, mode_button: 4, reset_button: 5 };
        decoded.child_lock_config = {};
        for (const [btn, bit] of Object.entries(btns)) {
          if ((masked >> bit) & 0x01) decoded.child_lock_config[btn] = (status >> bit) & 0x01 ? 'enable' : 'disable';
        }
        break;
      }

      case 0x27:
        decoded.clear_history = 'yes'; offset += 1; break;

      case 0x28:
        decoded.report_status = bytes[offset++] === 0 ? 'plan' : 'periodic'; break;

      case 0x68:
        decoded.history_enable = bytes[offset++] ? 'enable' : 'disable'; break;

      case 0x69:
        decoded.retransmit_enable = bytes[offset++] ? 'enable' : 'disable'; break;

      case 0x6a: {
        const itype = bytes[offset];
        if (itype === 0) decoded.retransmit_interval = this.readUInt16LE(bytes, offset + 1);
        else if (itype === 1) decoded.resend_interval = this.readUInt16LE(bytes, offset + 1);
        offset += 3; break;
      }

      case 0x82: {
        const v = bytes[offset]; const mask = v >>> 4; const enabled = v & 0x0f; offset += 1;
        const grps: Record<string, number> = { group1_enable: 0, group2_enable: 1, group3_enable: 2, group4_enable: 3 };
        decoded.multicast_group_config = {};
        for (const [grp, bit] of Object.entries(grps)) {
          if ((mask >> bit) & 0x01) decoded.multicast_group_config[grp] = (enabled >> bit) & 0x01 ? 'enable' : 'disable';
        }
        break;
      }

      case 0x83: {
        // v1: flat action_type + action (not nested object)
        const atv = (bytes[offset + 4] >>> 4) & 0x0f;
        const cfg: any = {
          id:          bytes[offset] + 1,
          enable:      bytes[offset + 1] ? 'enable' : 'disable',
          d2d_cmd:     this.decodeD2DCommand(bytes, offset + 2),
          action_type: atv === 0 ? 'power' : 'plan',
          action:      atv === 0
            ? ((bytes[offset + 4] & 0x0f) ? 'on' : 'off')
            : this.decodePlanType(bytes[offset + 4] & 0x0f),
        };
        offset += 5;
        if (!decoded.d2d_slave_config) decoded.d2d_slave_config = [];
        decoded.d2d_slave_config.push(cfg); break;
      }

      case 0x96: {
        // v1: mode field (not plan_type), same byte layout
        const cfg: any = {
          mode:               this.decodePlanType(bytes[offset]),
          enable:             bytes[offset + 1] ? 'enable' : 'disable',
          lora_uplink_enable: bytes[offset + 2] ? 'enable' : 'disable',
          d2d_cmd:            this.decodeD2DCommand(bytes, offset + 3),
          time:               this.readUInt16LE(bytes, offset + 5),
          time_enable:        bytes[offset + 7] ? 'enable' : 'disable',
        };
        offset += 8;
        if (!decoded.d2d_master_config) decoded.d2d_master_config = [];
        decoded.d2d_master_config.push(cfg); break;
      }

      case 0x4a:
        decoded.sync_time = 'yes'; offset += 1; break;

      case 0x8e:
        decoded.report_interval = this.readUInt16LE(bytes, offset + 1); offset += 3; break;

      case 0xab:
        decoded.temperature_calibration_settings = {
          enable:            bytes[offset] ? 'enable' : 'disable',
          calibration_value: this.readInt16LE(bytes, offset + 1) / 10,
        };
        offset += 3; break;

      case 0xb0:
        decoded.freeze_protection_config = {
          enable:      bytes[offset] ? 'enable' : 'disable',
          temperature: this.readInt16LE(bytes, offset + 1) / 10,
        };
        offset += 3; break;

      case 0xb5:
        decoded.ob_mode = this.decodeObMode(bytes[offset++]); break;

      case 0xb6:
        decoded.fan_mode = this.decodeFanMode(bytes[offset++]); break;

      case 0xb7:
        // v1 setTemperatureControl response: mode + byte-packed target with unit in bit7
        decoded.temperature_control_mode = this.decodeTemperatureControlMode(bytes[offset]);
        decoded.target_temperature        = bytes[offset + 1] & 0x7f;
        decoded.temperature_unit          = (bytes[offset + 1] >>> 7) & 0x01 ? 'fahrenheit' : 'celsius';
        offset += 2; break;

      case 0xb8:
        decoded.temperature_tolerance = {
          target_temperature_tolerance: bytes[offset] / 10,
          auto_temperature_tolerance:   bytes[offset + 1] / 10,
        };
        offset += 2; break;

      case 0xb9:
        decoded.temperature_level_up_condition = {
          type:                  bytes[offset] === 0 ? 'heat' : 'cool',
          time:                  bytes[offset + 1],
          temperature_tolerance: this.readInt16LE(bytes, offset + 2) / 10,
        };
        offset += 4; break;

      case 0xba: {
        const en = bytes[offset];
        decoded.dst_config = { enable: en ? 'enable' : 'disable' };
        decoded.dst_config.offset       = bytes[offset + 1];
        decoded.dst_config.start_month  = bytes[offset + 2];
        const sd = bytes[offset + 3];
        decoded.dst_config.start_week_num = (sd >>> 4) & 0x0f;
        decoded.dst_config.start_week_day = sd & 0x0f;
        decoded.dst_config.start_time   = this.readUInt16LE(bytes, offset + 4);
        decoded.dst_config.end_month    = bytes[offset + 6];
        const ed = bytes[offset + 7];
        decoded.dst_config.end_week_num = (ed >>> 4) & 0x0f;
        decoded.dst_config.end_week_day = ed & 0x0f;
        decoded.dst_config.end_time     = this.readUInt16LE(bytes, offset + 8);
        offset += 10; break;
      }

      case 0xbd:
        decoded.time_zone = this.decodeTimeZone(this.readInt16LE(bytes, offset)); offset += 2; break;

      case 0xc1: {
        const atMap = ['power', 'plan'];
        const atv   = bytes[offset + 1];
        const act   = bytes[offset + 2];
        decoded.card_config = { enable: bytes[offset] ? 'enable' : 'disable' };
        decoded.card_config.action_type = atMap[atv] ?? 'unknown';
        if (atv === 1) {
          decoded.card_config.in_plan_type  = this.decodePlanType((act >>> 4) & 0x0f);
          decoded.card_config.out_plan_type = this.decodePlanType(act & 0x0f);
        } else if (atv === 0) {
          decoded.card_config.action = act ? 'on' : 'off';
        }
        decoded.card_config.invert = bytes[offset + 3] ? 'yes' : 'no';
        offset += 4; break;
      }

      case 0xc2:
        decoded.plan_type = this.decodePlanType(bytes[offset++]); break;

      case 0xc4:
        decoded.outside_temperature_control = {
          enable:  bytes[offset] ? 'enable' : 'disable',
          timeout: bytes[offset + 1],
        };
        offset += 2; break;

      case 0xc5:
        decoded.temperature_control_enable = bytes[offset++] ? 'enable' : 'disable'; break;

      case 0xc7: {
        const d = bytes[offset++]; const dmask = d >>> 4; const dstat = d & 0x0f;
        if ((dmask >> 0) & 0x01) decoded.d2d_master_enable = dstat & 0x01 ? 'enable' : 'disable';
        if ((dmask >> 1) & 0x01) decoded.d2d_slave_enable  = (dstat >> 1) & 0x01 ? 'enable' : 'disable';
        break;
      }

      case 0xc8: {
        // plan_config response: type + mode + fan + packed_target + tolerance
        const ttv = bytes[offset + 3];
        const cfg: any = {
          type:                     this.decodePlanType(bytes[offset]),
          temperature_control_mode: this.decodeTemperatureControlMode(bytes[offset + 1]),
          fan_mode:                 this.decodeFanMode(bytes[offset + 2]),
          target_temperature:       ttv & 0x7f,
          temperature_unit:         (ttv >>> 7) & 0x01 ? 'fahrenheit' : 'celsius',
          temperature_tolerance:    (bytes[offset + 4] & 0x7f) / 10,
        };
        offset += 5;
        if (!decoded.plan_config) decoded.plan_config = [];
        decoded.plan_config.push(cfg); break;
      }

      case 0xc9: {
        const sched = this.decodePlanSchedule(bytes, offset); offset += 6;
        if (!decoded.plan_schedule) decoded.plan_schedule = [];
        decoded.plan_schedule.push(sched); break;
      }

      case 0xca:
        decoded.wires   = this.decodeWires(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
        decoded.ob_mode = this.decodeObMode((bytes[offset + 2] >>> 2) & 0x03);
        offset += 3; break;

      case 0xf6:
        decoded.control_permission = bytes[offset++] === 0 ? 'thermostat' : 'remote control'; break;

      case 0xf7: {
        const wmask = this.readUInt16LE(bytes, offset); const wstat = this.readUInt16LE(bytes, offset + 2); offset += 4;
        const wbits: Record<string, number> = { y1: 0, y2_gl: 1, w1: 2, w2_aux: 3, e: 4, g: 5, ob: 6 };
        decoded.wires_relay_config = {};
        for (const [k, bit] of Object.entries(wbits)) {
          if ((wmask >>> bit) & 0x01) decoded.wires_relay_config[k] = (wstat >>> bit) & 0x01 ? 'on' : 'off';
        }
        break;
      }

      case 0xf8:
        decoded.offline_control_mode = (['keep', 'thermostat', 'off'])[bytes[offset++]] ?? 'unknown'; break;

      case 0xf9:
        decoded.humidity_calibration_settings = {
          enable:            bytes[offset] ? 'enable' : 'disable',
          calibration_value: this.readInt16LE(bytes, offset + 1) / 10,
        };
        offset += 3; break;

      case 0xfa:
        decoded.temperature_control_mode = this.decodeTemperatureControlMode(bytes[offset]);
        decoded.target_temperature        = this.readInt16LE(bytes, offset + 1) / 10;
        offset += 3; break;

      case 0xfb:
        decoded.temperature_control_mode = this.decodeTemperatureControlMode(bytes[offset++]); break;

      default:
        decoded.raw_channel_type = `0x${channel_type.toString(16).padStart(2, '0')}`;
        break;
    }

    return { data: decoded, offset };
  }

  // ── Downlink response ext handler (0xf8 / 0xf9) ──────────────────────────

  private handleDownlinkResponseExt(code: number, channel_type: number, bytes: number[], offset: number): { data: any; offset: number } {
    const decoded: any = {};

    switch (channel_type) {
      case 0x05:
        decoded.fan_delay_enable = bytes[offset] ? 'enable' : 'disable';
        decoded.fan_delay_time   = bytes[offset + 1];
        offset += 2; break;

      case 0x06:
        decoded.fan_execute_time = bytes[offset++]; break;

      case 0x07:
        decoded.fan_dehumidify = {
          enable:       bytes[offset] ? 'enable' : 'disable',
          execute_time: bytes[offset + 1],
        };
        offset += 2; break;

      case 0x08:
        decoded.screen_display_mode = (['on', 'without plan show', 'disable all'])[bytes[offset++]] ?? 'unknown'; break;

      case 0x09:
        decoded.humidity_range = { min: bytes[offset], max: bytes[offset + 1] }; offset += 2; break;

      case 0x0a: {
        decoded.temperature_dehumidify = { enable: bytes[offset] ? 'enable' : 'disable' };
        const tv = bytes[offset + 1];
        if (tv !== 0xff) decoded.temperature_dehumidify.temperature_tolerance = tv / 10;
        offset += 2; break;
      }

      default:
        decoded.raw_channel_type = `0x${channel_type.toString(16).padStart(2, '0')}`;
        break;
    }

    // Result flag (only for 0xf8)
    if (code === 0xf8) {
      const rv = bytes[offset++];
      if (rv !== 0) {
        const statusMap = ['success', 'forbidden', 'invalid parameter'];
        const req = { ...decoded };
        Object.keys(decoded).forEach(k => delete decoded[k]);
        decoded.device_response_result = {
          channel_type,
          result:  statusMap[rv] ?? 'unknown',
          request: req,
        };
      }
    }

    return { data: decoded, offset };
  }

  // ── Encode downlink ───────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {

      case 'reboot':
        bytes = [0xff, 0x10, 0xff]; break;

      case 'sync_time':
        bytes = params.sync_time === 0 || params.sync_time === 'no' ? [] : [0xff, 0x4a, 0xff]; break;

      case 'report_status': {
        const v = params.report_status === 'periodic' || params.report_status === 1 ? 1 : 0;
        bytes = [0xff, 0x28, v]; break;
      }

      case 'set_report_interval': {
        const v = params.report_interval ?? 20;
        bytes = [0xff, 0x8e, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_collection_interval': {
        const v = params.collection_interval ?? 60;
        bytes = [0xff, 0x02, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_time_zone': {
        const tz = params.time_zone ?? 0;
        const v = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0xbd, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_dst_config': {
        const en  = params.dst_config?.enable === 1 || params.dst_config?.enable === 'enable' ? 1 : 0;
        const off = params.dst_config?.offset ?? 60;
        const sm  = params.dst_config?.start_month    ?? 3;
        const swb = ((params.dst_config?.start_week_num ?? 2) << 4) | (params.dst_config?.start_week_day ?? 7);
        const st  = params.dst_config?.start_time ?? 120;
        const em  = params.dst_config?.end_month   ?? 10;
        const ewb = ((params.dst_config?.end_week_num ?? 1) << 4) | (params.dst_config?.end_week_day ?? 7);
        const et  = params.dst_config?.end_time ?? 180;
        bytes = [0xff, 0xba, en, off < 0 ? off + 0x100 : off,
          sm, swb, st & 0xff, (st >> 8) & 0xff,
          em, ewb, et & 0xff, (et >> 8) & 0xff]; break;
      }

      case 'set_temperature_control_enable':
        bytes = [0xff, 0xc5, params.temperature_control_enable === 1 || params.temperature_control_enable === 'enable' ? 1 : 0]; break;

      // v1-specific: 0xff/0xb7 — mode + byte-packed target (bit7 = fahrenheit flag)
      case 'set_temperature_control': {
        const modeMap: Record<string, number> = { heat: 0, em_heat: 1, cool: 2, auto: 3 };
        const m   = typeof params.temperature_control_mode === 'string' ? (modeMap[params.temperature_control_mode] ?? 0) : (params.temperature_control_mode ?? 0);
        const isFahrenheit = params.temperature_unit === 'fahrenheit' || params.temperature_unit === 1;
        const val = isFahrenheit ? ((params.target_temperature ?? 20) | 0x80) : ((params.target_temperature ?? 20) & 0x7f);
        bytes = [0xff, 0xb7, m, val & 0xff]; break;
      }

      case 'set_temperature_target': {
        const modeMap: Record<string, number> = { heat: 0, em_heat: 1, cool: 2, auto: 3 };
        const m   = typeof params.temperature_control_mode === 'string' ? (modeMap[params.temperature_control_mode] ?? 0) : (params.temperature_control_mode ?? 0);
        const v   = Math.round((params.target_temperature ?? 20) * 10);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0xfa, m, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_temperature_control_mode': {
        const modeMap: Record<string, number> = { heat: 0, em_heat: 1, cool: 2, auto: 3 };
        const m = typeof params.temperature_control_mode === 'string' ? (modeMap[params.temperature_control_mode] ?? 0) : (params.temperature_control_mode ?? 0);
        bytes = [0xff, 0xfb, m]; break;
      }

      case 'set_temperature_calibration_settings': {
        const en  = params.temperature_calibration_settings?.enable === 1 || params.temperature_calibration_settings?.enable === 'enable' ? 1 : 0;
        const v   = Math.round((params.temperature_calibration_settings?.calibration_value ?? 0) * 10);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0xab, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_humidity_calibration_settings': {
        const en  = params.humidity_calibration_settings?.enable === 1 || params.humidity_calibration_settings?.enable === 'enable' ? 1 : 0;
        const v   = Math.round((params.humidity_calibration_settings?.calibration_value ?? 0) * 10);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0xf9, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_temperature_tolerance': {
        const tgt  = Math.round((params.temperature_tolerance?.target_temperature_tolerance ?? 1) * 10);
        const auto = Math.round((params.temperature_tolerance?.auto_temperature_tolerance   ?? 1) * 10);
        bytes = [0xff, 0xb8, tgt & 0xff, auto & 0xff]; break;
      }

      case 'set_temperature_level_up_condition': {
        const t   = params.temperature_level_up_condition?.type === 'cool' || params.temperature_level_up_condition?.type === 1 ? 1 : 0;
        const tol = Math.round((params.temperature_level_up_condition?.temperature_tolerance ?? 1) * 10);
        bytes = [0xff, 0xb9, t, params.temperature_level_up_condition?.time ?? 10, tol & 0xff]; break;
      }

      case 'set_outside_temperature_control': {
        const en = params.outside_temperature_control?.enable === 1 || params.outside_temperature_control?.enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0xc4, en, params.outside_temperature_control?.timeout ?? 10]; break;
      }

      // v1: [0x03, int16LE*10, 0x00]
      case 'set_outside_temperature': {
        const v   = Math.round((params.outside_temperature ?? 20) * 10);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0x03, v16 & 0xff, (v16 >> 8) & 0xff, 0x00]; break;
      }

      case 'set_freeze_protection_config': {
        const en  = params.freeze_protection_config?.enable === 1 || params.freeze_protection_config?.enable === 'enable' ? 1 : 0;
        const v   = Math.round((params.freeze_protection_config?.temperature ?? 5) * 10);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0xff, 0xb0, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_fan_mode': {
        const fMap: Record<string, number> = { auto: 0, on: 1, circulate: 2 };
        const f = typeof params.fan_mode === 'string' ? (fMap[params.fan_mode] ?? 0) : (params.fan_mode ?? 0);
        bytes = [0xff, 0xb6, f]; break;
      }

      case 'set_fan_delay': {
        const en = params.fan_delay_enable === 1 || params.fan_delay_enable === 'enable' ? 1 : 0;
        bytes = [0xf9, 0x05, en, params.fan_delay_time ?? 10]; break;
      }

      case 'set_fan_execute_time':
        bytes = [0xf9, 0x06, params.fan_execute_time ?? 30]; break;

      case 'set_humidity_range':
        bytes = [0xf9, 0x09, params.humidity_range?.min ?? 10, params.humidity_range?.max ?? 90]; break;

      case 'set_temperature_dehumidify': {
        const en  = params.temperature_dehumidify?.enable === 1 || params.temperature_dehumidify?.enable === 'enable' ? 1 : 0;
        const tol = params.temperature_dehumidify?.temperature_tolerance !== undefined
          ? (params.temperature_dehumidify.temperature_tolerance === 0xff ? 0xff : Math.round(params.temperature_dehumidify.temperature_tolerance * 10))
          : 0xff;
        bytes = [0xf9, 0x0a, en, en ? tol : 0]; break;
      }

      case 'set_fan_dehumidify': {
        const en = params.fan_dehumidify?.enable === 1 || params.fan_dehumidify?.enable === 'enable' ? 1 : 0;
        bytes = [0xf9, 0x07, en, en ? (params.fan_dehumidify?.execute_time ?? 10) : 0]; break;
      }

      case 'set_plan_type': {
        const pMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
        const p = typeof params.plan_type === 'string' ? (pMap[params.plan_type] ?? 0) : (params.plan_type ?? 0);
        bytes = [0xff, 0xc2, p]; break;
      }

      case 'set_plan_schedule': {
        const ptMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
        const ps  = params.plan_schedule ?? {};
        const pt  = typeof ps.type === 'string' ? (ptMap[ps.type] ?? 0) : (ps.type ?? 0);
        const id  = (ps.id ?? 1) - 1;
        const en  = ps.enable === 1 || ps.enable === 'enable' ? 1 : 0;
        const wdOff: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
        let days = 0;
        for (const [day, bit] of Object.entries(wdOff)) {
          if ((ps.week_recycle ?? {})[day] === 1 || (ps.week_recycle ?? {})[day] === 'enable') days |= 1 << bit;
        }
        const time = ps.time ?? 0;
        bytes = [0xff, 0xc9, pt, id, en, days, time & 0xff, (time >> 8) & 0xff]; break;
      }

      case 'set_plan_config': {
        // 0xff/0xc8: type + mode + fan + byte-packed target + tolerance
        const ptMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
        const tmMap: Record<string, number> = { heat: 0, em_heat: 1, cool: 2, auto: 3 };
        const fmMap: Record<string, number> = { auto: 0, on: 1, circulate: 2 };
        const pc  = params.plan_config ?? {};
        const pt  = typeof pc.type === 'string' ? (ptMap[pc.type] ?? 0) : (pc.type ?? 0);
        const tm  = typeof pc.temperature_control_mode === 'string' ? (tmMap[pc.temperature_control_mode] ?? 0) : (pc.temperature_control_mode ?? 0);
        const fm  = typeof pc.fan_mode === 'string' ? (fmMap[pc.fan_mode] ?? 0) : (pc.fan_mode ?? 0);
        const isFahrenheit = pc.temperature_unit === 'fahrenheit' || pc.temperature_unit === 1;
        const tval = isFahrenheit ? ((pc.target_temperature ?? 20) | 0x80) : ((pc.target_temperature ?? 20) & 0x7f);
        const tol  = Math.round((pc.temperature_tolerance ?? 1) * 10);
        bytes = [0xff, 0xc8, pt, tm, fm, tval & 0xff, tol < 0 ? tol + 0x100 : tol]; break;
      }

      case 'set_card_config': {
        const cc   = params.card_config ?? {};
        const en   = cc.enable === 1 || cc.enable === 'enable' ? 1 : 0;
        const atMap: Record<string, number> = { power: 0, plan: 1 };
        const at   = en ? (typeof cc.action_type === 'string' ? (atMap[cc.action_type] ?? 0) : (cc.action_type ?? 0)) : 0;
        const ptMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
        let action = 0;
        if (en && at === 1) {
          const inp = typeof cc.in_plan_type  === 'string' ? (ptMap[cc.in_plan_type]  ?? 0) : (cc.in_plan_type  ?? 0);
          const oup = typeof cc.out_plan_type === 'string' ? (ptMap[cc.out_plan_type] ?? 0) : (cc.out_plan_type ?? 0);
          action = (inp << 4) | oup;
        }
        const inv = en ? (cc.invert === 1 || cc.invert === 'yes' ? 1 : 0) : 0;
        bytes = [0xff, 0xc1, en, at, action, inv]; break;
      }

      case 'set_child_lock_config': {
        const btns: Record<string, number> = { power_button: 0, up_button: 1, down_button: 2, fan_button: 3, mode_button: 4, reset_button: 5 };
        let masked = 0; let status = 0;
        for (const [k, bit] of Object.entries(btns)) {
          if (k in (params.child_lock_config ?? {})) {
            masked |= 1 << bit;
            status |= (params.child_lock_config[k] === 1 || params.child_lock_config[k] === 'enable' ? 1 : 0) << bit;
          }
        }
        bytes = [0xff, 0x25, masked, status]; break;
      }

      case 'set_ob_mode': {
        // v1 uses on_cool/on_heat (underscores)
        const oMap: Record<string, number> = { on_cool: 0, on_heat: 1 };
        const o = typeof params.ob_mode === 'string' ? (oMap[params.ob_mode] ?? 0) : (params.ob_mode ?? 0);
        bytes = [0xff, 0xb5, o]; break;
      }

      case 'set_wires': {
        const onOff = (v: any) => v === 1 || v === 'on' ? 1 : 0;
        const w = params.wires ?? {};
        let b1 = 0, b2 = 0, b3 = 0;
        if ('y1'  in w) b1 |= onOff(w.y1)  << 0;
        if ('gh'  in w) b1 |= onOff(w.gh)  << 2;
        if ('ob'  in w) b1 |= onOff(w.ob)  << 4;
        if ('w1'  in w) b1 |= onOff(w.w1)  << 6;
        if ('e'   in w) b2 |= onOff(w.e)   << 0;
        if ('di'  in w) b2 |= onOff(w.di)  << 2;
        if ('pek' in w) b2 |= onOff(w.pek) << 4;
        if ('w2'  in w) b2 |= onOff(w.w2)  << 6;
        if ('aux' in w) b2 |= onOff(w.aux) ? 2 << 6 : 0;
        if ('y2'  in w) b3 |= onOff(w.y2)  << 0;
        if ('gl'  in w) b3 |= onOff(w.gl)  ? 2 << 0 : 0;
        const obMap: Record<string, number> = { on_cool: 0, on_heat: 1, hold: 3 };
        b3 |= (typeof params.ob_mode === 'string' ? (obMap[params.ob_mode] ?? 0) : (params.ob_mode ?? 0)) << 2;
        bytes = [0xff, 0xca, b1, b2, b3]; break;
      }

      case 'set_wires_relay_config': {
        const onOff = (v: any) => v === 1 || v === 'on' ? 1 : 0;
        const wbits: Record<string, number> = { y1: 0, y2_gl: 1, w1: 2, w2_aux: 3, e: 4, g: 5, ob: 6 };
        const wrc = params.wires_relay_config ?? {};
        let masked = 0, status = 0;
        for (const [k, bit] of Object.entries(wbits)) {
          if (k in wrc) { masked |= 1 << bit; status |= onOff(wrc[k]) << bit; }
        }
        bytes = [0xff, 0xf7, masked & 0xff, (masked >> 8) & 0xff, status & 0xff, (status >> 8) & 0xff]; break;
      }

      case 'set_multicast_group_config': {
        const grps: Record<string, number> = { group1_enable: 0, group2_enable: 1, group3_enable: 2, group4_enable: 3 };
        const mgc = params.multicast_group_config ?? {};
        let maskId = 0, maskEn = 0;
        for (const [k, bit] of Object.entries(grps)) {
          if (k in mgc) { maskId |= 1 << bit; maskEn |= (mgc[k] === 1 || mgc[k] === 'enable' ? 1 : 0) << bit; }
        }
        bytes = [0xff, 0x82, (maskId << 4) | maskEn]; break;
      }

      case 'set_d2d_enable': {
        let mask = 0, status = 0;
        if ('d2d_master_enable' in params) { mask |= 1 << 0; status |= (params.d2d_master_enable === 1 || params.d2d_master_enable === 'enable' ? 1 : 0) << 0; }
        if ('d2d_slave_enable'  in params) { mask |= 1 << 1; status |= (params.d2d_slave_enable  === 1 || params.d2d_slave_enable  === 'enable' ? 1 : 0) << 1; }
        bytes = [0xff, 0xc7, (mask << 4) | status]; break;
      }

      case 'set_d2d_master_config': {
        const dmc  = params.d2d_master_config ?? {};
        const modeMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
        const m    = typeof dmc.mode === 'string' ? (modeMap[dmc.mode] ?? 0) : (dmc.mode ?? 0);
        const en   = dmc.enable === 1 || dmc.enable === 'enable' ? 1 : 0;
        const ul   = dmc.lora_uplink_enable === 1 || dmc.lora_uplink_enable === 'enable' ? 1 : 0;
        const cmd  = (dmc.d2d_cmd ?? '0000').match(/.{2}/g)!.map((h: string) => parseInt(h, 16));
        const d2d  = [cmd[1] ?? 0, cmd[0] ?? 0];
        const time = dmc.time ?? 0;
        const te   = dmc.time_enable === 1 || dmc.time_enable === 'enable' ? 1 : 0;
        bytes = [0xff, 0x96, m, en, ul, ...d2d, time & 0xff, (time >> 8) & 0xff, te]; break;
      }

      case 'set_d2d_slave_config': {
        // v1: flat action_type + action (not nested object)
        const dsc = params.d2d_slave_config ?? {};
        const id  = (dsc.id ?? 1) - 1;
        const en  = dsc.enable === 1 || dsc.enable === 'enable' ? 1 : 0;
        const cmd = (dsc.d2d_cmd ?? '0000').match(/.{2}/g)!.map((h: string) => parseInt(h, 16));
        const d2d = [cmd[1] ?? 0, cmd[0] ?? 0];
        const atMap: Record<string, number> = { power: 0, plan: 1 };
        const atv = typeof dsc.action_type === 'string' ? (atMap[dsc.action_type] ?? 0) : (dsc.action_type ?? 0);
        let data = 0;
        if (atv === 0) {
          data = (atv << 4) | (dsc.action === 'on' || dsc.action === 1 ? 1 : 0);
        } else {
          const pMap: Record<string, number> = { wake: 0, away: 1, home: 2, sleep: 3 };
          const pv = typeof dsc.action === 'string' ? (pMap[dsc.action] ?? 0) : (dsc.action ?? 0);
          data = (atv << 4) | pv;
        }
        bytes = [0xff, 0x83, id, en, ...d2d, data]; break;
      }

      case 'set_temperature_alarm_config': {
        const tac     = params.temperature_alarm_config ?? {};
        const condMap: Record<string, number> = { disable: 0, below: 1, above: 2, between: 3, outside: 4 };
        const atMap:   Record<string, number> = { 'temperature threshold': 0, 'continuous low temperature': 1, 'continuous high temperature': 2 };
        const cond = typeof tac.condition === 'string' ? (condMap[tac.condition] ?? 0) : (tac.condition ?? 0);
        const at   = typeof tac.alarm_type === 'string' ? (atMap[tac.alarm_type] ?? 0) : (tac.alarm_type ?? 0);
        const data = cond | (at << 3);
        const mn   = Math.round((tac.threshold_min ?? 10) * 10); const mn16 = mn < 0 ? mn + 0x10000 : mn;
        const mx   = Math.round((tac.threshold_max ?? 30) * 10); const mx16 = mx < 0 ? mx + 0x10000 : mx;
        const lt   = tac.lock_time ?? 0;
        const ct   = tac.continue_time ?? 10;
        bytes = [0xff, 0x06, data,
          mn16 & 0xff, (mn16 >> 8) & 0xff, mx16 & 0xff, (mx16 >> 8) & 0xff,
          lt & 0xff, (lt >> 8) & 0xff, ct & 0xff, (ct >> 8) & 0xff]; break;
      }

      case 'set_control_permission':
        bytes = [0xff, 0xf6, params.control_permission === 'remote control' || params.control_permission === 1 ? 1 : 0]; break;

      case 'set_offline_control_mode': {
        const ocMap: Record<string, number> = { keep: 0, thermostat: 1, off: 2 };
        const oc = typeof params.offline_control_mode === 'string' ? (ocMap[params.offline_control_mode] ?? 0) : (params.offline_control_mode ?? 0);
        bytes = [0xff, 0xf8, oc]; break;
      }

      case 'set_screen_display_mode': {
        const sdMap: Record<string, number> = { on: 0, 'without plan show': 1, 'disable all': 2 };
        bytes = [0xf9, 0x08, typeof params.screen_display_mode === 'string' ? (sdMap[params.screen_display_mode] ?? 0) : (params.screen_display_mode ?? 0)]; break;
      }

      case 'set_retransmit_enable':
        bytes = [0xff, 0x69, params.retransmit_enable === 1 || params.retransmit_enable === 'enable' ? 1 : 0]; break;

      case 'set_retransmit_interval': {
        const v = params.retransmit_interval ?? 600;
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_resend_interval': {
        const v = params.resend_interval ?? 600;
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_history_enable':
        bytes = [0xff, 0x68, params.history_enable === 1 || params.history_enable === 'enable' ? 1 : 0]; break;

      case 'fetch_history': {
        const st = params.fetch_history?.start_time ?? 0;
        const et = params.fetch_history?.end_time;
        if (et !== undefined) {
          bytes = [0xfd, 0x6c,
            st & 0xff, (st >> 8) & 0xff, (st >> 16) & 0xff, (st >> 24) & 0xff,
            et & 0xff, (et >> 8) & 0xff, (et >> 16) & 0xff, (et >> 24) & 0xff];
        } else {
          bytes = [0xfd, 0x6b,
            st & 0xff, (st >> 8) & 0xff, (st >> 16) & 0xff, (st >> 24) & 0xff];
        }
        break;
      }

      case 'stop_transmit':
        bytes = params.stop_transmit === 0 || params.stop_transmit === 'no' ? [] : [0xfd, 0x6d, 0xff]; break;

      case 'clear_history':
        bytes = params.clear_history === 0 || params.clear_history === 'no' ? [] : [0xff, 0x27, 0x01]; break;

      default:
        throw new Error(`WT201-v1: unsupported command: ${type}`);
    }

    return { data: Buffer.from(bytes).toString('base64'), fPort: 85 };
  }

  // ── Decode helpers ────────────────────────────────────────────────────────

  private decodeTemperatureControlMode(v: number): string {
    return (['heat', 'em_heat', 'cool', 'auto'])[v] ?? 'unknown';
  }

  private decodeTemperatureControlStatus(v: number): string {
    return (['standby', 'stage-1 heat', 'stage-2 heat', 'stage-3 heat',
             'stage-4 heat', 'em_heat', 'stage-1 cool', 'stage-2 cool'])[v] ?? 'unknown';
  }

  private decodeFanMode(v: number): string {
    return (['auto', 'on', 'circulate', 'disable'])[v] ?? 'unknown';
  }

  private decodeFanStatus(v: number): string {
    return (['standby', 'high speed', 'low speed', 'on'])[v] ?? 'unknown';
  }

  private decodeObMode(v: number): string {
    return v === 0 ? 'on_cool' : v === 1 ? 'on_heat' : v === 3 ? 'hold' : 'unknown';
  }

  private decodePlanType(v: number): string {
    return (['wake', 'away', 'home', 'sleep'])[v] ?? 'unknown';
  }

  private decodeExecutePlanType(v: number): string {
    const fix = v - 1;
    if (fix === -1) return 'not executed';
    return this.decodePlanType(fix);
  }

  private decodeTemperatureAlarm(v: number): string {
    const map: Record<number, string> = {
      1: 'emergency heating timeout alarm',   2: 'auxiliary heating timeout alarm',
      3: 'persistent low temperature alarm',  4: 'persistent low temperature alarm release',
      5: 'persistent high temperature alarm', 6: 'persistent high temperature alarm release',
      7: 'freeze protection alarm',           8: 'freeze protection alarm release',
      9: 'threshold alarm',                  10: 'threshold alarm release',
    };
    return map[v] ?? 'unknown';
  }

  private decodeTimeZone(v: number): string {
    const map: Record<number, string> = {
      [-720]: 'UTC-12', [-660]: 'UTC-11', [-600]: 'UTC-10', [-570]: 'UTC-9:30',
      [-540]: 'UTC-9',  [-480]: 'UTC-8',  [-420]: 'UTC-7',  [-360]: 'UTC-6',
      [-300]: 'UTC-5',  [-240]: 'UTC-4',  [-210]: 'UTC-3:30', [-180]: 'UTC-3',
      [-120]: 'UTC-2',  [-60]:  'UTC-1',  0: 'UTC',
      60: 'UTC+1', 120: 'UTC+2', 180: 'UTC+3', 210: 'UTC+3:30', 240: 'UTC+4',
      270: 'UTC+4:30', 300: 'UTC+5', 330: 'UTC+5:30', 345: 'UTC+5:45', 360: 'UTC+6',
      390: 'UTC+6:30', 420: 'UTC+7', 480: 'UTC+8', 540: 'UTC+9', 570: 'UTC+9:30',
      600: 'UTC+10', 630: 'UTC+10:30', 660: 'UTC+11', 720: 'UTC+12',
      765: 'UTC+12:45', 780: 'UTC+13', 840: 'UTC+14',
    };
    return map[v] ?? `UTC${v >= 0 ? '+' : ''}${v / 60}`;
  }

  private decodePlanSchedule(bytes: number[], offset: number): any {
    const wdOff: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };
    const week: any = {};
    for (const [day, bit] of Object.entries(wdOff)) {
      week[day] = (bytes[offset + 3] >>> bit) & 0x01 ? 'enable' : 'disable';
    }
    return {
      type:         this.decodePlanType(bytes[offset]),
      id:           bytes[offset + 1] + 1,
      enable:       bytes[offset + 2] ? 'enable' : 'disable',
      week_recycle: week,
      time:         this.readUInt16LE(bytes, offset + 4),
    };
  }

  private decodeD2DCommand(bytes: number[], offset: number): string {
    return bytes[offset + 1].toString(16).padStart(2, '0') + bytes[offset].toString(16).padStart(2, '0');
  }

  private decodeWires(w1: number, w2: number, w3: number): any {
    const onOff = (v: number) => v ? 'on' : 'off';
    return {
      y1:  onOff((w1 >>> 0) & 0x03),
      gh:  onOff((w1 >>> 2) & 0x03),
      ob:  onOff((w1 >>> 4) & 0x03),
      w1:  onOff((w1 >>> 6) & 0x03),
      e:   onOff((w2 >>> 0) & 0x03),
      di:  onOff((w2 >>> 2) & 0x03),
      pek: onOff((w2 >>> 4) & 0x03),
      w2:  onOff((w2 >>> 6) & 0x01),
      aux: onOff(((w2 >>> 6) & 0x03) === 2 ? 1 : 0),
      y2:  onOff((w3 >>> 0) & 0x01),
      gl:  onOff(((w3 >>> 0) & 0x03) === 2 ? 1 : 0),
    };
  }

  // ── Low-level read helpers ────────────────────────────────────────────────

  private readUInt16LE(bytes: number[], i: number): number {
    return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
  }

  private readInt16LE(bytes: number[], i: number): number {
    const v = this.readUInt16LE(bytes, i);
    return v > 0x7fff ? v - 0x10000 : v;
  }

  private readUInt32LE(bytes: number[], i: number): number {
    return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
  }
}