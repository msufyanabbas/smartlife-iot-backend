// Firmware / OTA (Over-the-Air update) enums.

/**
 * Lifecycle of an OTA update for a single device.
 * Stored on `device.firmwareUpdateStatus` (a plain varchar column — not a PG
 * enum type — so the value set can evolve without a schema migration).
 */
export enum FirmwareUpdateStatus {
  IDLE = 'IDLE',
  PUSHING = 'PUSHING', // server has published the update notification to the device
  DOWNLOADING = 'DOWNLOADING', // device is pulling the binary
  VERIFYING = 'VERIFYING', // device is checking the checksum
  APPLYING = 'APPLYING', // device is flashing/installing
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

/** Target of a firmware assignment. */
export enum FirmwareTargetType {
  DEVICE = 'DEVICE',
  DEVICE_PROFILE = 'DEVICE_PROFILE',
}
