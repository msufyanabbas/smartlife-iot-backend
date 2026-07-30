// src/common/interfaces/asset-profile.interface.ts
import { ProfileFieldType } from '@common/enums/index.enum';

/**
 * A single field an asset of this profile is expected to carry.
 * Values live in `Asset.configuration[key]`.
 */
/**
 * One choice of a `select` / `multiselect` field, labelled in both languages.
 *
 * BREAKING: previously `ProfileField.options` was a plain `string[]`. It is now
 * a list of {value,label,labelAr} so the stored value is stable while the
 * displayed text is localisable. The asset-profile seeder rewrites all stock
 * profiles into the new shape.
 */
export interface ProfileFieldOption {
  value: string;
  label: string;
  labelAr: string;
}

export interface ProfileField {
  key: string; // e.g. 'totalFloors'
  label: string; // English label, e.g. 'Total Floors'
  labelAr: string; // Arabic label, e.g. 'إجمالي الطوابق'
  type:
    | ProfileFieldType
    | 'text'
    | 'number'
    | 'boolean'
    | 'select'
    | 'multiselect'
    | 'date'
    | 'floors_array'
    | 'devices_array';
  required: boolean;
  /** UI grouping, e.g. 'Building Info' | 'Contact'. */
  group?: string;
  /** Display order within the form. */
  order?: number;
  min?: number; // for type 'number'
  max?: number; // for type 'number'
  options?: ProfileFieldOption[]; // for 'select' / 'multiselect'
  defaultValue?: any;
  unit?: string; // e.g. 'm²', 'floors'
  placeholder?: string;
  placeholderAr?: string;
  helpText?: string;
  helpTextAr?: string;
}

/**
 * Constraints on which devices may be linked to assets of this profile.
 * Enforced by AssetsService.assignDevice() / bulkAssignDevices().
 */
export interface ProfileDeviceLinkingConfig {
  allowMultipleDevices: boolean;
  /** Restrict to these DeviceType values. Empty/absent means no restriction. */
  deviceTypeFilter?: string[];
  maxDevices?: number;
}

/**
 * The schema an AssetProfile declares. Kept deliberately flat (a single
 * `fields` array) — this is what the frontend renders as a dynamic form.
 *
 * NOTE: this is separate from the older `attributesSchema` (required/optional
 * split) which remains on AssetProfile for backwards compatibility.
 */
export interface ProfileSchema {
  fields: ProfileField[];
  deviceLinkingConfig?: ProfileDeviceLinkingConfig;
}

/**
 * One floor of a multi-floor asset. Stored inside
 * `Asset.configuration.floorsData` by a `floors_array` profile field.
 */
export interface FloorConfig {
  floorNumber: number;
  name?: string;
  rooms?: number;
  area?: number;
}

/**
 * Profile-specific values stored on the asset. Keys correspond to
 * ProfileField.key of the asset's AssetProfile.
 */
export interface AssetConfiguration {
  totalFloors?: number;
  totalArea?: number;
  floorsData?: FloorConfig[];
  [key: string]: any;
}
