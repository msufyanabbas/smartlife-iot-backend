// src/modules/devices/codecs/milesight/ws558.codec.ts
/**
 * Milesight WS558 Codec
 * Smart Light Controller — 8 switches + voltage/power/current metering
 *
 * Telemetry channels:
 *   - switch_1 … switch_8  ('on' | 'off')
 *   - voltage               (V,   uint16/10)
 *   - active_power          (W,   uint32)
 *   - power_factor          (%,   uint8)
 *   - power_consumption     (Wh,  uint32)
 *   - total_current         (mA,  uint16)
 *
 * Switch channel 0x08 0x31 — 2 bytes:
 *   byte[0] = change bitmask  (which switches changed)
 *   byte[1] = state bitmask   (current state of all switches, bit0=sw1)
 *
 * Reference payload: "08310001 058164 07C90200 0374B208 068301000000 048001000000"
 *   → { switch_1:"on", switch_2-8:"off", voltage:222.6, active_power:1,
 *        power_factor:100, total_current:2, power_consumption:1 }
 *
 * Based on official Milesight WS558 decoder/encoder v1.0.0
 */

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  BaseDeviceCodec,
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';

export class MilesightWS558Codec extends BaseDeviceCodec {
  readonly codecId: string          = 'milesight-ws558';
  readonly manufacturer: string     = 'Milesight';
  readonly supportedModels: string[] = ['WS558'];
  readonly protocol = 'lorawan' as const;
  readonly description     = 'Smart Light Controller — 8 independent switches with power metering';

  getCapabilities(): DeviceCapability {
  const switches = Array.from({ length: 8 }, (_, i) => i + 1);
  const switchOptions = [
    { label: 'On',  value: 'on'  },
    { label: 'Off', value: 'off' },
  ];
 
  return {
    codecId:      this.codecId,
    manufacturer: this.manufacturer,
    model:        'WS558',
    description:  'Smart Light Controller — 8 independent switches with power metering',
    telemetryKeys: [
      ...switches.map(n => ({
        key:   `switch_${n}`,
        label: `Switch ${n}`,
        type:  'string' as const,
        enum:  ['on', 'off'],
      })),
      { key: 'voltage',           label: 'Voltage',           type: 'number' as const, unit: 'V'  },
      { key: 'active_power',      label: 'Active Power',      type: 'number' as const, unit: 'W'  },
      { key: 'power_factor',      label: 'Power Factor',      type: 'number' as const, unit: '%'  },
      { key: 'power_consumption', label: 'Power Consumption', type: 'number' as const, unit: 'Wh' },
      { key: 'total_current',     label: 'Total Current',     type: 'number' as const, unit: 'mA' },
    ],
    commands: [
      {
        type:        'control_switch',
        label:       'Control Switch',
        description: 'Turn one or more switches on or off',
        params: switches.map(n => ({
          key:      `switch_${n}`,
          label:    `Switch ${n}`,
          type:     'select' as const,
          required: false,
          options:  switchOptions,
        })),
      },
      {
        type:        'control_switch_with_delay',
        label:       'Control Switch with Delay',
        description: 'Turn switches on/off after a delay',
        params: [
          { key: 'task_id',    label: 'Task ID',         type: 'number' as const, required: false, default: 1, min: 1 },
          { key: 'delay_time', label: 'Delay (seconds)', type: 'number' as const, required: false, default: 0, min: 0 },
          ...switches.map(n => ({
            key:      `switch_${n}`,
            label:    `Switch ${n}`,
            type:     'select' as const,
            required: false,
            options:  switchOptions,
          })),
        ],
      },
      {
        type:   'set_report_interval',
        label:  'Set Report Interval',
        params: [{ key: 'interval', label: 'Interval (seconds)', type: 'number' as const, required: true, default: 300, min: 60, max: 86400 }],
      },
      { type: 'reboot', label: 'Reboot Device', params: [] },
    ],
    uiComponents: [
      ...switches.map(n => ({
        type:    'toggle' as const,
        label:   `Switch ${n}`,
        keys:    [`switch_${n}`],
        command: 'control_switch',
      })),
      { type: 'value' as const, label: 'Voltage',           keys: ['voltage'],           unit: 'V'  },
      { type: 'value' as const, label: 'Active Power',      keys: ['active_power'],      unit: 'W'  },
      { type: 'gauge' as const, label: 'Power Factor',      keys: ['power_factor'],      unit: '%'  },
      { type: 'value' as const, label: 'Power Consumption', keys: ['power_consumption'], unit: 'Wh' },
      { type: 'value' as const, label: 'Total Current',     keys: ['total_current'],     unit: 'mA' },
    ],
  };
}

  // ── Decode ────────────────────────────────────────────────────────────────

