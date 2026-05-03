// src/modules/devices/codecs/milesight/wt/wt304.codec.ts
// Milesight WT304 — Smart Thermostat (0~10V Valve + EC Fan variant)
//
// WT304 shares the same flat command-ID protocol as WT303, with these differences:
//
//   0x06  temperature_control_valve_status: now a 0–100% value (not just 0/100 enum)
//   0x7c  interface_settings: different sub-object types (10V valve, EC fan variants)
//   0x7d  valve_control_settings: NEW — sub-commands 0x00/0x01/0x02
//   0x7e  fan_ec_control_settings: NEW — sub-commands 0x00/0x01/0x02
//   0x8f  valve_output_0v_enable: NEW — single byte
//   processTemperature also covers valve_control_settings.control_adjustment_range
//
// All other command IDs are identical to WT303 and are inherited unchanged.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import {
  DecodedTelemetry,
  EncodedCommand,
} from '../../interfaces/base-codec.interface';
import { MilesightWT303Codec } from './wt303.codec';

export class MilesightWT304Codec extends MilesightWT303Codec {
  override readonly codecId: string         = 'milesight-wt304';
  override readonly supportedModels: string[] = ['WT304'];

  getCapabilities(): DeviceCapability {
  return {
    ...super.getCapabilities(),  // inherits all WT303 capabilities
    codecId:     this.codecId,
    model:       'WT304',
    description: 'Smart Fan Coil Thermostat (0~10V Valve + EC Fan) — analog valve output, EC fan control',
  };
}

  // ── Additional temperature paths for WT304 ────────────────────────────────
  // valve_control_settings.control_adjustment_range is treated as a temperature
  // delta path by the reference processTemperature implementation.
  // We override TEMPERATURE_PATHS by re-adding the extra entry before decode runs.
  // The cleanest approach: override decode() to add it, then call super, then
  // add the extra celsius/fahrenheit alias ourselves.
  //
  // In practice, the base processTemperature uses a module-level Set that is
  // already populated for WT303. Since we need one extra path, we override
  // decode() to add it post-call.

  override decode(payload: string | Buffer, fPort?: number): DecodedTelemetry {
    const decoded = super.decode(payload, fPort) as any;

    // Add celsius/fahrenheit aliases for valve_control_settings.control_adjustment_range
    // (not in WT303's TEMPERATURE_PATHS set, so super.decode won't have added them)
    if (typeof decoded.valve_control_settings?.control_adjustment_range === 'number') {
      const v = decoded.valve_control_settings.control_adjustment_range;
      decoded.valve_control_settings.celsius_control_adjustment_range    = Number(v.toFixed(2));
      decoded.valve_control_settings.fahrenheit_control_adjustment_range = Number((v * 1.8 + 32).toFixed(2));
    }

    return decoded as DecodedTelemetry;
  }

