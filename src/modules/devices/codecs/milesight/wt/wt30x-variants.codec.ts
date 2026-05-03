// src/modules/devices/codecs/milesight/wt30x-variants.codec.ts
//
// WT30x thermostat family — variant registrations.
//
// The WT301 and WT302 share an identical protocol (proprietary 0x55-framed).
// The WT302 is a hardware SKU variant (different enclosure/valve actuator)
// but produces byte-for-byte identical frames. It is registered here as a
// thin subclass following the same pattern used across the Milesight family.

import { DeviceCapability } from '@/common/interfaces/device-capability.interface';
import { MilesightWT301Codec } from './wt301.codec';

// ── WT302 — identical protocol to WT301 ──────────────────────────────────
export class MilesightWT302Codec extends MilesightWT301Codec {
  override readonly codecId = 'milesight-wt302';
  override readonly supportedModels: string[] = ['WT302'];
  getCapabilities(): DeviceCapability {
  return { ...super.getCapabilities(), codecId: this.codecId, model: 'WT302',
    description: 'Smart Fan Coil Thermostat (WT302) — proprietary framed protocol' };
}
}