  decode(payload: string | Buffer, _fPort?: number): DecodedTelemetry {
    const bytes   = this.normalizePayload(payload);
    const decoded: DecodedTelemetry = {};

    let i = 0;
    while (i < bytes.length) {
      const ch = bytes[i++];
      const ty = bytes[i++];

      // ── Attribute channels ──────────────────────────────────────────────

      if (ch === 0xff && ty === 0x01) {
        decoded.ipso_version = `v${(bytes[i] & 0xf0) >> 4}.${bytes[i] & 0x0f}`;
        i += 1;
      }
      else if (ch === 0xff && ty === 0x09) {
        decoded.hardware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff) >> 4}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x0a) {
        decoded.firmware_version = `v${(bytes[i] & 0xff).toString(16)}.${(bytes[i + 1] & 0xff).toString(16)}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0xff) {
        decoded.tsl_version = `v${bytes[i]}.${bytes[i + 1]}`;
        i += 2;
      }
      else if (ch === 0xff && ty === 0x16) {
        decoded.sn = bytes.slice(i, i + 8).map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
        i += 8;
      }
      else if (ch === 0xff && ty === 0x0f) {
        const classMap: Record<number, string> = { 0: 'Class A', 1: 'Class B', 2: 'Class C', 3: 'Class CtoB' };
        decoded.lorawan_class = classMap[bytes[i]] ?? 'unknown';
        i += 1;
      }
      else if (ch === 0xff && ty === 0xfe) {
        decoded.reset_event = bytes[i] === 1 ? 'reset' : 'normal';
        i += 1;
      }
      else if (ch === 0xff && ty === 0x0b) {
        decoded.device_status = bytes[i] === 1 ? 'on' : 'off';
        i += 1;
      }

      // ── Telemetry channels ──────────────────────────────────────────────

      // SWITCH STATUS (0x08 0x31) — 2 bytes: [change_mask, state_mask]
      // change_mask: which switches changed (we don't need this for state)
      // state_mask:  bit0=switch_1, bit1=switch_2, … bit7=switch_8
      else if (ch === 0x08 && ty === 0x31) {
        /* const changeMask = bytes[i]; */ // which switches changed — unused
        const stateMask  = bytes[i + 1];
        for (let idx = 0; idx < 8; idx++) {
          const key = `switch_${idx + 1}`;
          decoded[key] = (stateMask >> idx) & 0x01 ? 'on' : 'off';
        }
        i += 2;
      }

      // VOLTAGE (0x03 0x74) — uint16 LE / 10 = V
      else if (ch === 0x03 && ty === 0x74) {
        decoded.voltage = (((bytes[i + 1] << 8) | bytes[i]) & 0xffff) / 10;
        i += 2;
      }

      // ACTIVE POWER (0x04 0x80) — uint32 LE, W
      else if (ch === 0x04 && ty === 0x80) {
        decoded.active_power = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // POWER FACTOR (0x05 0x81) — uint8, %
      else if (ch === 0x05 && ty === 0x81) {
        decoded.power_factor = bytes[i] & 0xff;
        i += 1;
      }

      // POWER CONSUMPTION (0x06 0x83) — uint32 LE, Wh
      else if (ch === 0x06 && ty === 0x83) {
        decoded.power_consumption = (((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0);
        i += 4;
      }

      // TOTAL CURRENT (0x07 0xC9) — uint16 LE, mA
      else if (ch === 0x07 && ty === 0xc9) {
        decoded.total_current = ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
        i += 2;
      }

      // POWER CONSUMPTION ENABLE response (0xFF 0x26)
      else if (ch === 0xff && ty === 0x26) {
        decoded.power_consumption_enable = bytes[i] === 1 ? 'enable' : 'disable';
        i += 1;
      }

      // DOWNLINK RESPONSE
      else if (ch === 0xfe || ch === 0xff) {
        const result = this.handleDownlinkResponse(ty, bytes, i);
        Object.assign(decoded, result.data);
        i = result.offset;
      }

      else { break; }
    }

    return decoded;
  }

  // ── Downlink response handler ─────────────────────────────────────────────

  private handleDownlinkResponse(
    ty: number,
    bytes: number[],
    offset: number,
  ): { data: Record<string, any>; offset: number } {
    const data: Record<string, any> = {};

    switch (ty) {
      case 0x10:
        data.reboot = 'yes';
        offset += 1;
        break;

      case 0x28:
        data.report_status = 'yes';
        offset += 1;
        break;

      case 0x03:
        data.report_interval = ((bytes[offset + 1] << 8) | bytes[offset]) & 0xffff;
        offset += 2;
        break;

      case 0x23:
        data.cancel_delay_task = bytes[offset] & 0xff;
        offset += 2; // skip 1 reserved byte
        break;

      case 0x26:
        data.power_consumption_enable = bytes[offset] === 1 ? 'enable' : 'disable';
        offset += 1;
        break;

      case 0x27:
        data.clear_power_consumption = 'yes';
        offset += 1;
        break;

      case 0x32: {
        // Delay task ACK
        const taskId    = bytes[offset] & 0xff;
        const delayTime = ((bytes[offset + 2] << 8) | bytes[offset + 1]) & 0xffff;
        const mask      = bytes[offset + 3] & 0xff;
        const status    = bytes[offset + 4] & 0xff;
        const task: Record<string, any> = { task_id: taskId, delay_time: delayTime };
        for (let idx = 0; idx < 8; idx++) {
          if ((mask >> idx) & 0x01) {
            task[`switch_${idx + 1}`] = (status >> idx) & 0x01 ? 'on' : 'off';
          }
        }
        data.delay_task = task;
        offset += 5;
        break;
      }

      default:
        offset += 1;
        break;
    }

    return { data, offset };
  }

  // ── Encode ────────────────────────────────────────────────────────────────

  encode(command: { type: string; params?: any }): EncodedCommand {
    let bytes: number[] = [];
    const p = command.params ?? {};

    switch (command.type) {
      case 'reboot':
        bytes = [0xff, 0x10, 0xff];
        break;

      case 'report_status':
        bytes = [0xff, 0x28, 0xff];
        break;

      case 'set_report_interval': {
        const v = p.interval ?? 300;
        if (typeof v !== 'number') throw new Error('interval must be a number');
        bytes = [0xff, 0x03, v & 0xff, (v >> 8) & 0xff];
        break;
      }

      case 'control_switch': {
        // p.switches: { switch_1: 'on'|'off', switch_3: 'on', ... }
        const switchMap = p.switches ?? p; // allow params to be the switches directly
        const switchBits: Record<string, number> = {
          switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3,
          switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7,
        };
        let mask   = 0;
        let status = 0;
        for (const [key, bit] of Object.entries(switchBits)) {
          if (key in switchMap) {
            mask   |= 1 << bit;
            if (switchMap[key] === 'on' || switchMap[key] === 1 || switchMap[key] === true) {
              status |= 1 << bit;
            }
          }
        }
        bytes = [0x08, mask & 0xff, status & 0xff];
        break;
      }

      case 'control_switch_with_delay': {
        // p: { task_id, delay_time, switch_1: 'on', ... }
        const taskId    = p.task_id    ?? 1;
        const delayTime = p.delay_time ?? 0;
        if (taskId < 0)    throw new Error('task_id must be >= 0');
        if (delayTime < 0) throw new Error('delay_time must be >= 0');

        const switchBits: Record<string, number> = {
          switch_1: 0, switch_2: 1, switch_3: 2, switch_4: 3,
          switch_5: 4, switch_6: 5, switch_7: 6, switch_8: 7,
        };
        let mask   = 0;
        let status = 0;
        for (const [key, bit] of Object.entries(switchBits)) {
          if (key in p) {
            mask   |= 1 << bit;
            if (p[key] === 'on' || p[key] === 1 || p[key] === true) {
              status |= 1 << bit;
            }
          }
        }
        bytes = [
          0xff, 0x32,
          taskId & 0xff,
          delayTime & 0xff, (delayTime >> 8) & 0xff,
          mask & 0xff,
          status & 0xff,
        ];
        break;
      }

      case 'cancel_delay_task': {
        const taskId = p.task_id ?? 0;
        if (taskId === 0) { bytes = []; break; }
        bytes = [0xff, 0x23, taskId & 0xff, 0xff];
        break;
      }

      case 'set_power_consumption_enable':
        bytes = [0xff, 0x26, p.enable ? 1 : 0];
        break;

      case 'clear_power_consumption':
        bytes = [0xff, 0x27, 0xff];
        break;

      default:
        throw new Error(`WS558: unsupported command "${command.type}"`);
    }

    return { fPort: 85, data: this.hexToBase64(this.bytesToHex(bytes)), confirmed: false };
  }

  // ── canDecode ─────────────────────────────────────────────────────────────
  // WS558 is uniquely identified by the switch status channel (0x08 0x31)
  // or the power metering channels (voltage 0x03 0x74, active power 0x04 0x80).

  canDecode(payload: string | Buffer, _metadata?: any): boolean {
    const bytes = this.normalizePayload(payload);
    if (bytes.length < 2) return false;

    let i = 0;
    while (i + 1 < bytes.length) {
      const ch = bytes[i];
      const ty = bytes[i + 1];

      if (ch === 0x08 && ty === 0x31) return true; // switch status  — WS558 unique
      if (ch === 0x03 && ty === 0x74) return true; // voltage        — WS558 unique
      if (ch === 0x04 && ty === 0x80) return true; // active power   — WS558 unique
      if (ch === 0x07 && ty === 0xc9) return true; // total current  — WS558 unique

      // Skip known attribute channels
      if (ch === 0xff && ty === 0x01) { i += 3; continue; }
      if (ch === 0xff && (ty === 0x09 || ty === 0x0a)) { i += 4; continue; }
      if (ch === 0xff && ty === 0xff) { i += 4; continue; }
      if (ch === 0xff && ty === 0x16) { i += 10; continue; }
      if (ch === 0xff && ty === 0x0f) { i += 3; continue; }
      if (ch === 0xff && (ty === 0xfe || ty === 0x0b)) { i += 3; continue; }

      break;
    }

    return false;
  }


}