  override encode(command: { type: string; params?: any }): EncodedCommand {
    const { type, params = {} } = command;

    // ── WT304-specific interface settings (0x7c) ──────────────────────────

    switch (type) {

      case 'set_interface_valve_4_pipe_10v':
        // Four-pipe, 0~10V Valve + Three-speeds Fan
        // cooling/heating: 1=AO1, 2=AO2
        return this.makeEncodedCommand([0x7c, 0x00, params.cooling ?? 1, params.heating ?? 2]);

      case 'set_interface_valve_2_pipe_10v':
        // Two-pipe, 0~10V Valve + Three-speeds Fan
        // control: 1=AO1, 2=AO2
        return this.makeEncodedCommand([0x7c, 0x01, params.control ?? 1]);

      case 'set_interface_valve_2_pipe_10v_fan_ec':
        // Two-pipe, 0~10V Valve + EC Fan
        // control: 1=AO1, 2=AO2; fan: 1=AO1, 2=AO2; fan_power: 0=None, 3=Q1, 4=Q2, 5=Q3
        return this.makeEncodedCommand([0x7c, 0x02, params.control ?? 1, params.fan ?? 2, params.fan_power ?? 5]);

      case 'set_interface_valve_4_pipe_2_wire_fan_ec':
        // Four-pipe, Two-wire Valve + EC Fan
        // cooling/heating: 3=Q1,4=Q2,5=Q3; fan: 1=AO1,2=AO2; fan_power: 0=None,3=Q1,4=Q2,5=Q3
        return this.makeEncodedCommand([0x7c, 0x03, params.cooling ?? 3, params.heating ?? 4, params.fan ?? 2, params.fan_power ?? 5]);

      case 'set_interface_valve_2_pipe_2_wire_fan_ec':
        // Two-pipe, Two-wire Valve + EC Fan
        // control: 3=Q1,4=Q2,5=Q3; fan: 1=AO1,2=AO2; fan_power: 0=None,3=Q1,4=Q2,5=Q3
        return this.makeEncodedCommand([0x7c, 0x04, params.control ?? 3, params.fan ?? 2, params.fan_power ?? 5]);

      case 'set_interface_valve_2_pipe_3_wire_fan_ec':
        // Two-pipe, Three-wire Valve + EC Fan
        // no/nc: 3=Q1,4=Q2,5=Q3; fan: 1=AO1,2=AO2; fan_power: 0=None,3=Q1,4=Q2,5=Q3
        return this.makeEncodedCommand([0x7c, 0x05, params.no ?? 3, params.nc ?? 4, params.fan ?? 2, params.fan_power ?? 5]);

      // ── Valve control settings (0x7d) ─────────────────────────────────────

      case 'set_valve_control_adjustment_range': {
        const v = params.control_adjustment_range ?? 10;
        if (v < 1 || v > 15) throw new Error('control_adjustment_range must be 1–15');
        return this.makeEncodedCommand([0x7d, 0x00, ...this.writeInt16LE304(Math.round(v * 100))]);
      }

      case 'set_valve_opening_range': {
        const min = params.min ?? 0;
        const max = params.max ?? 100;
        if (min < 0 || min > 100 || max < 0 || max > 100) throw new Error('opening_range min/max must be 0–100');
        return this.makeEncodedCommand([0x7d, 0x01, min, max]);
      }

      case 'set_valve_control_interval': {
        const v = params.control_interval ?? 30;
        if (v < 1 || v > 60) throw new Error('control_interval must be 1–60');
        return this.makeEncodedCommand([0x7d, 0x02, v]);
      }

      // ── EC fan control settings (0x7e) ────────────────────────────────────

      case 'set_fan_ec_low_threshold': {
        const v = params.low_threshold ?? 50;
        if (v < 1 || v > 100) throw new Error('low_threshold must be 1–100');
        return this.makeEncodedCommand([0x7e, 0x00, v]);
      }

      case 'set_fan_ec_mid_threshold': {
        const v = params.mid_threshold ?? 80;
        if (v < 1 || v > 100) throw new Error('mid_threshold must be 1–100');
        return this.makeEncodedCommand([0x7e, 0x01, v]);
      }

      case 'set_fan_ec_high_threshold': {
        const v = params.high_threshold ?? 100;
        if (v < 1 || v > 100) throw new Error('high_threshold must be 1–100');
        return this.makeEncodedCommand([0x7e, 0x02, v]);
      }

      // ── Valve output 0V enable (0x8f) ─────────────────────────────────────

      case 'set_valve_output_0v_enable':
        return this.makeEncodedCommand([0x8f, params.valve_output_0v_enable ?? 0]);

      // ── Override WT303 interface commands that don't apply to WT304 ───────
      // WT304 uses 10V/EC fan interfaces; the WT303 relay-based ones should
      // throw rather than silently sending wrong frames.

      case 'set_interface_valve_4_pipe_2_wire':
      case 'set_interface_valve_2_pipe_2_wire':
      case 'set_interface_valve_2_pipe_3_wire':
        throw new Error(`WT304: use the EC fan/10V interface commands instead of "${type}"`);

      default:
        // Delegate everything else to WT303
        return super.encode(command);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private makeEncodedCommand(bytes: number[]): EncodedCommand {
    return {
      fPort:     85,
      data:      this.hexToBase64(this.bytesToHex(bytes)),
      confirmed: false,
    };
  }

  private writeInt16LE304(v: number): number[] {
    const u = v < 0 ? v + 0x10000 : v;
    return [u & 0xff, (u >> 8) & 0xff];
  }
}