// src/modules/devices/codecs/milesight/am102.codec.ts
/**
 * Milesight AM102 Codec
 * Ambience Monitoring Sensor (Temperature + Humidity)
 *
 * Telemetry:
 *   - battery (%)
 *   - temperature (°C, int16/10)
 *   - humidity (%, uint8/2)
 *   - history[] — timestamped historical records
 *   - sensor_enable: { temperature, humidity }
 *
 * Downlink commands:
 *   - reboot
 *   - set_report_interval        (seconds)
 *   - set_time_zone              (UTC offset in minutes × 10, e.g. UTC+3 → 30)
 *   - set_timestamp              (Unix epoch seconds)
 *   - set_time_sync_enable       (enable/disable)
 *   - set_screen_display         (enable/disable)
 *   - set_screen_display_time    (enable/disable)
 *   - set_screen_intelligent     (enable/disable)
 *   - set_screen_last_refresh    (minutes, 2–1080)
 *   - set_screen_refresh         (seconds, 1–65535)
 *   - set_led_indicator_mode     (off/blink)
 *   - set_temperature_alarm      ({ condition, threshold_min, threshold_max })
 *   - set_hibernate              ({ enable, lora_uplink_enable, start_time, end_time, weekdays })
 *   - reset_battery
 *   - set_retransmit_enable      (enable/disable)
 *   - set_retransmit_interval    (seconds, 1–64800)
 *   - set_resend_interval        (seconds, 1–64800)
 *   - set_history_enable         (enable/disable)
 *   - fetch_history              ({ start_time, end_time? })
 *   - stop_transmit
 *   - clear_history
 *
 * Reference payload: "017564 03671801 04686D"
 *   → { battery: 100, temperature: 28.0, humidity: 54.5 }
 *
 * Based on official Milesight decoder/encoder v1.0.0
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../interfaces/base-codec.interface';

// ── Time zone map (offset-in-tenths-of-hours → label) ─────────────────────
const TIMEZONE_MAP: Record<number, string> = {
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

export class MilesightAM102Codec extends BaseDeviceCodec {
  readonly codecId: string        = 'milesight-am102';
  readonly manufacturer: string   = 'Milesight';
  readonly supportedModels: string[] = ['AM102', 'AM102A', 'AM102L'];
  readonly protocol = 'lorawan' as const;

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const channelId   = bytes[i++];
      const channelType = bytes[i++];

      // ── Attribute channels ──────────────────────────────────────────────

      // IPSO VERSION (0xFF 0x01)
      if (channelId === 0xff && channelType === 0x01) {
        const major = (bytes[i] & 0xf0) >> 4;
        const minor =  bytes[i] & 0x0f;
        decoded.ipso_version = `v${major}.${minor}`;
        i += 1;
      }

      // HARDWARE VERSION (0xFF 0x09)
      else if (channelId === 0xff && channelType === 0x09) {
        const major = (bytes[i]     & 0xff).toString(16);
        const minor = (bytes[i + 1] & 0xff) >> 4;
        decoded.hardware_version = `v${major}.${minor}`;
        i += 2;
      }

      // FIRMWARE VERSION (0xFF 0x0A)
      else if (channelId === 0xff && channelType === 0x0a) {
        const major = (bytes[i]     & 0xff).toString(16);
        const minor = (bytes[i + 1] & 0xff).toString(16);
        decoded.firmware_version = `v${major}.${minor}`;
        i += 2;
      }

      // TSL VERSION (0xFF 0xFF)
      else if (channelId === 0xff && channelType === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }

      // SERIAL NUMBER (0xFF 0x16) — 8 bytes (AM102 uses 0x16, not 0x08)
      else if (channelId === 0xff && channelType === 0x16) {
        decoded.sn = bytes
          .slice(i, i + 8)
          .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2))
          .join('');
        i += 8;
      }

      // LORAWAN CLASS (0xFF 0x0F)
      else if (channelId === 0xff && channelType === 0x0f) {
        const classMap: Record<number, string> = {
          0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB',
        };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }

      // RESET EVENT (0xFF 0xFE)
      else if (channelId === 0xff && channelType === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }

      // DEVICE STATUS (0xFF 0x0B)
      else if (channelId === 0xff && channelType === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.battery      = bytes[i] & 0xff;
        decoded.batteryLevel = decoded.battery; // standard field alias
        i += 1;
      }

      // TEMPERATURE (0x03 0x67) — int16 LE / 10 = °C
      else if (channelId === 0x03 && channelType === 0x67) {
        const raw = (bytes[i + 1] << 8) | bytes[i];
        const signed = raw > 0x7fff ? raw - 0x10000 : raw;
        decoded.temperature = signed / 10;
        i += 2;
      }

      // HUMIDITY (0x04 0x68) — uint8 / 2 = %rH
      else if (channelId === 0x04 && channelType === 0x68) {
        decoded.humidity = (bytes[i] & 0xff) / 2;
        i += 1;
      }

      // HISTORY DATA (0x20 0xCE) — 7 bytes per record
      // timestamp(4B LE) + temperature(2B int16 LE /10) + humidity(1B /2)
      else if (channelId === 0x20 && channelType === 0xce) {
        const ts = ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) |
                    (bytes[i + 1] << 8)  |  bytes[i]) >>> 0;
        const rawTemp = (bytes[i + 5] << 8) | bytes[i + 4];
        const signedTemp = rawTemp > 0x7fff ? rawTemp - 0x10000 : rawTemp;

        if (!decoded.history) decoded.history = [];
        (decoded.history as any[]).push({
          timestamp:   ts,
          temperature: signedTemp / 10,
          humidity:    (bytes[i + 6] & 0xff) / 2,
        });
        i += 7;
      }

      // SENSOR ENABLE (0xFF 0x18) — skip 1 byte, read bitfield
      else if (channelId === 0xff && channelType === 0x18) {
        const data = bytes[i + 1] & 0xff;
        decoded.sensor_enable = {
          temperature: (data >> 0) & 0x01 ? 'enable' : 'disable',
          humidity:    (data >> 1) & 0x01 ? 'enable' : 'disable',
        };
        i += 2;
      }

      // ── Downlink response channels ──────────────────────────────────────

      else if (channelId === 0xfe || channelId === 0xff) {
        const result = this.handleDownlinkResponse(channelType, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else {
        break; // Unknown channel — stop to avoid garbage reads
      }
    }

    return decoded;
  }

  // ── Downlink response handler ─────────────────────────────────────────────

  private handleDownlinkResponse(
    channelType: number,
    bytes: number[],
    offset: number,
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (channelType) {
      case 0x03: // Report interval ACK
        data.report_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x06: { // Temperature alarm config ACK
        const condition = bytes[offset] & 0x07;
        const condMap: Record<number, string> = { 0: 'disable', 1: 'below', 2: 'above', 3: 'between', 4: 'outside' };
        const rawMin = (bytes[offset + 2] << 8) | bytes[offset + 1];
        const rawMax = (bytes[offset + 4] << 8) | bytes[offset + 3];
        data.temperature_alarm_config = {
          condition:     condMap[condition] ?? 'unknown',
          threshold_min: (rawMin > 0x7fff ? rawMin - 0x10000 : rawMin) / 10,
          threshold_max: (rawMax > 0x7fff ? rawMax - 0x10000 : rawMax) / 10,
        };
        offset += 9; // 1 condition + 2 min + 2 max + 4 reserved
        break;
      }

      case 0x10: // Reboot ACK
        data.reboot = 'yes';
        offset += 1;
        break;

      case 0x11: // Timestamp ACK
        data.timestamp = ((bytes[offset + 3] << 24) | (bytes[offset + 2] << 16) |
                          (bytes[offset + 1] << 8)  |  bytes[offset]) >>> 0;
        offset += 4;
        break;

      case 0x17: { // Time zone ACK
        const raw = (bytes[offset + 1] << 8) | bytes[offset];
        const tz = raw > 0x7fff ? raw - 0x10000 : raw;
        data.time_zone = TIMEZONE_MAP[String(tz)] ?? `UTC offset ${tz}`;
        offset += 2;
        break;
      }

      case 0x27: // Clear history ACK
        data.clear_history = 'yes';
        offset += 1;
        break;

      case 0x2d: // Screen display enable ACK
        data.screen_display_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x2f: // LED indicator mode ACK
        data.led_indicator_mode = bytes[offset] === 2 ? 'blink' : 'off';
        offset += 1;
        break;

      case 0x3a: { // Report schedule config ACK
        const num = bytes[offset] & 0xff;
        offset += 1;
        data.report_schedule_config = [];
        for (let i = 0; i < num; i++) {
          data.report_schedule_config.push({
            start_time:          (bytes[offset]     & 0xff) / 10,
            end_time:            (bytes[offset + 1] & 0xff) / 10,
            report_interval:     ((bytes[offset + 3] << 8) | bytes[offset + 2]) & 0xffff,
            collection_interval:  bytes[offset + 5] & 0xff,
          });
          offset += 6;
        }
        break;
      }

      case 0x3b: // Time sync enable ACK
        data.time_sync_enable = bytes[offset] === 2 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x56: // Screen intelligent enable ACK
        data.screen_intelligent_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x57: // Clear report schedule ACK
        data.clear_report_schedule = 'yes';
        offset += 1;
        break;

      case 0x59: // Reset battery ACK
        data.reset_battery = 'yes';
        offset += 1;
        break;

      case 0x5a: // Screen refresh interval ACK
        data.screen_refresh_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x68: // History enable ACK
        data.history_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x69: // Retransmit enable ACK
        data.retransmit_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x6a: { // Retransmit / resend interval ACK
        const intervalType = bytes[offset] & 0xff;
        const intervalVal  = ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff;
        if (intervalType === 0) data.retransmit_interval = intervalVal;
        else                    data.resend_interval     = intervalVal;
        offset += 3;
        break;
      }

      case 0x75: { // Hibernate config ACK
        const weekdayBits = bytes[offset + 6] & 0xff;
        const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        const weekdays: Record<string, string> = {};
        days.forEach((d, idx) => {
          weekdays[d] = (weekdayBits >> (idx + 1)) & 0x01 ? 'enable' : 'disable';
        });
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

      case 0x85: // Screen display time enable ACK
        data.screen_display_time_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x86: // Screen last refresh interval ACK
        data.screen_last_refresh_interval = bytes[offset] & 0xff;
        offset += 1;
        break;

      default:
        offset += 1; // Unknown — skip
        break;
    }

    return { data, offset };
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];

    switch (command.type) {

      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'set_report_interval': {
        const v = command.params?.interval ?? 300;
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_time_zone': {
        // offset in "tenths-of-hours" matching the TIMEZONE_MAP keys
        // e.g. UTC+3 → pass 30; the encoder writes it as int16 LE
        const tz = command.params?.offset ?? 0;
        const v  = tz < 0 ? tz + 0x10000 : tz;
        bytes = [0xff, 0x17, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_timestamp': {
        const ts = command.params?.timestamp ?? Math.floor(Date.now() / 1000);
        bytes = [
          0xff, 0x11,
          ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >> 24) & 0xff,
        ];
        break;
      }

      case 'set_time_sync_enable': {
        // enable → 2, disable → 0  (Milesight quirk)
        const v = command.params?.enable ? 2 : 0;
        bytes = [0xff, 0x3b, v];
        break;
      }

      case 'set_screen_display': {
        const v = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x2d, v];
        break;
      }

      case 'set_screen_display_time': {
        const v = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x85, v];
        break;
      }

      case 'set_screen_intelligent': {
        const v = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x56, v];
        break;
      }

      case 'set_screen_last_refresh': {
        const v = command.params?.minutes ?? 5;
        if (v < 2 || v > 1080) throw new Error('screen_last_refresh_interval must be 2–1080 min');
        bytes = [0xff, 0x86, v & 0xff];
        break;
      }

      case 'set_screen_refresh': {
        const v = command.params?.seconds ?? 10;
        if (v < 1 || v > 65535) throw new Error('screen_refresh_interval must be 1–65535 s');
        bytes = [0xff, 0x5a, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_led_indicator_mode': {
        // 'blink' → 2, 'off' → 0
        const v = command.params?.mode === 'blink' ? 2 : 0;
        bytes = [0xff, 0x2f, v];
        break;
      }

      case 'set_temperature_alarm': {
        const condMap: Record<string, number> = {
          disable: 0, below: 1, above: 2, between: 3, outside: 4,
        };
        const cond      = condMap[command.params?.condition ?? 'disable'] ?? 0;
        const data      = cond | (1 << 3); // bit3 = temperature alarm
        const minRaw    = Math.round((command.params?.threshold_min ?? 0) * 10);
        const maxRaw    = Math.round((command.params?.threshold_max ?? 40) * 10);
        const minLE     = minRaw < 0 ? minRaw + 0x10000 : minRaw;
        const maxLE     = maxRaw < 0 ? maxRaw + 0x10000 : maxRaw;
        bytes = [
          0xff, 0x06, data,
          minLE & 0xff, (minLE >> 8) & 0xff,
          maxLE & 0xff, (maxLE >> 8) & 0xff,
          0x00, 0x00, 0x00, 0x00, // 4 reserved bytes
        ];
        break;
      }

      case 'set_hibernate': {
        const p       = command.params ?? {};
        const enable  = p.enable  ? 1 : 0;
        const loraEn  = p.lora_uplink_enable ? 1 : 0;
        const start   = p.start_time ?? 0;
        const end     = p.end_time   ?? 0;
        const days    = p.weekdays   ?? {};
        const dayMap  = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
        let dayByte   = 0;
        dayMap.forEach((d, idx) => {
          if (days[d]) dayByte |= 1 << (idx + 1);
        });
        bytes = [
          0xff, 0x75, enable, loraEn,
          start & 0xff, (start >> 8) & 0xff,
          end   & 0xff, (end   >> 8) & 0xff,
          dayByte,
        ];
        break;
      }

      case 'reset_battery':
        bytes = [0xff, 0x59, 0xff];
        break;

      case 'set_retransmit_enable': {
        const v = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x69, v];
        break;
      }

      case 'set_retransmit_interval': {
        const v = command.params?.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('retransmit_interval must be 1–64800 s');
        bytes = [0xff, 0x6a, 0x00, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_resend_interval': {
        const v = command.params?.seconds ?? 600;
        if (v < 1 || v > 64800) throw new Error('resend_interval must be 1–64800 s');
        bytes = [0xff, 0x6a, 0x01, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'set_history_enable': {
        const v = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x68, v];
        break;
      }

      case 'fetch_history': {
        const start = command.params?.start_time ?? 0;
        const end   = command.params?.end_time;
        if (end !== undefined) {
          bytes = [
            0xfd, 0x6c,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
            end   & 0xff, (end   >> 8) & 0xff, (end   >> 16) & 0xff, (end   >> 24) & 0xff,
          ];
        } else {
          bytes = [
            0xfd, 0x6b,
            start & 0xff, (start >> 8) & 0xff, (start >> 16) & 0xff, (start >> 24) & 0xff,
          ];
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
        throw new Error(`AM102: unsupported command "${command.type}"`);
    }

    return {
      fPort: 85,
      data: this.bytesToHex(bytes),
      confirmed: false,
    };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // AM102 payloads always contain temperature (0x03 0x67) and/or
  // humidity (0x04 0x68) channels, which are the unique fingerprint
  // for this device family.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x03 && ty === 0x67) return true; // temperature
      if (ch === 0x04 && ty === 0x68) return true; // humidity
      if (ch === 0x20 && ty === 0xce) return true; // history record

      // Skip known attribute/telemetry channels to keep walking
      if (ch === 0x01 && ty === 0x75) { i += 3; continue; } // battery
      if (ch === 0xff && ty === 0x01) { i += 3; continue; } // IPSO
      if (ch === 0xff && (ty === 0x09 || ty === 0x0a)) { i += 4; continue; }
      if (ch === 0xff && ty === 0xff) { i += 4; continue; }
      if (ch === 0xff && ty === 0x16) { i += 10; continue; } // SN 8B
      if (ch === 0xff && ty === 0x0f) { i += 3; continue; }
      if (ch === 0xff && (ty === 0xfe || ty === 0x0b)) { i += 3; continue; }

      break;
    }

    return false;
  }
}