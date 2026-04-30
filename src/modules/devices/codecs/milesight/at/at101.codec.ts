// src/modules/devices/codecs/milesight/at101.codec.ts
// Milesight AT101 — LoRaWAN Outdoor Asset Tracker
//
// Protocol: IPSO channel_id + channel_type
//
// ── Attributes (0xFF channel) ────────────────────────────────────────────────
//   0xFF 0x01 — ipso_version
//   0xFF 0x09 — hardware_version
//   0xFF 0x0A — firmware_version
//   0xFF 0xFF — tsl_version
//   0xFF 0x16 — sn (8B hex)
//   0xFF 0x0F — lorawan_class
//   0xFF 0xFE — reset_event
//   0xFF 0x0B — device_status
//
// ── Telemetry ────────────────────────────────────────────────────────────────
//   0x01 0x75 — battery (uint8, %)
//   0x03 0x67 — temperature (int16 LE /10, °C)
//   0x04 0x88 — location: latitude(i32/1M) + longitude(i32/1M) + status(1B)
//              status bits[3:0] = motion_status (0=unknown,1=start,2=moving,3=stop)
//              status bits[7:4] = geofence_status (0=inside,1=outside,2=unset,3=unknown)
//   0x84 0x88 — same as 0x04 0x88 (alarm variant)
//   0x05 0x00 — position (0=normal, 1=tilt)
//   0x06 0xD9 — wifi_scan: group(1B) + mac(6B) + rssi(int8) + motion_status(1B)
//              mac = "ff:ff:ff:ff:ff:ff" → wifi_scan_result = "timeout"
//   0x07 0x00 — tamper_status (0=install, 1=uninstall)
//   0x83 0x67 — temperature with alarm: int16 LE /10 + alarm_byte (0=normal,1=abnormal)
//   0x20 0xCE — history: timestamp(u32) + longitude(i32/1M) + latitude(i32/1M) (12B)
//
// ── Downlink responses (0xFF / 0xFE channel) ─────────────────────────────────
//   0xFF 0x10 — reboot echo
//   0xFF 0x13 — motion_report_config: enable(u8) + interval(u16)
//   0xFF 0x17 — time_zone (int16 LE, hour×10 units)
//   0xFF 0x28 — report_status echo
//   0xFF 0x2D — wifi_positioning_config: mode(u8) + num_of_bssid(u8) + timeout(u8)
//   0xFF 0x3B — time_sync_enable (0=disable, 2=enable)
//   0xFF 0x3C — gnss_positioning_timeout (uint8, minutes)
//   0xFF 0x4A — sync_time echo
//   0xFF 0x58 — motion/static detection config: type(u8) + delta_g(u8) + duration(u16)
//   0xFF 0x66 — report_strategy (0=periodic,1=motion,2=timing)
//   0xFF 0x71 — positioning_strategy (0=gnss,1=wifi,2=wifi_gnss)
//   0xFF 0x7E — geofence_alarm_config: enable(u8) + interval(u16) + counts(u8)
//   0xFF 0x87 — tamper_detection_enable
//   0xFF 0x88 — geofence_center_config latitude+longitude (i32/1M × 2)
//   0xFF 0x89 — geofence_center_config radius (uint32)
//   0xFF 0x8A — timed_report_config: index(u8, 0-indexed) + time(u16 min)
//   0xFF 0x8E — report/motion interval: type(u8) + value(u16 min)
//   0xFF 0x8F — bluetooth_enable
//
// ── Downlink commands ────────────────────────────────────────────────────────
//   0xFF 0x10 0xFF           — reboot
//   0xFF 0x28 0xFF           — report_status
//   0xFF 0x17 <i16>          — set_time_zone (hour×10, e.g. UTC+8 = 80)
//   0xFF 0x4A 0x00           — sync_time
//   0xFF 0x8E 0x00 <u16>     — set_report_interval (minutes, 1–1440)
//   0xFF 0x8E 0x01 <u16>     — set_motion_report_interval (minutes, 1–1440)
//   0xFF 0x66 <u8>           — set_report_strategy
//   0xFF 0x71 <u8>           — set_positioning_strategy
//   0xFF 0x3C <u8>           — set_gnss_positioning_timeout (minutes, 1–5)
//   0xFF 0x2D <mode> <bssid> <timeout> — set_wifi_positioning_config
//   0xFF 0x58 0x00 <dg> <u16> — set_motion_detection_config
//   0xFF 0x58 0x01 <dg> <u16> — set_static_detection_config
//   0xFF 0x13 <en> <u16>     — set_motion_report_config
//   0xFF 0x88 <i32> <i32>    — set_geofence_center (lat+lon, int32 /1M)
//   0xFF 0x89 <u32>          — set_geofence_radius (meters)
//   0xFF 0x87 <en>           — set_tamper_detection_enable
//   0xFF 0x7E <en> <u16> <u8> — set_geofence_alarm_config
//   0xFF 0x8A <idx> <u16>    — set_timed_report_config (index 0-indexed)
//   0xFF 0x8F <en>           — set_bluetooth_enable
//   0xFF 0x3B <en>           — set_time_sync_enable (0=disable, 2=enable)
//
// ── Key protocol notes ───────────────────────────────────────────────────────
//   - Timezone: hour×10 (e.g. UTC+8 = 80), same as TS101/GS101 — NOT minutes
//   - report_interval: MINUTES (not seconds)
//   - Location: channel 0x04 normal, 0x84 alarm variant — both same decode
//   - WiFi scan: timeout signalled by mac "ff:ff:ff:ff:ff:ff"
//   - History: longitude before latitude in the wire format (opposite of location)

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

