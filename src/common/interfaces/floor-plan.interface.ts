// src/common/interfaces/floor-plan.interface.ts
import { DeviceAnimationType } from "@common/enums/index.enum";

export interface FloorPlanSettings {
  measurementUnit: 'metric' | 'imperial';
  autoSave: boolean;
  gridSettings: {
    showGrid: boolean;
    snapToGrid: boolean;
    gridSize: number;
  };
  defaultColors: {
    gateways: string;
    sensorsToGateway: string;
    zones: string;
    sensorsToGrid: string;
  };
}

/**
 * Geometry produced by DxfFloorPlanParser.
 *
 * The parser is the single source of truth for this shape, so the type is
 * aliased from there rather than duplicated. The import is type-only, so it is
 * erased at compile time and introduces no runtime dependency from `common/`
 * onto `modules/`.
 *
 * Every coordinate, radius, thickness and area is in METRES.
 *
 * Backwards compatibility: walls still expose `points`, rooms still expose
 * `boundaries`/`name`/`floor`, doors still expose `rotation`/`height`/`type`,
 * and `bounds` is still present as an alias of `boundingBox` — so renderers
 * written against the previous shape keep working while gaining `columns`,
 * `swing`, per-layer colours, `units`, `scale` and block-expansion metrics.
 */
export type { Parsed3DGeometry } from '../../modules/floor-plans/parsers/dxf-floor-plan.parser';
import type { Parsed3DGeometry } from '../../modules/floor-plans/parsers/dxf-floor-plan.parser';

/**
 * The *stored* shape, which is deliberately looser than the parser's output.
 *
 * `floor_plans.parsedGeometry` is a jsonb column that also holds rows written
 * before this parser existed (seeded demo plans, and plans parsed by the
 * previous implementation) — those carry the four core collections and little
 * else. Requiring the full Parsed3DGeometry here would make every such row a
 * type error without making the data any more complete. Freshly parsed rows are
 * always the full shape.
 */
export type DWGGeometry = Partial<Parsed3DGeometry> &
  Pick<Parsed3DGeometry, 'walls' | 'rooms' | 'doors' | 'windows'>;

export interface Device3DData {
  deviceId: string;
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  model3DUrl?: string;
  animationType: DeviceAnimationType;
  animationConfig?: {
    intensity?: number;
    speed?: number;
    color?: string;
    particleCount?: number;
    radius?: number;
  };
  telemetryBindings?: {
    [telemetryKey: string]: {
      animationProperty: string;
      min: number;
      max: number;
    };
  };
  status?: 'online' | 'offline' | 'alarm';
}

export interface Building3DMetadata {
  buildingName: string;
  totalFloors: number;
  floorHeight: number;
  buildingDimensions: {
    width: number;
    length: number;
    height: number;
  };
  exteriorModel?: string;
  floorOrder: string[];
}