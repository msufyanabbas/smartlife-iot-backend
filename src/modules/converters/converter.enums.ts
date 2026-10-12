/**
 * Converter enums.
 *
 * These live in the module rather than `@common/enums/index.enum.ts` on
 * purpose: both columns they back are **varchar**, not a PostgreSQL enum, so
 * there is nothing for the shared barrel to keep in step with a migration.
 *
 * Varchar is the deliberate choice. A PG enum column needs
 * `ALTER TYPE … ADD VALUE` before a new TypeScript member can be stored, and
 * `@IsEnum` happily accepts the value that the INSERT then rejects — the exact
 * failure that made the frontend's "Apache Kafka" integration tile 400
 * (CLAUDE.md §4e). `DeviceProfile.transportType` is varchar for the same
 * reason. Adding a converter type here therefore needs a manifest and nothing
 * else.
 */

/** Which way the payload is travelling. */
export enum ConverterDirection {
  /** Device payload → platform telemetry. */
  UPLINK = 'uplink',
  /** Platform command → device payload. */
  DOWNLINK = 'downlink',
}

/** How a converter does its work. One manifest per member in the catalogue. */
export enum ConverterType {
  /** Declarative source-path → target-key mapping, with scaling and casts. */
  JSON = 'json',
  /** A JavaScript expression over the payload, run in a vm2 sandbox. */
  SCRIPT = 'script',
  /** Delegates to CodecRegistryService — the 80+ Milesight codecs. */
  CODEC = 'codec',
}

/**
 * Transport the converter is written for. Presentation/filtering only — nothing
 * in the execution path branches on it, so an unknown value is harmless.
 */
export enum ConverterProtocol {
  LORAWAN = 'lorawan',
  MQTT = 'mqtt',
  HTTP = 'http',
  COAP = 'coap',
  OTHER = 'other',
}

/**
 * Derived, never stored. The converters list page shows a status badge; a
 * column for it would be a third source of truth next to `enabled` and
 * `lastError` and would drift from them.
 */
export enum ConverterHealth {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
  ERROR = 'ERROR',
  PENDING = 'PENDING',
}