// ── Helpers ──────────────────────────────────────────────────────────────────
function i16(b: number[], i: number): number {
  const u = ((b[i + 1] << 8) | b[i]) & 0xffff;
  return u > 0x7fff ? u - 0x10000 : u;
}
function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }
function i32(b: number[], i: number): number {
  const u = (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0);
  return u > 0x7fffffff ? u - 0x100000000 : u;
}
function u32(b: number[], i: number): number {
  return (((b[i + 3] << 24) | (b[i + 2] << 16) | (b[i + 1] << 8) | b[i]) >>> 0);
}
function wi16(v: number): number[] { const u = v < 0 ? v + 0x10000 : v; return [u & 0xff, (u >> 8) & 0xff]; }
function wu16(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff]; }
function wi32(v: number): number[] {
  const u = v < 0 ? v + 0x100000000 : v;
  return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff, (u >> 24) & 0xff];
}
function wu32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

// Timezone map (hour×10 units, same as TS101/GS101)
const TZ: Record<number, string> = {
  [-120]:'UTC-12', [-110]:'UTC-11', [-100]:'UTC-10', [-95]:'UTC-9:30',
  [-90]:'UTC-9',   [-80]:'UTC-8',   [-70]:'UTC-7',   [-60]:'UTC-6',
  [-50]:'UTC-5',   [-40]:'UTC-4',   [-35]:'UTC-3:30',[-30]:'UTC-3',
  [-20]:'UTC-2',   [-10]:'UTC-1',    [0]:'UTC',       [10]:'UTC+1',
   [20]:'UTC+2',   [30]:'UTC+3',   [35]:'UTC+3:30',  [40]:'UTC+4',
   [45]:'UTC+4:30',[50]:'UTC+5',   [55]:'UTC+5:30',  [57]:'UTC+5:45',
   [60]:'UTC+6',   [65]:'UTC+6:30', [70]:'UTC+7',    [80]:'UTC+8',
   [90]:'UTC+9',   [95]:'UTC+9:30',[100]:'UTC+10',  [105]:'UTC+10:30',
  [110]:'UTC+11', [120]:'UTC+12', [127]:'UTC+12:45',[130]:'UTC+13',
  [140]:'UTC+14',
};
function tzName(v: number): string { return TZ[v] ?? 'unknown'; }
function tzValue(name: string): number {
  for (const [k, n] of Object.entries(TZ)) if (n === name) return +k;
  return 80;
}

