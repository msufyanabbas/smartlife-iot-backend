// src/modules/devices/codecs/milesight/gs601.codec.ts
// Milesight GS601 — LoRaWAN Air Quality Sensor (Vaping / PM / TVOC / Temp / Humidity)
//
// Protocol: Single-byte command ID (same family as TS601/TS602 cellular)
//   NOT IPSO channel_id+type
//
// ── Telemetry (uplink) ──────────────────────────────────────────────────────
//   0x00 battery            uint8, %
//   0x01 vaping_index       uint8, 0-100
//   0x02 vaping_index_alarm typed: 0x00 collection_error, 0x01 lower_range_error,
//                           0x02 over_range_error, 0x10 alarm_deactivation (+u8),
//                           0x11 alarm_trigger (+u8), 0x20 interference_alarm_deactivation,
//                           0x21 interference_alarm_trigger
//   0x03 pm1_0              uint16 LE, ug/m3
//   0x04 pm1_0_alarm        typed (similar pattern, 0x10/0x11 have uint16 payload)
//   0x05 pm2_5              uint16 LE, ug/m3
//   0x06 pm2_5_alarm        typed
//   0x07 pm10               uint16 LE, ug/m3
//   0x08 pm10_alarm         typed
//   0x09 temperature        int16 LE /10, °C  ← NOTE: /10 not /100 (unlike TS601)
//   0x0a temperature_alarm  typed (0x10/0x11 have int16/10, 0x20/0x21 no payload)
//   0x0b humidity           uint16 LE /10, %
//   0x0c humidity_alarm     typed (only 0x00/0x01/0x02 error types)
//   0x0d tvoc               uint16 LE, ug/m3
//   0x0e tvoc_alarm         typed
//   0x0f tamper_status      uint8 (0=Normal, 1=Triggered)
//   0x10 tamper_status_alarm typed (0x20=normal, 0x21=trigger, no payload)
//   0x11 buzzer             uint8 (0=Normal, 1=Triggered)
//   0x12 occupancy_status   uint8 (0=vacant, 1=occupied)
//   0x20-0x26 tvoc_raw_data_1..7  2× float32 LE each (rmox_0..rmox_12, zmod4510_rmox_3)
//   0x27-0x2a tvoc_raw_data_8..11 2× float32 LE each
//   0x2b pm_sensor_working_time   uint32 LE
//   0xc8 device_status      uint8
//   0xc9 random_key         uint8
//   0xc7 time_zone          int16 LE, MINUTES (e.g. UTC+8 = 480)
//   0xc6 daylight_saving_time  complex struct (11 fields)
//   0xcf lorawan_configuration_settings (detached subcommand)
//   0xda version            hw(2B) + fw(6B)
//   0xdb product_sn         8B hex
//   0xd9 oem_id             2B hex
//   0xdf tsl_version        2B
//
// ── Settings / RW (both directions) ────────────────────────────────────────
//   0x60 reporting_interval  <unit:u8> <value:u16> (unit 0=s, 1=min)
//   0x61 temperature_unit    uint8 (0=°C, 1=°F)
//   0x62 led_status          uint8
//   0x63 buzzer_enable       uint8
//   0x64 buzzer_sleep        detached: 0x01/0x02 items (enable+start_time+end_time)
//   0x65 buzzer_button_stop_enable uint8
//   0x66 buzzer_silent_time  uint16 LE, minutes
//   0x67 tamper_alarm_enable uint8
//   0x68 tvoc_raw_reporting_enable uint8
//   0x69 temperature_alarm_settings  enable(u8) + condition(u8) + min(i16/10) + max(i16/10)
//   0x6a pm1_0_alarm_settings        enable + condition + min(i16) + max(i16)
//   0x6b pm2_5_alarm_settings
//   0x6c pm10_alarm_settings
//   0x6d tvoc_alarm_settings
//   0x6e vaping_index_alarm_settings  enable + condition + min(u8) + max(u8)
//   0x6f alarm_reporting_times  uint16 LE
//   0x70 alarm_deactivation_enable uint8
//   0x71 temperature_calibration_settings  enable(u8) + value(i16/10)
//   0x72 humidity_calibration_settings     enable + value(i16/10)
//   0x73 pm1_0_calibration_settings        enable + value(i16)
//   0x74 pm2_5_calibration_settings
//   0x75 pm10_calibration_settings
//   0x76 tvoc_calibration_settings         enable + value(i16)
//   0x77 vaping_index_calibration_settings  enable + value(i8)
//
// ── Service commands (downlink only) ───────────────────────────────────────
//   0x5e execute_tvoc_self_clean  (1 byte)
//   0x5f stop_buzzer_alarm        (1 byte)
//   0xb6 reconnect                (1 byte)
//   0xb7 set_time                 + uint32 timestamp
//   0xb8 synchronize_time         (1 byte)
//   0xb9 query_device_status      (1 byte)
//   0xba retrieve_historical_data_by_time_range + start(u32) + end(u32)
//   0xbb retrieve_historical_data_by_time + uint32
//   0xbc stop_historical_data_retrieval (1 byte)
//   0xbd clear_historical_data          (1 byte)
//   0xbe reboot                         (1 byte)
//   0xbf reset                          (1 byte)
//
// ── Key protocol notes ──────────────────────────────────────────────────────
//   - Temperature /10 (NOT /100 like TS601 cellular)
//   - Timezone in MINUTES (same as TS601/TS602)
//   - Float32 LE for all tvoc_raw_data fields
//   - reporting_interval uses unit prefix byte before the value
//   - processTemperature: adds celsius_temperature & fahrenheit_temperature aliases
//   - canDecode: vaping_index (0x01) and tvoc (0x0d) are GS601-exclusive

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Numeric helpers ───────────────────────────────────────────────────────────
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i16(b: number[], i: number): number { const v = u16(b, i); return v > 0x7fff ? v - 0x10000 : v; }
function u32(b: number[], i: number): number { return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0); }
function f32(b: number[], i: number): number {
  const bits = u32(b, i);
  const sign = (bits >>> 31) === 0 ? 1 : -1;
  const e = (bits >>> 23) & 0xff;
  const m = e === 0 ? (bits & 0x7fffff) << 1 : (bits & 0x7fffff) | 0x800000;
  return sign * m * Math.pow(2, e - 150);
}
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }

