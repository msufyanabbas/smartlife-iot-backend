// src/common/interfaces/decoded-payload.interface.ts
//
// All codecs return this shape.
// - telemetry  → time-series, stored in telemetry table with timestamp
// - attributes → device metadata, upserted in attributes table (last value only)

export interface DecodedPayload {
  /**
   * Time-series sensor readings — stored per message with full history.
   * Examples: temperature, humidity, latitude, rssi, switch_1
   */
  telemetry: Record<string, any>;

  /**
   * Device metadata — upserted, no history kept (last value wins).
   * Examples: firmware_version, hardware_version, lorawan_class, device_status
   */
  attributes: Record<string, any>;
}