const MOTION_STATUS: Record<number, string> = { 0:'unknown', 1:'start', 2:'moving', 3:'stop' };
const GEOFENCE_STATUS: Record<number, string> = { 0:'inside', 1:'outside', 2:'unset', 3:'unknown' };

export class MilesightAT101Codec extends BaseDeviceCodec {
  readonly codecId         = 'milesight-at101';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['AT101'];
  readonly protocol        = 'lorawan' as const;
  readonly category        = 'Asset Tracking';
  readonly modelFamily     = 'AT101';
  readonly imageUrl        = 'https://github.com/Milesight-IoT/SensorDecoders/raw/main/at-series/at101/at101.png';

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ───────────────────────────────────────────────────────────
      if (ch === 0xff && ty === 0x01) {
        const b = bytes[i++]; decoded.ipso_version = `v${(b & 0xf0) >> 4}.${b & 0x0f}`;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`; i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`; i += 2;
      }
      else if (ch === 0xff && ty === 0xff) { decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`; i += 2; }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const cm: Record<number, string> = { 0:'Class A', 1:'Class B', 2:'Class C', 3:'Class CtoB' };
        decoded.lorawan_class = cm[bytes[i]] ?? 'unknown'; i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) { decoded.reset_event   = bytes[i] === 1 ? 'reset' : 'normal'; i += 1; }
      else if (ch === 0xff && ty === 0x0b) { decoded.device_status = bytes[i] === 1 ? 'on' : 'off'; i += 1; }

      // ── Battery ──────────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) { decoded.battery = bytes[i++] & 0xff; }

      // ── Temperature ───────────────────────────────────────────────────────────
      else if (ch === 0x03 && ty === 0x67) {
        decoded.temperature = Math.round(i16(bytes, i) / 10 * 10) / 10; i += 2;
      }

      // ── Location (0x04 normal, 0x84 alarm variant) ────────────────────────────
      else if ((ch === 0x04 || ch === 0x84) && ty === 0x88) {
        decoded.latitude  = i32(bytes, i) / 1000000;
        decoded.longitude = i32(bytes, i + 4) / 1000000;
        const status = bytes[i + 8];
        decoded.motion_status   = MOTION_STATUS[status & 0x0f] ?? 'unknown';
        decoded.geofence_status = GEOFENCE_STATUS[(status >> 4) & 0x0f] ?? 'unknown';
        i += 9;
      }

      // ── Device position ────────────────────────────────────────────────────────
      else if (ch === 0x05 && ty === 0x00) {
        decoded.position = bytes[i++] === 0 ? 'normal' : 'tilt';
      }

      // ── WiFi scan result ───────────────────────────────────────────────────────
      else if (ch === 0x06 && ty === 0xd9) {
        const group = bytes[i] & 0xff;
        const mac   = bytes.slice(i + 1, i + 7).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(':');
        const rssi  = bytes[i + 7] > 0x7f ? bytes[i + 7] - 0x100 : bytes[i + 7];
        const ms    = bytes[i + 8] & 0x0f;
        i += 9;

        if (mac === 'ff:ff:ff:ff:ff:ff') {
          decoded.wifi_scan_result = 'timeout';
          continue;
        }
        decoded.wifi_scan_result = 'finish';
        decoded.motion_status = MOTION_STATUS[ms] ?? 'unknown';
        decoded.wifi = decoded.wifi ?? [];
        decoded.wifi.push({ group, mac, rssi, motion_status: MOTION_STATUS[ms] ?? 'unknown' });
      }

      // ── Tamper status ─────────────────────────────────────────────────────────
      else if (ch === 0x07 && ty === 0x00) {
        decoded.tamper_status = bytes[i++] === 0 ? 'install' : 'uninstall';
      }

      // ── Temperature with alarm flag ───────────────────────────────────────────
      else if (ch === 0x83 && ty === 0x67) {
        decoded.temperature       = Math.round(i16(bytes, i) / 10 * 10) / 10;
        decoded.temperature_alarm = bytes[i + 2] === 0 ? 'normal' : 'abnormal';
        i += 3;
      }

      // ── Historical location data ──────────────────────────────────────────────
      else if (ch === 0x20 && ty === 0xce) {
        const entry = {
          timestamp: u32(bytes, i),
          longitude: i32(bytes, i + 4) / 1000000,
          latitude:  i32(bytes, i + 8) / 1000000,
        };
        i += 12;
        decoded.history = decoded.history ?? [];
        decoded.history.push(entry);
      }

      // ── Downlink response echoes (0xFF / 0xFE channel) ────────────────────────
      else if (ch === 0xff || ch === 0xfe) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  private handleDownlinkResponse(ty: number, b: number[], offset: number): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};
    switch (ty) {
      case 0x10: data.reboot = 'yes'; offset += 1; break;
      case 0x13:
        data.motion_report_config = {
          enable:   b[offset] === 1 ? 'enable' : 'disable',
          interval: u16(b, offset + 1),
        }; offset += 3; break;
      case 0x17: data.time_zone = tzName(i16(b, offset)); offset += 2; break;
      case 0x28: data.report_status = 'yes'; offset += 1; break;
      case 0x2d:
        data.wifi_positioning_config = {
          mode:          b[offset] === 1 ? 'high_accuracy' : 'low_power',
          num_of_bssid:  b[offset + 1] & 0xff,
          timeout:       b[offset + 2] & 0xff,
        }; offset += 3; break;
      case 0x3b: data.time_sync_enable = b[offset++] === 0 ? 'disable' : 'enable'; break;
      case 0x3c: data.gnss_positioning_timeout = b[offset++] & 0xff; break;
      case 0x4a: data.sync_time = 'yes'; offset += 1; break;
      case 0x58: {
        const type = b[offset];
        if (type === 0) {
          data.motion_detection_config = { delta_g: b[offset + 1], duration: u16(b, offset + 2) };
        } else {
          data.static_detection_config = { delta_g: b[offset + 1], duration: u16(b, offset + 2) };
        }
        offset += 4; break;
      }
      case 0x66:
        data.report_strategy = ['periodic','motion','timing'][b[offset]] ?? 'unknown'; offset += 1; break;
      case 0x71:
        data.positioning_strategy = ['gnss','wifi','wifi_gnss'][b[offset]] ?? 'unknown'; offset += 1; break;
      case 0x7e:
        data.geofence_alarm_config = {
          enable:   b[offset] === 1 ? 'enable' : 'disable',
          interval: u16(b, offset + 1),
          counts:   b[offset + 3] & 0xff,
        }; offset += 4; break;
      case 0x87: data.tamper_detection_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      case 0x88:
        data.geofence_center_config = data.geofence_center_config ?? {};
        data.geofence_center_config.latitude  = i32(b, offset) / 1000000;
        data.geofence_center_config.longitude = i32(b, offset + 4) / 1000000;
        offset += 8; break;
      case 0x89:
        data.geofence_center_config = data.geofence_center_config ?? {};
        data.geofence_center_config.radius = u32(b, offset);
        offset += 4; break;
      case 0x8a:
        data.timed_report_config = data.timed_report_config ?? [];
        data.timed_report_config.push({ index: (b[offset] & 0xff) + 1, time: u16(b, offset + 1) });
        offset += 3; break;
      case 0x8e: {
        const type = b[offset];
        const val  = u16(b, offset + 1);
        if (type === 0) data.report_interval        = val;
        else            data.motion_report_interval = val;
        offset += 3; break;
      }
      case 0x8f: data.bluetooth_enable = b[offset++] === 1 ? 'enable' : 'disable'; break;
      default: offset += 1; break;
    }
    return { data, offset };
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;
    let bytes: number[] = [];

    switch (type) {
      case 'reboot':        bytes = [0xff, 0x10, 0xff]; break;
      case 'report_status': bytes = [0xff, 0x28, 0xff]; break;
      case 'sync_time':     bytes = [0xff, 0x4a, 0x00]; break;

      case 'set_time_zone':
        bytes = [0xff, 0x17, ...wi16(tzValue(params.time_zone ?? 'UTC+8'))]; break;

      case 'set_report_interval':
        bytes = [0xff, 0x8e, 0x00, ...wu16(params.report_interval ?? 20)]; break;

      case 'set_motion_report_interval':
        bytes = [0xff, 0x8e, 0x01, ...wu16(params.motion_report_interval ?? 20)]; break;

      case 'set_report_strategy':
        bytes = [0xff, 0x66,
          params.report_strategy === 'motion' ? 1 : params.report_strategy === 'timing' ? 2 : 0]; break;

      case 'set_positioning_strategy':
        bytes = [0xff, 0x71,
          params.positioning_strategy === 'wifi' ? 1 : params.positioning_strategy === 'wifi_gnss' ? 2 : 0]; break;

      case 'set_gnss_positioning_timeout':
        bytes = [0xff, 0x3c, params.gnss_positioning_timeout ?? 1]; break;

      case 'set_wifi_positioning_config': {
        const p = params;
        bytes = [0xff, 0x2d, p.mode === 'high_accuracy' ? 1 : 0, p.num_of_bssid ?? 10, p.timeout ?? 2]; break;
      }

      case 'set_motion_detection_config': {
        const p = params;
        bytes = [0xff, 0x58, 0x00, p.delta_g ?? 1, ...wu16(p.duration ?? 60)]; break;
      }

      case 'set_static_detection_config': {
        const p = params;
        bytes = [0xff, 0x58, 0x01, p.delta_g ?? 1, ...wu16(p.duration ?? 600)]; break;
      }

      case 'set_motion_report_config': {
        const p = params;
        bytes = [0xff, 0x13, p.enable === 'enable' ? 1 : 0, ...wu16(p.interval ?? 20)]; break;
      }

      case 'set_geofence_center': {
        const p = params;
        const latBytes = wi32(Math.round((p.latitude ?? 0) * 1000000));
        const lonBytes = wi32(Math.round((p.longitude ?? 0) * 1000000));
        bytes = [0xff, 0x88, ...latBytes, ...lonBytes]; break;
      }

      case 'set_geofence_radius':
        bytes = [0xff, 0x89, ...wu32(params.radius ?? 10)]; break;

      case 'set_tamper_detection_enable':
        bytes = [0xff, 0x87, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_geofence_alarm_config': {
        const p = params;
        bytes = [0xff, 0x7e, p.enable === 'enable' ? 1 : 0, ...wu16(p.interval ?? 20), p.counts ?? 1]; break;
      }

      case 'set_timed_report_config': {
        const p = params;
        bytes = [0xff, 0x8a, (p.index ?? 1) - 1, ...wu16(p.time ?? 60)]; break;
      }

      case 'set_bluetooth_enable':
        bytes = [0xff, 0x8f, params.enable === 'enable' ? 1 : 0]; break;

      case 'set_time_sync_enable':
        // Special: 0=disable, 2=enable (not 1!)
        bytes = [0xff, 0x3b, params.enable === 'enable' ? 2 : 0]; break;

      default:
        throw new Error(`AT101: unsupported command "${type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // AT101 is uniquely identified by:
  //   0x04 0x88 or 0x84 0x88 — GNSS location (AT101-exclusive channel+type combo)
  //   0x06 0xD9               — WiFi scan with MAC (AT101-exclusive)
  //   0x20 0xCE               — historical GPS data
  //   0x05 0x00               — device position (tilt sensor)

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      const ch = bytes[i]; const ty = bytes[i + 1];
      if ((ch === 0x04 || ch === 0x84) && ty === 0x88) return true; // GNSS location
      if (ch === 0x06 && ty === 0xd9) return true;                   // WiFi scan
      if (ch === 0x20 && ty === 0xce) return true;                   // history
      if (ch === 0x05 && ty === 0x00) return true;                   // position
    }
    return false;
  }
}