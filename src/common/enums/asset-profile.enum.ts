// Enums

/**
 * What kind of real-world thing an AssetProfile describes.
 *
 * Drives the `schema` field on AssetProfile: a profile of type `building`
 * declares floor-related fields (totalFloors, floorsData), a `shop` declares
 * departments/checkouts, and so on. `custom` ships with an empty schema so a
 * tenant can define its own fields.
 *
 * Stored as varchar (not a PG enum) so new types can be added without a
 * database enum migration.
 */
export enum AssetProfileType {
  BUILDING = 'building',
  VEHICLE = 'vehicle',
  SHOP = 'shop',
  FARM = 'farm',
  WAREHOUSE = 'warehouse',
  HOSPITAL = 'hospital',
  HOTEL = 'hotel',
  FACTORY = 'factory',
  CUSTOM = 'custom',
}

/**
 * Field types supported by ProfileSchema.
 *
 * `floors_array` is special: its value on the asset is a FloorConfig[] and it
 * is what drives multi-floor floor plans (GET /assets/:id/floors).
 * `devices_array` holds a list of linked device ids.
 */
export enum ProfileFieldType {
  TEXT = 'text',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  SELECT = 'select',
  MULTISELECT = 'multiselect',
  DATE = 'date',
  FLOORS_ARRAY = 'floors_array',
  DEVICES_ARRAY = 'devices_array',
}

export enum QueueName {
  HIGH_PRIORITY = 'HighPriority',
  LOW_PRIORITY = 'LowPriority',
  MAIN = 'Main',
  SEQUENTIAL_BY_ORIGINATOR = 'SequentialByOriginator',
}

export enum SubmitStrategy {
  BURST = 'BURST',
  SEQUENTIAL_BY_ORIGINATOR = 'SEQUENTIAL_BY_ORIGINATOR',
  BATCH = 'BATCH',
}

export enum ProcessingStrategy {
  RETRY_FAILED_AND_TIMED_OUT = 'RETRY_FAILED_AND_TIMED_OUT',
  SKIP_ALL_FAILURES_AND_TIMED_OUT = 'SKIP_ALL_FAILURES_AND_TIMED_OUT',
  SKIP_ALL_FAILURES = 'SKIP_ALL_FAILURES',
  RETRY_ALL = 'RETRY_ALL',
}

export enum AssetAlarmSeverity {
  CRITICAL = 'CRITICAL',
  MAJOR = 'MAJOR',
  MINOR = 'MINOR',
  WARNING = 'WARNING',
  INDETERMINATE = 'INDETERMINATE',
}