function round1(n: number): number { return Math.round(n * 10) / 10; }

// ── Timezone map (MINUTES) ────────────────────────────────────────────────────
const TZ_MAP: Record<number, string> = {
  [-720]:'UTC-12(IDLW)', [-660]:'UTC-11(SST)', [-600]:'UTC-10(HST)',
  [-570]:'UTC-9:30(MIT)', [-540]:'UTC-9(AKST)', [-480]:'UTC-8(PST)',
  [-420]:'UTC-7(MST)', [-360]:'UTC-6(CST)', [-300]:'UTC-5(EST)',
  [-240]:'UTC-4(AST)', [-210]:'UTC-3:30(NST)', [-180]:'UTC-3(BRT)',
  [-120]:'UTC-2(FNT)', [-60]:'UTC-1(CVT)', [0]:'UTC(WET)',
  [60]:'UTC+1(CET)', [120]:'UTC+2(EET)', [180]:'UTC+3(MSK)',
  [210]:'UTC+3:30(IRST)', [240]:'UTC+4(GST)', [270]:'UTC+4:30(AFT)',
  [300]:'UTC+5(PKT)', [330]:'UTC+5:30(IST)', [345]:'UTC+5:45(NPT)',
  [360]:'UTC+6(BHT)', [390]:'UTC+6:30(MMT)', [420]:'UTC+7(ICT)',
  [480]:'UTC+8(CT/CST)', [540]:'UTC+9(JST)', [570]:'UTC+9:30(ACST)',
  [600]:'UTC+10(AEST)', [630]:'UTC+10:30(LHST)', [660]:'UTC+11(VUT)',
  [720]:'UTC+12(NZST)', [765]:'UTC+12:45(CHAST)', [780]:'UTC+13(PHOT)',
  [840]:'UTC+14(LINT)',
};

