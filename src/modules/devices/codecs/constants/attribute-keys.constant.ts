// src/modules/devices/codecs/constants/attribute-keys.constant.ts
//
// These keys — produced by any Milesight codec from 0xFF/* channels —
// are device attributes, not time-series telemetry.
// Any key NOT in this set is treated as telemetry.

export const MILESIGHT_ATTRIBUTE_KEYS = new Set<string>([
  // ── Device info (0xFF channels) ──────────────────────────────────────────
  'ipso_version',
  'hardware_version',
  'firmware_version',
  'tsl_version',
  'sn',
  'lorawan_class',
  'device_status',
  'reset_event',
]);