// src/modules/devices/codecs/milesight/wt102.codec.ts
// Milesight WT102 — Smart Radiator Thermostat (Next-Gen)
//
// WT102 uses a FLAT command-ID protocol (not the classic channel_id+channel_type).
// Each uplink byte is a command ID; the following bytes are the payload for that command.
// This is a completely different wire format from WT101/GS301/WTS506.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import { BaseDeviceCodec, DecodedTelemetry, EncodedCommand } from '../../interfaces/base-codec.interface';

export class MilesightWT102Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-wt102';
  readonly manufacturer    = 'Milesight';
  readonly model           = 'WT102';
  readonly description     = 'Smart Radiator Thermostat (Next-Gen) — Flat Command Protocol';
  readonly supportedModels = ['WT102'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WT102',
    description:  'Smart Radiator Thermostat (Next-Gen) — flat command protocol, advanced controls',
    telemetryKeys: [
      { key: 'batteryLevel',            label: 'Battery',           type: 'number' as const, unit: '%'  },
      { key: 'temperature',             label: 'Temperature',       type: 'number' as const, unit: '°C' },
      { key: 'target_temperature',      label: 'Target Temp',       type: 'number' as const, unit: '°C' },
      { key: 'valve_opening_degree',    label: 'Valve Opening',     type: 'number' as const, unit: '%'  },
      { key: 'motor_position',          label: 'Motor Position',    type: 'number' as const              },
      { key: 'motor_total_stroke',      label: 'Motor Total Stroke', type: 'number' as const             },
    ],
    commands: [
      { type: 'reboot',              label: 'Reboot Device',        params: [] },
      { type: 'query_device_status', label: 'Query Device Status',  params: [] },
      { type: 'synchronize_time',    label: 'Synchronize Time',     params: [] },
      { type: 'collect_data',        label: 'Collect Data',         params: [] },
      { type: 'calibrate_motor',     label: 'Calibrate Motor',      params: [] },
      { type: 'clear_historical_data', label: 'Clear Historical Data', params: [] },
      {
        type:   'set_target_valve_opening',
        label:  'Set Target Valve Opening',
        params: [{ key: 'value', label: 'Opening (%)', type: 'number' as const, required: true, default: 0, min: 0, max: 100 }],
      },
      {
        type:   'set_target_temperature',
        label:  'Set Target Temperature',
        params: [{ key: 'value', label: 'Temperature (°C)', type: 'number' as const, required: true, default: 20, min: 5, max: 35 }],
      },
      {
        type:   'set_time_zone',
        label:  'Set Time Zone',
        params: [{ key: 'timezone', label: 'Offset (minutes, UTC+3=180)', type: 'number' as const, required: true, default: 180 }],
      },
      {
        type:   'set_temp_control_enable',
        label:  'Set Temperature Control Enable',
        params: [{ key: 'enable', label: 'Enable', type: 'boolean' as const, required: true }],
      },
      {
        type:   'set_freeze_protection',
        label:  'Set Freeze Protection',
        params: [
          { key: 'enable',      label: 'Enable',         type: 'boolean' as const, required: true  },
          { key: 'temperature', label: 'Temperature (°C)', type: 'number' as const, required: false, default: 3, min: 1, max: 10 },
        ],
      },
      {
        type:   'set_temperature_calibration',
        label:  'Set Temperature Calibration',
        params: [
          { key: 'enable',            label: 'Enable',      type: 'boolean' as const, required: true  },
          { key: 'calibration_value', label: 'Offset (°C)', type: 'number' as const, required: false, default: 0 },
        ],
      },
      {
        type:   'set_child_lock',
        label:  'Set Child Lock',
        params: [
          { key: 'enable',        label: 'Enable',         type: 'boolean' as const, required: true  },
          { key: 'system_button', label: 'System Button',  type: 'boolean' as const, required: false },
          { key: 'func_button',   label: 'Function Button', type: 'boolean' as const, required: false },
        ],
      },
      {
        type:   'retrieve_historical_data_by_time_range',
        label:  'Fetch History by Time Range',
        params: [
          { key: 'start_time', label: 'Start Time (Unix)', type: 'number' as const, required: true  },
          { key: 'end_time',   label: 'End Time (Unix)',   type: 'number' as const, required: true  },
        ],
      },
    ],
    uiComponents: [
      { type: 'battery' as const, label: 'Battery',       keys: ['batteryLevel']            },
      { type: 'gauge'   as const, label: 'Temperature',   keys: ['temperature'],   unit: '°C' },
      { type: 'gauge'   as const, label: 'Valve Opening', keys: ['valve_opening_degree'], unit: '%' },
      { type: 'value'   as const, label: 'Target Temp',   keys: ['target_temperature'], unit: '°C' },
    ],
  };
}

  // ── Decode uplink ─────────────────────────────────────────────────────────

  decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};
    const history: any[] = [];
    let isHistory = false;
    let currentDecoded: DecodedTelemetry = decoded;

    let i = 0;
    while (i < bytes.length) {
      const cmd = bytes[i++];

      switch (cmd) {

        // ── Protocol / device info ───────────────────────────────────────

        case 0xff: {
          // Sequence number check reply
          decoded.check_sequence_number_reply = { sequence_number: bytes[i++] };
          break;
        }
        case 0xfe: {
          decoded.check_order_reply = bytes[i++];
          break;
        }
        case 0xef: {
          // Command response
          const bits = bytes[i++];
          const result = (bits >> 4) & 0x0f;
          const length = bits & 0x0f;
          const id = bytes.slice(i, i + length).map(b => b.toString(16).padStart(2, '0')).join('');
          i += length;
          if (!decoded.ans) decoded.ans = [];
          (decoded.ans as any[]).push({ result, length, id });
          break;
        }
        case 0xee:
          decoded.all_configurations_request_by_device = 1;
          break;

        case 0xed: {
          // Historical data — skip type byte, read timestamp
          if (!isHistory) {
            // First history frame — save current decoded into result
            isHistory = true;
          }
          i++; // skip type byte (always 1 = historical)
          const ts = this.u32(bytes, i); i += 4;
          currentDecoded = { timestamp: ts };
          history.push(currentDecoded);
          break;
        }

        case 0xcf: {
          i++; // skip 1 byte
          decoded.lorawan_class = (['Class A', 'Class B', 'Class C', 'Class CtoB'])[bytes[i++]] ?? 'unknown';
          break;
        }
        case 0xdf:
          decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
          break;
        case 0xde:
          decoded.product_name = this.readStr(bytes, i, 32); i += 32;
          break;
        case 0xdd:
          decoded.product_pn = this.readStr(bytes, i, 32); i += 32;
          break;
        case 0xdb:
          decoded.product_sn = bytes.slice(i, i + 8).map(b => b.toString(16).padStart(2, '0')).join(''); i += 8;
          break;
        case 0xda: {
          const hw = `v${bytes[i]}.${bytes[i + 1]}`; i += 2;
          const fw = `v${bytes[i]}.${bytes[i + 1]}`; i += 6;
          decoded.version = { hardware_version: hw, firmware_version: fw };
          break;
        }
        case 0xd9:
          decoded.oem_id = bytes.slice(i, i + 2).map(b => b.toString(16).padStart(2, '0')).join(''); i += 2;
          break;
        case 0xc8:
          decoded.device_status = bytes[i++];
          break;
        case 0xd8:
          decoded.product_frequency_band = this.readStr(bytes, i, 16); i += 16;
          break;

        // ── Core telemetry ───────────────────────────────────────────────

        case 0x00:
          currentDecoded.batteryLevel = bytes[i++];
          break;
        case 0x01:
          currentDecoded.temperature = this.i16(bytes, i) / 100; i += 2;
          break;
        case 0x02:
          currentDecoded.motor_total_stroke = this.u16(bytes, i); i += 2;
          break;
        case 0x03:
          currentDecoded.motor_position = this.u16(bytes, i); i += 2;
          break;
        case 0x04:
          currentDecoded.valve_opening_degree = bytes[i++];
          break;
        case 0x05:
          currentDecoded.motor_calibration_result_report = {
            status: bytes[i++],
          };
          break;
        case 0x06:
          currentDecoded.target_temperature = this.i16(bytes, i) / 100; i += 2;
          break;
        case 0x07:
          currentDecoded.target_valve_opening_degree = bytes[i++];
          break;

        // ── Alarm events ─────────────────────────────────────────────────

        case 0x08: {
          const v = bytes[i++];
          currentDecoded.low_battery_alarm = { value: v };
          currentDecoded.batteryLevel = v;
          break;
        }
        case 0x09: {
          const type = bytes[i++];
          currentDecoded.temperature_alarm = { type };
          if (type === 0x10) {
            const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.temperature_alarm.lower_range_alarm_deactivation = { temperature: t };
            currentDecoded.temperature = t;
          } else if (type === 0x11) {
            const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.temperature_alarm.lower_range_alarm_trigger = { temperature: t };
            currentDecoded.temperature = t;
          } else if (type === 0x12) {
            const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.temperature_alarm.over_range_alarm_deactivation = { temperature: t };
            currentDecoded.temperature = t;
          } else if (type === 0x13) {
            const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.temperature_alarm.over_range_alarm_trigger = { temperature: t };
            currentDecoded.temperature = t;
          }
          break;
        }
        case 0x0a: {
          const type = bytes[i++];
          currentDecoded.anti_freeze_protection_alarm = { type };
          if (type === 0x20) {
            const t = this.i16(bytes, i) / 100; i += 2;
            const v = bytes[i++];
            currentDecoded.anti_freeze_protection_alarm.lifted = { environment_temperature: t, current_valve_status: v };
            currentDecoded.temperature = t;
            currentDecoded.valve_opening_degree = v;
          } else if (type === 0x21) {
            const t = this.i16(bytes, i) / 100; i += 2;
            const v = bytes[i++];
            currentDecoded.anti_freeze_protection_alarm.trigger = { environment_temperature: t, current_valve_status: v };
            currentDecoded.temperature = t;
            currentDecoded.valve_opening_degree = v;
          }
          break;
        }
        case 0x0b: {
          const type = bytes[i++];
          currentDecoded.mandatory_heating_alarm = { type };
          if (type === 0x20) {
            const t = this.i16(bytes, i) / 100; i += 2;
            const v = bytes[i++]; const batt = bytes[i++];
            currentDecoded.mandatory_heating_alarm.exit = { environment_temperature: t, current_valve_status: v, battery_level: batt };
            currentDecoded.temperature = t; currentDecoded.valve_opening_degree = v; currentDecoded.batteryLevel = batt;
          } else if (type === 0x21) {
            const t = this.i16(bytes, i) / 100; i += 2;
            const v = bytes[i++]; const batt = bytes[i++];
            currentDecoded.mandatory_heating_alarm.enter = { environment_temperature: t, current_valve_status: v, battery_level: batt };
            currentDecoded.temperature = t; currentDecoded.valve_opening_degree = v; currentDecoded.batteryLevel = batt;
          }
          break;
        }
        case 0x0c: {
          const etype = bytes[i++];
          currentDecoded.auto_away_report = { event_type: etype };
          if (etype === 0x20) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2; const tgt = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.auto_away_report.inactive_by_target_temperature = { state, environment_temperature: t, target_temperature: tgt };
            currentDecoded.temperature = t; currentDecoded.target_temperature = tgt;
          } else if (etype === 0x21) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2; const tgt = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.auto_away_report.active_by_target_temperature = { state, environment_temperature: t, target_temperature: tgt };
            currentDecoded.temperature = t;
          } else if (etype === 0x22) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2; const tvo = bytes[i++];
            currentDecoded.auto_away_report.inactive_by_target_valve_opening = { state, environment_temperature: t, target_valve_opening: tvo };
            currentDecoded.temperature = t; currentDecoded.target_valve_opening_degree = tvo;
          } else if (etype === 0x23) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2; const tvo = bytes[i++];
            currentDecoded.auto_away_report.active_by_target_valve_opening = { state, environment_temperature: t, target_valve_opening: tvo };
            currentDecoded.temperature = t;
          }
          break;
        }
        case 0x0d: {
          const type = bytes[i++];
          currentDecoded.window_opening_alarm = { type };
          if (type === 0x20) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.window_opening_alarm.release = { state, environment_temperature: t };
            currentDecoded.temperature = t;
          } else if (type === 0x21) {
            const state = bytes[i++]; const t = this.i16(bytes, i) / 100; i += 2;
            currentDecoded.window_opening_alarm.trigger = { state, environment_temperature: t };
            currentDecoded.temperature = t;
          }
          break;
        }
        case 0x0e: {
          const rtype = bytes[i++];
          currentDecoded.periodic_reporting = { report_type: rtype };
          if (rtype === 0x00) {
            const tvo = bytes[i++]; const batt = bytes[i++];
            currentDecoded.periodic_reporting.non_heating_season = { target_valve_opening: tvo, battery_level: batt };
            currentDecoded.target_valve_opening_degree = tvo; currentDecoded.batteryLevel = batt;
          } else if (rtype === 0x01) {
            const t = this.i16(bytes, i) / 100; i += 2; const cvo = bytes[i++]; const tgt = this.i16(bytes, i) / 100; i += 2; const batt = bytes[i++];
            currentDecoded.periodic_reporting.target_temperature_for_heating = { environment_temperature: t, current_valve_opening: cvo, target_temperature: tgt, battery_level: batt };
            currentDecoded.temperature = t; currentDecoded.valve_opening_degree = cvo; currentDecoded.target_temperature = tgt; currentDecoded.batteryLevel = batt;
          } else if (rtype === 0x02) {
            const t = this.i16(bytes, i) / 100; i += 2; const cvo = bytes[i++]; const tvo = bytes[i++]; const batt = bytes[i++];
            currentDecoded.periodic_reporting.target_valve_opening_for_heating = { environment_temperature: t, current_valve_opening: cvo, target_valve_opening: tvo, battery_level: batt };
            currentDecoded.temperature = t; currentDecoded.valve_opening_degree = cvo; currentDecoded.target_valve_opening_degree = tvo; currentDecoded.batteryLevel = batt;
          } else if (rtype === 0x03) {
            const t = this.i16(bytes, i) / 100; i += 2; const cvo = bytes[i++]; const tgt = this.i16(bytes, i) / 100; i += 2; const tvoo = bytes[i++]; const batt = bytes[i++];
            currentDecoded.periodic_reporting.integrated_control_for_heating = { environment_temperature: t, current_valve_opening: cvo, target_temperature: tgt, target_valve_opening: tvoo, battery_level: batt };
            currentDecoded.temperature = t; currentDecoded.valve_opening_degree = cvo; currentDecoded.target_temperature = tgt; currentDecoded.target_valve_opening_degree = tvoo; currentDecoded.batteryLevel = batt;
          }
          break;
        }

        // ── Settings read-back ────────────────────────────────────────────

        case 0xc9: decoded.random_key = bytes[i++]; break;
        case 0xc4: decoded.auto_p_enable = bytes[i++]; break;
        case 0x60: decoded.temperature_unit = bytes[i++]; break;

        case 0x61: {
          if (!decoded.temperature_source_settings) decoded.temperature_source_settings = {};
          const stype = bytes[i++];
          (decoded.temperature_source_settings as any).type = stype;
          if (stype === 0x01) {
            const timeout = this.u16(bytes, i); i += 2;
            const resp = bytes[i++];
            (decoded.temperature_source_settings as any).external_ntc_reception = { timeout, timeout_response: resp };
          } else if (stype === 0x02) {
            const timeout = this.u16(bytes, i); i += 2;
            const resp = bytes[i++];
            (decoded.temperature_source_settings as any).lorawan_reception = { timeout, timeout_response: resp };
          }
          break;
        }

        case 0x62: decoded.environment_temperature_display_enable = bytes[i++]; break;

        case 0x63: {
          if (!decoded.heating_period_settings) decoded.heating_period_settings = {};
          const sub = bytes[i++];
          if (sub === 0x00) {
            (decoded.heating_period_settings as any).heating_date_settings = {
              start_mon: bytes[i++], start_day: bytes[i++],
              end_mon:   bytes[i++], end_day:   bytes[i++],
            };
          } else if (sub === 0x01) {
            const unit = bytes[i++];
            const val  = this.u16(bytes, i); i += 2;
            (decoded.heating_period_settings as any).heating_period_reporting_interval = {
              unit, ...(unit === 0 ? { seconds_of_time: val } : { minutes_of_time: val }),
            };
          } else if (sub === 0x02) {
            const unit = bytes[i++];
            const val  = this.u16(bytes, i); i += 2;
            (decoded.heating_period_settings as any).non_heating_period_reporting_interval = {
              unit, ...(unit === 0 ? { seconds_of_time: val } : { minutes_of_time: val }),
            };
          } else if (sub === 0x03) {
            (decoded.heating_period_settings as any).valve_status_control = bytes[i++];
          }
          break;
        }

        case 0x65: {
          if (!decoded.temp_control) decoded.temp_control = {};
          const sub = bytes[i++];
          const tc  = decoded.temp_control as any;
          if (sub === 0x00) { tc.enable = bytes[i++]; }
          else if (sub === 0x01) { tc.target_temperature_resolution = bytes[i++]; }
          else if (sub === 0x02) { tc.under_temperature_side_deadband = this.i16(bytes, i) / 100; i += 2; }
          else if (sub === 0x03) { tc.over_temperature_side_deadband  = this.i16(bytes, i) / 100; i += 2; }
          else if (sub === 0x04) { tc.target_temperature_adjustment_range_min = this.i16(bytes, i) / 100; i += 2; }
          else if (sub === 0x05) { tc.target_temperature_adjustment_range_max = this.i16(bytes, i) / 100; i += 2; }
          else if (sub === 0x06) {
            const mode = bytes[i++];
            tc.mode_settings = { mode };
            if (mode === 0x00) { tc.mode_settings.auto_control    = { target_temperature: this.i16(bytes, i) / 100 }; i += 2; }
            if (mode === 0x01) { tc.mode_settings.valve_control    = { target_valve_status: bytes[i++] }; }
            if (mode === 0x02) { tc.mode_settings.intergrated_control = { target_temp: this.i16(bytes, i) / 100 }; i += 2; }
          }
          break;
        }

        case 0x66: {
          decoded.window_opening_detection_settings = {
            enable:                      bytes[i++],
            cooling_rate:                this.i16(bytes, i) / 100,
            valve_status:                bytes[i + 2],
            stop_temperature_control_time: this.u16(bytes, i + 3),
          };
          i += 5;
          break;
        }

        case 0x67: {
          const en = bytes[i++];
          const st = this.u16(bytes, i); i += 2;
          const et = this.u16(bytes, i); i += 2;
          const bits = bytes[i++];
          const esMode = bytes[i++];
          const es: any = { mode: esMode };
          if (esMode === 0x00) { es.energy_saving_temperature = this.i16(bytes, i) / 100; i += 2; }
          else if (esMode === 0x01) { es.energy_saving_valve_opening_degree = bytes[i++]; }
          decoded.auto_away_settings = {
            enable: en, start_time: st, end_time: et,
            cycle_time_sun:  (bits >> 0) & 1, cycle_time_mon:  (bits >> 1) & 1,
            cycle_time_tues: (bits >> 2) & 1, cycle_time_wed:  (bits >> 3) & 1,
            cycle_time_thur: (bits >> 4) & 1, cycle_time_fri:  (bits >> 5) & 1,
            cycle_time_sat:  (bits >> 6) & 1, reserved:        (bits >> 7) & 1,
            energy_saving_settings: es,
          };
          break;
        }

        case 0x68:
          decoded.anti_freeze_protection_setting = {
            enable: bytes[i++],
            temperature_value: this.i16(bytes, i) / 100,
          };
          i += 2;
          break;

        case 0x69: decoded.mandatory_heating_enable = bytes[i++]; break;

        case 0x6a: {
          const en   = bytes[i++];
          const bits = bytes[i++];
          decoded.child_lock = {
            enable: en,
            system_button: (bits >> 0) & 1,
            func_button:   (bits >> 1) & 1,
            reserved:      (bits >> 2) & 0x3f,
          };
          break;
        }

        case 0x6b: decoded.motor_stroke_limit = bytes[i++]; break;

        case 0x6c:
          decoded.temperature_calibration_settings = {
            enable: bytes[i++],
            calibration_value: this.i16(bytes, i) / 100,
          };
          i += 2;
          break;

        case 0x6d:
          decoded.temperature_alarm_settings = {
            enable:              bytes[i++],
            threshold_condition: bytes[i++],
            threshold_min:       this.i16(bytes, i) / 100,
            threshold_max:       this.i16(bytes, i + 2) / 100,
          };
          i += 4;
          break;

        case 0x6e: {
          if (!decoded.schedule_settings) decoded.schedule_settings = [];
          const id  = bytes[i++];
          const sub = bytes[i++];
          const arr = decoded.schedule_settings as any[];
          let item = arr.find(x => x.id === id);
          if (!item) { item = { id }; arr.push(item); }
          if (sub === 0x00) { item.enable = bytes[i++]; }
          else if (sub === 0x01) { item.start_time = this.u16(bytes, i); i += 2; }
          else if (sub === 0x02) {
            const bits = bytes[i++];
            item.cycle_settings = {
              execution_day_sun:  (bits >> 0) & 1, execution_day_mon:  (bits >> 1) & 1,
              execution_day_tues: (bits >> 2) & 1, execution_day_wed:  (bits >> 3) & 1,
              execution_day_thur: (bits >> 4) & 1, execution_day_fri:  (bits >> 5) & 1,
              execution_day_sat:  (bits >> 6) & 1, reserved:           (bits >> 7) & 1,
            };
          } else if (sub === 0x03) { item.temperature_control_mode = bytes[i++]; }
          else if (sub === 0x04) { item.target_temperature  = this.i16(bytes, i) / 100; i += 2; }
          else if (sub === 0x05) { item.target_valve_status = bytes[i++]; }
          else if (sub === 0x06) { item.pre_heating_enable  = bytes[i++]; }
          else if (sub === 0x07) { item.pre_heating_mode    = bytes[i++]; }
          else if (sub === 0x08) { item.pre_heating_manual_time = this.u16(bytes, i); i += 2; }
          else if (sub === 0x09) { item.report_cycle = this.u16(bytes, i); i += 2; }
          break;
        }

        case 0x6f: decoded.change_report_enable = bytes[i++]; break;

        case 0x70:
          decoded.motor_controllable_range = {
            enable:   bytes[i++],
            distance: this.u16(bytes, i) / 100,
          };
          i += 2;
          break;

        case 0xc7:
          decoded.time_zone = this.i16(bytes, i); i += 2;
          break;

        case 0xc6: {
          const en   = bytes[i++];
          const off  = bytes[i++];
          const sm   = bytes[i++];
          const swb  = bytes[i++];
          const st   = this.u16(bytes, i); i += 2;
          const em   = bytes[i++];
          const ewb  = bytes[i++];
          const et   = this.u16(bytes, i); i += 2;
          decoded.daylight_saving_time = {
            enable: en, daylight_saving_time_offset: off,
            start_month: sm, start_week_num: (swb >> 4) & 0x0f, start_week_day: swb & 0x0f, start_hour_min: st,
            end_month:   em, end_week_num:   (ewb >> 4) & 0x0f, end_week_day:   ewb & 0x0f, end_hour_min:   et,
          };
          break;
        }

        case 0xc5: {
          if (!decoded.data_storage_settings) decoded.data_storage_settings = {};
          const sub = bytes[i++];
          const ds  = decoded.data_storage_settings as any;
          if (sub === 0x00) { ds.enable = bytes[i++]; }
          else if (sub === 0x01) { ds.retransmission_enable = bytes[i++]; }
          else if (sub === 0x02) { ds.retransmission_interval = this.u16(bytes, i); i += 2; }
          else if (sub === 0x03) { ds.retrieval_interval = this.u16(bytes, i); i += 2; }
          break;
        }

        // ── Service command responses ─────────────────────────────────────

        case 0xb6: decoded.reconnect = 1; break;
        case 0xb9: decoded.query_device_status = 1; break;
        case 0xb8: decoded.synchronize_time = 1; break;
        case 0xb7: decoded.set_time = { timestamp: this.u32(bytes, i) }; i += 4; break;
        case 0xb5: decoded.collect_data = 1; break;
        case 0xbd: decoded.clear_historical_data = 1; break;
        case 0xbc: decoded.stop_historical_data_retrieval = 1; break;
        case 0xbb:
          decoded.retrieve_historical_data_by_time_range = {
            start_time: this.u32(bytes, i),
            end_time:   this.u32(bytes, i + 4),
          };
          i += 8;
          break;
        case 0xba: decoded.retrieve_historical_data_by_time = { time: this.u32(bytes, i) }; i += 4; break;
        case 0x57: decoded.query_motor_stroke_position = 1; break;
        case 0x58: decoded.calibrate_motor = 1; break;
        case 0x59: decoded.set_target_valve_opening_degree = { value: bytes[i++] }; break;
        case 0x5a: decoded.set_target_temperature = { value: this.i16(bytes, i) / 100 }; i += 2; break;
        case 0x5b: decoded.set_temperature = { value: this.i16(bytes, i) / 100 }; i += 2; break;
        case 0x5c: decoded.set_occupancy_state = { state: bytes[i++] }; break;
        case 0x5d: decoded.set_opening_window  = { state: bytes[i++] }; break;
        case 0x5e: decoded.delete_schedule = { type: bytes[i++] }; break;
        case 0xbf: decoded.reset = 1; break;
        case 0xbe: decoded.reboot = 1; break;

        default:
          throw new Error(`WT102: unknown command 0x${cmd.toString(16)}`);
      }
    }

    if (history.length > 0) decoded.history = history;
    return decoded;
  }

  // ── Encode downlink ───────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':             bytes = [0xbe]; break;
      case 'reset':              bytes = [0xbf]; break;
      case 'reconnect':          bytes = [0xb6]; break;
      case 'query_device_status':bytes = [0xb9]; break;
      case 'synchronize_time':   bytes = [0xb8]; break;
      case 'collect_data':       bytes = [0xb5]; break;
      case 'clear_historical_data': bytes = [0xbd]; break;
      case 'stop_historical_data_retrieval': bytes = [0xbc]; break;
      case 'query_motor_stroke_position': bytes = [0x57]; break;
      case 'calibrate_motor':    bytes = [0x58]; break;
      case 'request_query_all_configurations': bytes = [0xee]; break;

      case 'set_time': {
        const ts = params.timestamp ?? Math.floor(Date.now() / 1000);
        bytes = [0xb7, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff];
        break;
      }
      case 'retrieve_historical_data_by_time_range': {
        const { start_time, end_time } = params;
        bytes = [0xbb,
          start_time & 0xff, (start_time >> 8) & 0xff, (start_time >> 16) & 0xff, (start_time >> 24) & 0xff,
          end_time   & 0xff, (end_time   >> 8) & 0xff, (end_time   >> 16) & 0xff, (end_time   >> 24) & 0xff,
        ]; break;
      }
      case 'retrieve_historical_data_by_time': {
        const t = params.time ?? 0;
        bytes = [0xba, t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >> 24) & 0xff]; break;
      }
      case 'set_target_valve_opening': {
        bytes = [0x59, Math.min(100, Math.max(0, params.value ?? 0))]; break;
      }
      case 'set_target_temperature': {
        const v = Math.round((params.value ?? 20) * 100);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0x5a, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }
      case 'set_temperature': {
        const v = Math.round((params.value ?? 20) * 100);
        const v16 = v < 0 ? v + 0x10000 : v;
        bytes = [0x5b, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }
      case 'set_occupancy_state': bytes = [0x5c, params.state ?? 1]; break;
      case 'set_opening_window':  bytes = [0x5d, params.state ?? 0]; break;
      case 'delete_schedule':     bytes = [0x5e, params.type ?? 255]; break;

      case 'set_temperature_unit': bytes = [0x60, params.unit === 'F' || params.unit === 1 ? 1 : 0]; break;
      case 'set_environment_temperature_display': bytes = [0x62, params.enable === 1 || params.enable === 'enable' ? 1 : 0]; break;
      case 'set_mandatory_heating': bytes = [0x69, params.enable === 1 || params.enable === 'enable' ? 1 : 0]; break;
      case 'set_change_report': bytes = [0x6f, params.enable === 1 || params.enable === 'enable' ? 1 : 0]; break;
      case 'set_motor_stroke_limit': bytes = [0x6b, Math.min(100, Math.max(0, params.limit ?? 100))]; break;
      case 'set_auto_p': bytes = [0xc4, params.enable === 1 || params.enable === 'enable' ? 1 : 0]; break;

      case 'set_time_zone': {
        const tz = params.timezone ?? 180;
        const v = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xc7, v & 0xff, (v >> 8) & 0xff]; break;
      }

      case 'set_temp_control_enable': {
        bytes = [0x65, 0x00, params.enable === 1 || params.enable === 'enable' ? 1 : 0]; break;
      }
      case 'set_temp_control_mode': {
        const modeMap: Record<string, number> = { auto: 0, valve: 1, integrated: 2 };
        const mode = typeof params.mode === 'string' ? (modeMap[params.mode] ?? 0) : (params.mode ?? 0);
        bytes = [0x65, 0x06, mode];
        if (mode === 0 && params.target_temperature !== undefined) {
          const v = Math.round(params.target_temperature * 100);
          const v16 = v < 0 ? v + 0x10000 : v;
          bytes.push(v16 & 0xff, (v16 >> 8) & 0xff);
        } else if (mode === 1 && params.target_valve_status !== undefined) {
          bytes.push(params.target_valve_status);
        } else if (mode === 2 && params.target_temp !== undefined) {
          const v = Math.round(params.target_temp * 100);
          const v16 = v < 0 ? v + 0x10000 : v;
          bytes.push(v16 & 0xff, (v16 >> 8) & 0xff);
        }
        break;
      }

      case 'set_freeze_protection': {
        const en  = params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        const val = Math.round((params.temperature ?? 3) * 100);
        const v16 = val < 0 ? val + 0x10000 : val;
        bytes = [0x68, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_temperature_calibration': {
        const en  = params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        const val = Math.round((params.calibration_value ?? 0) * 100);
        const v16 = val < 0 ? val + 0x10000 : val;
        bytes = [0x6c, en, v16 & 0xff, (v16 >> 8) & 0xff]; break;
      }

      case 'set_child_lock': {
        const en   = params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        const bits = ((params.system_button ?? 0) & 1) | (((params.func_button ?? 0) & 1) << 1);
        bytes = [0x6a, en, bits]; break;
      }

      case 'set_heating_period': {
        bytes = [0x63, 0x00,
          params.start_mon ?? 10, params.start_day ?? 1,
          params.end_mon   ?? 4,  params.end_day   ?? 30,
        ]; break;
      }

      case 'set_motor_controllable_range': {
        const en   = params.enable === 1 || params.enable === 'enable' ? 1 : 0;
        const dist = Math.round((params.distance ?? 666) * 100);
        bytes = [0x70, en, dist & 0xff, (dist >> 8) & 0xff]; break;
      }

      default:
        throw new Error(`WT102: unsupported command: ${type}`);
    }

    return { data: Buffer.from(bytes).toString('base64'), fPort: 85 };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private u16(bytes: number[], i: number): number {
    return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
  }
  private i16(bytes: number[], i: number): number {
    const v = this.u16(bytes, i);
    return v > 0x7fff ? v - 0x10000 : v;
  }
  private u32(bytes: number[], i: number): number {
    return (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
  }
  private readStr(bytes: number[], offset: number, length: number): string {
    let str = '';
    for (let j = 0; j < length; j++) {
      if (bytes[offset + j] === 0) break;
      str += String.fromCharCode(bytes[offset + j]);
    }
    return str;
  }
}