export class MilesightGS601Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-gs601';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['GS601'];
  readonly protocol        = 'lorawan' as const;

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const cmd = bytes[i++];
      switch (cmd) {

        // ── Version / identity ──────────────────────────────────────────────
        case 0xdf:
          decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2; break;

        case 0xdb:
          decoded.product_sn = bytes.slice(i, i + 8)
            .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8; break;

        case 0xda:
          decoded.version = {
            hardware_version: `V${bytes[i]}.${bytes[i + 1]}`,
            firmware_version: this.decodeFirmwareVersion(bytes.slice(i + 2, i + 8)),
          }; i += 8; break;

        case 0xd9:
          decoded.oem_id = bytes.slice(i, i + 2)
            .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 2; break;

        case 0xcf: {
          decoded.lorawan_configuration_settings = decoded.lorawan_configuration_settings ?? {};
          const subcmd = bytes[i++];
          if (subcmd === 0x00) {
            decoded.lorawan_configuration_settings.mode = bytes[i++];
          } else { i += 1; } // unknown subcommand, skip 1 byte gracefully
          break;
        }

        // ── Battery ──────────────────────────────────────────────────────────
        case 0x00: decoded.battery = bytes[i++] & 0xff; break;

        // ── Vaping index ──────────────────────────────────────────────────────
        case 0x01: decoded.vaping_index = bytes[i++] & 0xff; break;

        case 0x02: {
          const type = bytes[i++];
          decoded.vaping_index_alarm = decoded.vaping_index_alarm ?? {};
          decoded.vaping_index_alarm.type = type;
          if (type === 0x10) {
            decoded.vaping_index_alarm.alarm_deactivation = { vaping_index: bytes[i] & 0xff };
            decoded.vaping_index = bytes[i++] & 0xff;
          } else if (type === 0x11) {
            decoded.vaping_index_alarm.alarm_trigger = { vaping_index: bytes[i] & 0xff };
            decoded.vaping_index = bytes[i++] & 0xff;
          }
          // 0x00/0x01/0x02/0x20/0x21 — no additional bytes
          break;
        }

        // ── PM sensors ───────────────────────────────────────────────────────
        case 0x03: decoded.pm1_0 = u16(bytes, i); i += 2; break;
        case 0x04: i = this.decodePmAlarm('pm1_0_alarm', 'pm1_0', bytes, i, decoded, true); break;
        case 0x05: decoded.pm2_5 = u16(bytes, i); i += 2; break;
        case 0x06: i = this.decodePmAlarm('pm2_5_alarm', 'pm2_5', bytes, i, decoded, true); break;
        case 0x07: decoded.pm10 = u16(bytes, i); i += 2; break;
        case 0x08: i = this.decodePmAlarm('pm10_alarm', 'pm10', bytes, i, decoded, true); break;

        // ── Temperature ───────────────────────────────────────────────────────
        case 0x09:
          decoded.temperature = round1(i16(bytes, i) / 10); i += 2; break;

        case 0x0a: {
          const type = bytes[i++];
          decoded.temperature_alarm = decoded.temperature_alarm ?? {};
          decoded.temperature_alarm.type = type;
          if (type === 0x10) {
            const t = round1(i16(bytes, i) / 10); i += 2;
            decoded.temperature_alarm.alarm_deactivation = { temperature: t };
            decoded.temperature = t;
          } else if (type === 0x11) {
            const t = round1(i16(bytes, i) / 10); i += 2;
            decoded.temperature_alarm.alarm_trigger = { temperature: t };
            decoded.temperature = t;
          }
          // 0x00/0x01/0x02/0x20/0x21 — no payload
          break;
        }

        // ── Humidity ──────────────────────────────────────────────────────────
        case 0x0b: decoded.humidity = round1(u16(bytes, i) / 10); i += 2; break;

        case 0x0c: {
          const type = bytes[i++];
          decoded.humidity_alarm = decoded.humidity_alarm ?? {};
          decoded.humidity_alarm.type = type;
          // types 0x00/0x01/0x02 only — no payload
          break;
        }

        // ── TVOC ──────────────────────────────────────────────────────────────
        case 0x0d: decoded.tvoc = u16(bytes, i); i += 2; break;
        case 0x0e: i = this.decodePmAlarm('tvoc_alarm', 'tvoc', bytes, i, decoded, true); break;

        // ── Tamper / buzzer / occupancy ───────────────────────────────────────
        case 0x0f: decoded.tamper_status = bytes[i++] & 0xff; break;

        case 0x10: {
          const type = bytes[i++];
          decoded.tamper_status_alarm = decoded.tamper_status_alarm ?? {};
          decoded.tamper_status_alarm.type = type;
          // 0x20=normal, 0x21=trigger — no additional bytes
          break;
        }

        case 0x11: decoded.buzzer = bytes[i++] & 0xff; break;
        case 0x12: decoded.occupancy_status = bytes[i++] & 0xff; break;

        // ── TVOC raw data (float32 LE pairs) ─────────────────────────────────
        case 0x20: decoded.tvoc_raw_data_1 = { rmox_0: f32(bytes,i), rmox_1: f32(bytes,i+4) }; i+=8; break;
        case 0x21: decoded.tvoc_raw_data_2 = { rmox_2: f32(bytes,i), rmox_3: f32(bytes,i+4) }; i+=8; break;
        case 0x22: decoded.tvoc_raw_data_3 = { rmox_4: f32(bytes,i), rmox_5: f32(bytes,i+4) }; i+=8; break;
        case 0x23: decoded.tvoc_raw_data_4 = { rmox_6: f32(bytes,i), rmox_7: f32(bytes,i+4) }; i+=8; break;
        case 0x24: decoded.tvoc_raw_data_5 = { rmox_8: f32(bytes,i), rmox_9: f32(bytes,i+4) }; i+=8; break;
        case 0x25: decoded.tvoc_raw_data_6 = { rmox_10: f32(bytes,i), rmox_11: f32(bytes,i+4) }; i+=8; break;
        case 0x26: decoded.tvoc_raw_data_7 = { rmox_12: f32(bytes,i), zmod4510_rmox_3: f32(bytes,i+4) }; i+=8; break;
        case 0x27: decoded.tvoc_raw_data_8 = { log_rcda: f32(bytes,i), rhtr: f32(bytes,i+4) }; i+=8; break;
        case 0x28: decoded.tvoc_raw_data_9 = { temperature: f32(bytes,i), iaq: f32(bytes,i+4) }; i+=8; break;
        case 0x29: decoded.tvoc_raw_data_10 = { tvoc: f32(bytes,i), etoh: f32(bytes,i+4) }; i+=8; break;
        case 0x2a: decoded.tvoc_raw_data_11 = { eco2: f32(bytes,i), rel_iaq: f32(bytes,i+4) }; i+=8; break;

        case 0x2b: decoded.pm_sensor_working_time = u32(bytes, i); i += 4; break;

        // ── Settings (read back) ──────────────────────────────────────────────
        case 0x60: {
          decoded.reporting_interval = decoded.reporting_interval ?? {};
          const unit = bytes[i++];
          decoded.reporting_interval.unit = unit === 0 ? 'second' : 'min';
          if (unit === 0) {
            decoded.reporting_interval.seconds_of_time = u16(bytes, i);
          } else {
            decoded.reporting_interval.minutes_of_time = u16(bytes, i);
          }
          i += 2;
          break;
        }
        case 0x61: decoded.temperature_unit = bytes[i++] === 0 ? '°C' : '°F'; break;
        case 0x62: decoded.led_status = bytes[i++] & 0xff; break;
        case 0x63: decoded.buzzer_enable = bytes[i++] & 0xff; break;

        case 0x64: {
          decoded.buzzer_sleep = decoded.buzzer_sleep ?? {};
          const sleepType = bytes[i++];
          const key = sleepType === 1 ? 'item_1' : 'item_2';
          decoded.buzzer_sleep[key] = {
            enable:     bytes[i++] & 0xff,
            start_time: u16(bytes, i),
            end_time:   u16(bytes, i + 2),
          }; i += 4;
          break;
        }

        case 0x65: decoded.buzzer_button_stop_enable = bytes[i++] & 0xff; break;
        case 0x66: decoded.buzzer_silent_time = u16(bytes, i); i += 2; break;
        case 0x67: decoded.tamper_alarm_enable = bytes[i++] & 0xff; break;
        case 0x68: decoded.tvoc_raw_reporting_enable = bytes[i++] & 0xff; break;

        case 0x69: {
          decoded.temperature_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       round1(i16(bytes, i) / 10),
            threshold_max:       round1(i16(bytes, i + 2) / 10),
          }; i += 4; break;
        }

        case 0x6a: {
          decoded.pm1_0_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       i16(bytes, i),
            threshold_max:       i16(bytes, i + 2),
          }; i += 4; break;
        }
        case 0x6b: {
          decoded.pm2_5_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       i16(bytes, i),
            threshold_max:       i16(bytes, i + 2),
          }; i += 4; break;
        }
        case 0x6c: {
          decoded.pm10_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       i16(bytes, i),
            threshold_max:       i16(bytes, i + 2),
          }; i += 4; break;
        }
        case 0x6d: {
          decoded.tvoc_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       i16(bytes, i),
            threshold_max:       i16(bytes, i + 2),
          }; i += 4; break;
        }
        case 0x6e: {
          decoded.vaping_index_alarm_settings = {
            enable:              bytes[i++] & 0xff,
            threshold_condition: bytes[i++] & 0xff,
            threshold_min:       bytes[i++] & 0xff,
            threshold_max:       bytes[i++] & 0xff,
          }; break;
        }
        case 0x6f: decoded.alarm_reporting_times = u16(bytes, i); i += 2; break;
        case 0x70: decoded.alarm_deactivation_enable = bytes[i++] & 0xff; break;

        case 0x71: {
          decoded.temperature_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: round1(i16(bytes, i) / 10),
          }; i += 2; break;
        }
        case 0x72: {
          decoded.humidity_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: round1(i16(bytes, i) / 10),
          }; i += 2; break;
        }
        case 0x73: {
          decoded.pm1_0_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: i16(bytes, i),
          }; i += 2; break;
        }
        case 0x74: {
          decoded.pm2_5_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: i16(bytes, i),
          }; i += 2; break;
        }
        case 0x75: {
          decoded.pm10_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: i16(bytes, i),
          }; i += 2; break;
        }
        case 0x76: {
          decoded.tvoc_calibration_settings = {
            enable:            bytes[i++] & 0xff,
            calibration_value: i16(bytes, i),
          }; i += 2; break;
        }
        case 0x77: {
          const raw = bytes[i++] & 0xff;
          decoded.vaping_index_calibration_settings = {
            enable:            raw,
            calibration_value: bytes[i] > 0x7f ? bytes[i] - 0x100 : bytes[i],
          }; i++; break;
        }

        // ── Time settings ────────────────────────────────────────────────────
        case 0xc7:
          decoded.time_zone = TZ_MAP[i16(bytes, i)] ?? i16(bytes, i); i += 2; break;

        case 0xc6:
          decoded.daylight_saving_time = this.decodeDst(bytes, i);
          i += 11; break;

        case 0xc8: decoded.device_status = bytes[i++] === 1 ? 'on' : 'off'; break;
        case 0xc9: decoded.random_key = bytes[i++] & 0xff; break;

        // ── Service echo backs ────────────────────────────────────────────────
        case 0xbf: decoded.reset = 1; break;
        case 0xbe: decoded.reboot = 1; break;
        case 0xbd: decoded.clear_historical_data = 1; break;
        case 0xbc: decoded.stop_historical_data_retrieval = 1; break;
        case 0xbb: decoded.retrieve_historical_data_by_time = { time: u32(bytes, i) }; i += 4; break;
        case 0xba: decoded.retrieve_historical_data_by_time_range = {
          start_time: u32(bytes, i), end_time: u32(bytes, i + 4) }; i += 8; break;
        case 0xb9: decoded.query_device_status = 1; break;
        case 0xb8: decoded.synchronize_time = 1; break;
        case 0xb7: decoded.set_time = { timestamp: u32(bytes, i) }; i += 4; break;
        case 0xb6: decoded.reconnect = 1; break;
        case 0x5f: decoded.stop_buzzer_alarm = 1; break;
        case 0x5e: decoded.execute_tvoc_self_clean = 1; break;

        // ── EF check-order reply ──────────────────────────────────────────────
        case 0xfe: decoded.check_order_reply = { order: bytes[i++] & 0xff }; break;
        case 0xee: decoded.all_configurations_request_by_device = 1; break;

        default:
          // Unknown command — stop parsing to avoid runaway
          i = bytes.length; break;
      }
    }

    // Add celsius/fahrenheit aliases for temperature fields (matching processTemperature)
    if (typeof decoded.temperature === 'number') {
      decoded.celsius_temperature  = round1(decoded.temperature);
      decoded.fahrenheit_temperature = round1(decoded.temperature * 1.8 + 32);
    }

    return decoded as DecodedTelemetry;
  }

  // Decode PM/TVOC typed alarm — uint16 payload on 0x10/0x11, no payload on errors
  private decodePmAlarm(
    alarmKey: string, valueKey: string,
    b: number[], offset: number,
    decoded: any, isU16: boolean,
  ): number {
    const type = b[offset++];
    decoded[alarmKey] = decoded[alarmKey] ?? {};
    decoded[alarmKey].type = type;
    if (type === 0x10) {
      const v = isU16 ? u16(b, offset) : (i16(b, offset));
      decoded[alarmKey].alarm_deactivation = { [valueKey]: v };
      decoded[valueKey] = v;
      offset += 2;
    } else if (type === 0x11) {
      const v = isU16 ? u16(b, offset) : (i16(b, offset));
      decoded[alarmKey].alarm_trigger = { [valueKey]: v };
      decoded[valueKey] = v;
      offset += 2;
    }
    // 0x00/0x01/0x02 — no additional bytes
    return offset;
  }

  private decodeDst(b: number[], offset: number): any {
    const dst: any = {
      enable: b[offset] & 0xff,
      daylight_saving_time_offset: b[offset + 1] & 0xff,
      start_month: b[offset + 2] & 0xff,
      start_week_num: (b[offset + 3] >>> 4) & 0x0f,
      start_week_day:  b[offset + 3] & 0x0f,
      start_hour_min: u16(b, offset + 4),
      end_month: b[offset + 6] & 0xff,
      end_week_num: (b[offset + 7] >>> 4) & 0x0f,
      end_week_day:   b[offset + 7] & 0x0f,
      end_hour_min: u16(b, offset + 8),
    };
    return dst;
  }

  private decodeFirmwareVersion(b: number[]): string {
    let v = `v${b[0]}.${b[1]}`;
    if (b[2]) v += `-r${b[2]}`;
    if (b[3]) v += `-a${b[3]}`;
    if (b[4]) v += `-u${b[4]}`;
    if (b[5]) v += `-t${b[5]}`;
    return v;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      // ── Zero-payload service commands ───────────────────────────────────────
      case 'reset':                          bytes = [0xbf]; break;
      case 'reboot':                         bytes = [0xbe]; break;
      case 'clear_historical_data':          bytes = [0xbd]; break;
      case 'stop_historical_data_retrieval': bytes = [0xbc]; break;
      case 'query_device_status':            bytes = [0xb9]; break;
      case 'synchronize_time':               bytes = [0xb8]; break;
      case 'reconnect':                      bytes = [0xb6]; break;
      case 'stop_buzzer_alarm':              bytes = [0x5f]; break;
      case 'execute_tvoc_self_clean':        bytes = [0x5e]; break;

      // ── Timed service commands ───────────────────────────────────────────────
      case 'set_time':
        bytes = [0xb7, ...wu32(params.timestamp ?? 0)]; break;
      case 'retrieve_historical_data_by_time':
        bytes = [0xbb, ...wu32(params.time ?? 0)]; break;
      case 'retrieve_historical_data_by_time_range':
        bytes = [0xba, ...wu32(params.start_time ?? 0), ...wu32(params.end_time ?? 0)]; break;

      // ── Settings ────────────────────────────────────────────────────────────
      case 'set_reporting_interval': {
        const unit = params.unit === 'second' ? 0 : 1;
        const val = unit === 0 ? (params.seconds_of_time ?? 600) : (params.minutes_of_time ?? 10);
        bytes = [0x60, unit, ...wu16(val)]; break;
      }
      case 'set_temperature_unit':          bytes = [0x61, params.unit === '°F' ? 1 : 0]; break;
      case 'set_led_status':                bytes = [0x62, params.enable ? 1 : 0]; break;
      case 'set_buzzer_enable':             bytes = [0x63, params.enable ? 1 : 0]; break;
      case 'set_buzzer_button_stop_enable': bytes = [0x65, params.enable ? 1 : 0]; break;
      case 'set_buzzer_silent_time':        bytes = [0x66, ...wu16(params.minutes ?? 15)]; break;
      case 'set_tamper_alarm_enable':       bytes = [0x67, params.enable ? 1 : 0]; break;
      case 'set_tvoc_raw_reporting_enable': bytes = [0x68, params.enable ? 1 : 0]; break;
      case 'set_alarm_reporting_times':     bytes = [0x6f, ...wu16(params.times ?? 1)]; break;
      case 'set_alarm_deactivation_enable': bytes = [0x70, params.enable ? 1 : 0]; break;
      case 'set_random_key':                bytes = [0xc9, params.enable ? 1 : 0]; break;
      case 'set_lorawan_mode':              bytes = [0xcf, 0x00, params.mode ?? 0]; break;

      case 'set_buzzer_sleep_item': {
        const item = params.item === 2 ? 2 : 1;
        bytes = [0x64, item, params.enable ? 1 : 0, ...wu16(params.start_time ?? 0), ...wu16(params.end_time ?? 0)]; break;
      }

      case 'set_time_zone':
        bytes = [0xc7, ...wi16(params.minutes ?? 480)]; break;

      case 'set_daylight_saving_time': {
        const p = params;
        const startBits = ((p.start_week_num ?? 2) << 4) | (p.start_week_day ?? 7);
        const endBits   = ((p.end_week_num ?? 1) << 4)   | (p.end_week_day ?? 1);
        bytes = [
          0xc6,
          p.enable ? 1 : 0,
          p.daylight_saving_time_offset ?? 60,
          p.start_month ?? 3,
          startBits,
          ...wu16(p.start_hour_min ?? 0),
          p.end_month ?? 11,
          endBits,
          ...wu16(p.end_hour_min ?? 0),
        ]; break;
      }

      // ── Threshold alarm settings ────────────────────────────────────────────
      case 'set_temperature_alarm_settings': {
        const p = params;
        bytes = [
          0x69, p.enable ? 1 : 0, p.threshold_condition ?? 0,
          ...wi16(Math.round((p.threshold_min ?? 0) * 10)),
          ...wi16(Math.round((p.threshold_max ?? 0) * 10)),
        ]; break;
      }
      case 'set_pm1_0_alarm_settings': {
        const p = params;
        bytes = [0x6a, p.enable ? 1 : 0, p.threshold_condition ?? 0, ...wi16(p.threshold_min ?? 0), ...wi16(p.threshold_max ?? 0)]; break;
      }
      case 'set_pm2_5_alarm_settings': {
        const p = params;
        bytes = [0x6b, p.enable ? 1 : 0, p.threshold_condition ?? 0, ...wi16(p.threshold_min ?? 0), ...wi16(p.threshold_max ?? 0)]; break;
      }
      case 'set_pm10_alarm_settings': {
        const p = params;
        bytes = [0x6c, p.enable ? 1 : 0, p.threshold_condition ?? 0, ...wi16(p.threshold_min ?? 0), ...wi16(p.threshold_max ?? 0)]; break;
      }
      case 'set_tvoc_alarm_settings': {
        const p = params;
        bytes = [0x6d, p.enable ? 1 : 0, p.threshold_condition ?? 0, ...wi16(p.threshold_min ?? 0), ...wi16(p.threshold_max ?? 0)]; break;
      }
      case 'set_vaping_index_alarm_settings': {
        const p = params;
        bytes = [0x6e, p.enable ? 1 : 0, p.threshold_condition ?? 0, p.threshold_min ?? 0, p.threshold_max ?? 5]; break;
      }

      // ── Calibration ────────────────────────────────────────────────────────
      case 'set_temperature_calibration': {
        const p = params;
        bytes = [0x71, p.enable ? 1 : 0, ...wi16(Math.round((p.calibration_value ?? 0) * 10))]; break;
      }
      case 'set_humidity_calibration': {
        const p = params;
        bytes = [0x72, p.enable ? 1 : 0, ...wi16(Math.round((p.calibration_value ?? 0) * 10))]; break;
      }
      case 'set_pm1_0_calibration': {
        const p = params;
        bytes = [0x73, p.enable ? 1 : 0, ...wi16(p.calibration_value ?? 0)]; break;
      }
      case 'set_pm2_5_calibration': {
        const p = params;
        bytes = [0x74, p.enable ? 1 : 0, ...wi16(p.calibration_value ?? 0)]; break;
      }
      case 'set_pm10_calibration': {
        const p = params;
        bytes = [0x75, p.enable ? 1 : 0, ...wi16(p.calibration_value ?? 0)]; break;
      }
      case 'set_tvoc_calibration': {
        const p = params;
        bytes = [0x76, p.enable ? 1 : 0, ...wi16(p.calibration_value ?? 0)]; break;
      }
      case 'set_vaping_index_calibration': {
        const p = params;
        const cv = p.calibration_value ?? 0;
        bytes = [0x77, p.enable ? 1 : 0, cv < 0 ? cv + 0x100 : cv]; break;
      }

      default:
        throw new Error(`GS601: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // GS601 is identified by:
  //   0x01 — vaping_index (GS601-exclusive)
  //   0x0d — tvoc (GS601-exclusive among this codec family)
  //   0x03/0x05/0x07 — PM sensors (exclusive to GS601)
  //   0x0b — humidity (also in TS201/TS301, but combined with vaping makes it GS601)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0x01) return true;  // vaping_index — most distinctive
      if (b === 0x0d) return true;  // tvoc
      if (b === 0x03) return true;  // pm1_0
      if (b === 0x05) return true;  // pm2_5
      if (b === 0x07) return true;  // pm10
    }
    return false;
  }
}