// src/modules/devices/codecs/milesight/ws156.codec.ts
// Milesight WS156 — LoRaWAN Smart Scene Panel (up to 6 scene buttons)
//
// ── Protocol summary ─────────────────────────────────────────────────────────
// Uplink telemetry:
//   0x01 0x75 — battery (uint8, %)
//   0xFF 0x34 — button press event (3B: id + d2d_lo + d2d_hi)
//               id (uint8): button number (1-6)
//               d2d (uint16 LE): D2D command value associated with the button
//               Output fields: button_<id>=1, button_<id>_d2d=<u16>, button_<id>_msgid=<random>
//
// ── Button press channel (0xFF 0x34) — 3 bytes ──────────────────────────────
//   [0]   button id (1-6)
//   [1:2] D2D command (uint16 LE)
//   Output: button_{id} = 1 (pressed)
//           button_{id}_d2d = D2D command value
//           button_{id}_msgid = random 6-digit int (deduplication key)
//   NOTE: The TSL has button press mode/event in the channel description
//         but the decoder only uses id + d2d. The encoder is a no-op (read-only device).
//
// ── No downlink commands ──────────────────────────────────────────────────────
//   WS156 is a read-only panel — the encoder produces no output.
//
// canDecode fingerprint: 0xFF 0x34 (button press) — unique to WS156

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

function u16(b: number[], i: number): number { return ((b[i + 1] << 8) | b[i]) & 0xffff; }

export class MilesightWS156Codec extends BaseDeviceCodec {
  readonly codecId: string         = 'milesight-ws156';
  readonly manufacturer    = 'Milesight';
  readonly supportedModels = ['WS156'];
  readonly protocol        = 'lorawan' as const;

  getCapabilities(): DeviceCapability {
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS156',
    description:  'Smart Scene Panel — up to 6 scene buttons with D2D command triggers (read-only)',
    telemetryKeys: [
      { key: 'battery',   label: 'Battery',   type: 'number' as const, unit: '%' },
      { key: 'button_1',  label: 'Button 1',  type: 'number' as const             },
      { key: 'button_2',  label: 'Button 2',  type: 'number' as const             },
      { key: 'button_3',  label: 'Button 3',  type: 'number' as const             },
      { key: 'button_4',  label: 'Button 4',  type: 'number' as const             },
      { key: 'button_5',  label: 'Button 5',  type: 'number' as const             },
      { key: 'button_6',  label: 'Button 6',  type: 'number' as const             },
    ],
    commands: [],  // WS156 is read-only
    uiComponents: [
      { type: 'gauge'  as const, label: 'Battery',  keys: ['battery']  },
      { type: 'status' as const, label: 'Button 1', keys: ['button_1'] },
      { type: 'status' as const, label: 'Button 2', keys: ['button_2'] },
      { type: 'status' as const, label: 'Button 3', keys: ['button_3'] },
    ],
  };
}

  // ── Decode ──────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: any = {};
    let i = 0;

    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attributes ────────────────────────────────────────────────────────
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

      // ── Battery ───────────────────────────────────────────────────────────
      else if (ch === 0x01 && ty === 0x75) { decoded.battery = bytes[i++] & 0xff; }

      // ── Button press (0xFF 0x34) — 3 bytes ───────────────────────────────
      // [0] id, [1:2] d2d command (uint16 LE)
      // Emits: button_{id}=1, button_{id}_d2d=<u16>, button_{id}_msgid=<random>
      else if (ch === 0xff && ty === 0x34) {
        const id   = bytes[i] & 0xff;
        const d2d  = u16(bytes, i + 1);
        const name = `button_${id}`;
        decoded[name]            = 1;
        decoded[`${name}_d2d`]   = d2d;
        decoded[`${name}_msgid`] = Math.floor(Math.random() * 900000) + 100000;
        i += 3;
      }

      else { break; }
    }

    return decoded as DecodedTelemetry;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────
  // WS156 is a read-only scene panel — no downlink commands defined.

  encode(_command: { type: string; params?: any }): EncodedCommand {
    throw new Error('WS156: no downlink commands supported (read-only device)');
  }

  // ── canDecode ─────────────────────────────────────────────────────────────────
  // WS156 uniquely identified by 0xFF 0x34 (button press channel).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0x34) return true;
    }
    return false;
  }
}

// ── WS136 — 3-button variant, identical protocol to WS156 ────────────────────
export class MilesightWS136Codec extends MilesightWS156Codec {
  override readonly codecId         = 'milesight-ws136';
  override readonly supportedModels = ['WS136'];
  getCapabilities(): DeviceCapability {
  return { ...super.getCapabilities(), codecId: this.codecId, model: 'WS136',
    description: 'Smart Scene Panel (3-button) — scene buttons with D2D command triggers (read-only)' };
}
}