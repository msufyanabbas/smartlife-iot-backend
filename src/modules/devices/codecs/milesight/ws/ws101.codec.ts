// src/modules/devices/codecs/milesight/ws101.codec.ts
/**
 * Milesight WS101 Codec
 * Smart Button / SOS Button
 *
 * Telemetry:
 *   - battery (%)
 *   - button_event: { status: 'short press' | 'long press' | 'double press', msgid: number }
 *
 * Downlink commands:
 *   - reboot
 *   - query_device_status
 *   - set_reporting_interval  (60–64800 s)
 *   - set_led_indicator       (enable/disable)
 *   - set_double_click        (enable/disable)
 *   - set_buzzer              (enable/disable)
 *
 * Based on official Milesight decoder v1.0.0
 * Reference payload: "017510 FF2E01" → { battery: 16, button_event: { status: "short press" } }
 */

import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightWS101Codec extends BaseDeviceCodec {
  readonly codecId: string = 'milesight-ws101';
  readonly manufacturer: string = 'Milesight';
  readonly supportedModels: string[] = ['WS101', 'WS101-SOS'];
  readonly protocol: 'lorawan' = 'lorawan';

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const channelId   = bytes[i++];
      const channelType = bytes[i++];

      // ── Attribute channels ────────────────────────────────────────────

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

      // SERIAL NUMBER (0xFF 0x08) — 6 bytes
      else if (channelId === 0xff && channelType === 0x08) {
        decoded.sn = bytes
          .slice(i, i + 6)
          .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2))
          .join('');
        i += 6;
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

      // ── Telemetry channels ────────────────────────────────────────────

      // BATTERY (0x01 0x75)
      else if (channelId === 0x01 && channelType === 0x75) {
        decoded.battery      = bytes[i];
        decoded.batteryLevel = bytes[i]; // standard field alias
        i += 1;
      }

      // BUTTON PRESS (0xFF 0x2E)
      else if (channelId === 0xff && channelType === 0x2e) {
        const pressMap: Record<number, string> = {
          1: 'short press',
          2: 'long press',
          3: 'double press',
        };
        decoded.button_event = {
          status: pressMap[bytes[i]] ?? 'unknown',
          // Random message ID mirrors the official decoder behaviour —
          // lets the frontend distinguish repeated identical press events.
          msgid: Math.floor(Math.random() * (999999 - 100000 + 1)) + 100000,
        };
        i += 1;
      }

      // ── Downlink response channels ────────────────────────────────────

      else if (channelId === 0xfe || channelId === 0xff) {
        const result = this.handleDownlinkResponse(channelType, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else {
        // Unknown channel — stop parsing to avoid garbage reads
        break;
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
      case 0x03: // Reporting interval ACK
        data.reporting_interval = (bytes[offset + 1] << 8) | bytes[offset];
        offset += 2;
        break;

      case 0x10: // Reboot ACK
        data.reboot = bytes[offset] === 1 ? 'yes' : 'no';
        offset += 1;
        break;

      case 0x28: // Query device status ACK
        data.query_device_status = bytes[offset] === 1 ? 'yes' : 'no';
        offset += 1;
        break;

      case 0x2f: // LED indicator ACK
        data.led_indicator_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x3e: // Buzzer ACK
        data.buzzer_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x74: // Double click ACK
        data.double_click_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      default:
        // Unknown downlink response — skip 1 byte and continue
        offset += 1;
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

      case 'query_device_status':
        bytes = [0xff, 0x28, 0xff];
        break;

      case 'set_reporting_interval': {
        const interval = command.params?.interval ?? 300;
        if (interval < 60 || interval > 64800) {
          throw new Error('reporting_interval must be between 60 and 64800 seconds');
        }
        bytes = [0xff, 0x03, interval & 0xff, (interval >> 8) & 0xff];
        break;
      }

      case 'set_led_indicator': {
        const enable = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x2f, enable];
        break;
      }

      case 'set_double_click': {
        const enable = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x74, enable];
        break;
      }

      case 'set_buzzer': {
        const enable = command.params?.enable ? 1 : 0;
        bytes = [0xff, 0x3e, enable];
        break;
      }

      default:
        throw new Error(`WS101: unsupported command "${command.type}"`);
    }

    return {
      fPort: 85,
      data: this.bytesToHex(bytes),
      confirmed: false,
    };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // WS101 payloads always start with either:
  //   0x01 0x75 (battery channel) or
  //   0xFF 0x2E (button press channel) or
  //   0xFF 0x01/0x09/0x0A/0xFF (version/attribute channels)
  //
  // We fingerprint on the battery + button press channels because they are
  // unique to WS101 and not shared with other Milesight sensors.

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    // Walk bytes looking for a WS101 signature channel
    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x01 && ty === 0x75) return true; // battery
      if (ch === 0xff && ty === 0x2e) return true; // button press

      // Skip common attribute channels to keep walking
      if (ch === 0xff && ty === 0x01) { i += 3; continue; }
      if (ch === 0xff && (ty === 0x09 || ty === 0x0a)) { i += 4; continue; }
      if (ch === 0xff && ty === 0xff) { i += 4; continue; }
      if (ch === 0xff && ty === 0x08) { i += 8; continue; }
      if (ch === 0xff && ty === 0x0f) { i += 3; continue; }
      if (ch === 0xff && (ty === 0xfe || ty === 0x0b)) { i += 3; continue; }

      break; // Unexpected channel — not a WS101 payload
    }

    return false;
  }
}