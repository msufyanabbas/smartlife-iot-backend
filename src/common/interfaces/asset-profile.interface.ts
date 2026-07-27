// src/common/interfaces/asset-profile.interface.ts
import { ProfileFieldType } from '@common/enums/index.enum';

/**
 * A single field an asset of this profile is expected to carry.
 * Values live in `Asset.configuration[key]`.
 */
export interface ProfileField {
  key: string; // e.g. 'totalFloors'
  label: string; // e.g. 'Total Floors'
  type: ProfileFieldType | 'text' | 'number' | 'boolean' | 'select' | 'floors_array';
  required: boolean;
  options?: string[]; // for type 'select'
  min?: number; // for type 'number'
  max?: number; // for type 'number'
  defaultValue?: any;
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
