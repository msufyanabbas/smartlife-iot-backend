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

export interface DWGGeometry {
  walls: Array<{
    id: string;
    points: Array<{ x: number; y: number; z?: number }>;
    thickness: number;
    height: number;
    material?: string;
  }>;
  doors: Array<{
    id: string;
    position: { x: number; y: number; z?: number };
    width: number;
    height: number;
    rotation: number;
    type: 'single' | 'double' | 'sliding';
  }>;
  windows: Array<{
    id: string;
    position: { x: number; y: number; z?: number };
    width: number;
    height: number;
    rotation: number;
  }>;
  rooms: Array<{
    id: string;
    name: string;
    boundaries: Array<{ x: number; y: number }>;
    area: number;
    floor: string;
  }>;
  stairs: Array<{
    id: string;
    points: Array<{ x: number; y: number; z?: number }>;
    width: number;
    steps: number;
  }>;
  furniture?: Array<{
    id: string;
    type: string;
    position: { x: number; y: number; z?: number };
    rotation: number;
    dimensions: { width: number; height: number; depth: number };
  }>;
  /**
   * Elevation metrics derived from the drawing's Z values.
   * `hasElevationData` is false for the common case of a flat 2D plan drawn at
   * z=0, in which case `floorHeight` is null and the frontend should fall back
   * to Building3DMetadata.floorHeight.
   */
  building?: {
    hasElevationData: boolean;
    floorHeight: number | null;  // metres; null when it cannot be inferred
    minElevation: number;
    maxElevation: number;
  };

  // ── Raw entity capture ─────────────────────────────────────────────────────
  // A DXF that is not an architectural floor plan (a bridge, a site plan, a
  // mechanical part) still carries usable geometry. These fields keep every
  // entity the parser saw, whatever its layer was named, so nothing is thrown
  // away just because it could not be classified as a wall or a room.

  /**
   * Every LINE entity exactly as it was read, before wall merging. walls[] is
   * the post-processed view (collinear segments merged); this is the raw one.
   */
  lines?: Array<{
    id: string;
    start: { x: number; y: number; z?: number };
    end: { x: number; y: number; z?: number };
    layer?: string;
  }>;

  /** All ARC entities, sampled to points. */
  arcs?: Array<{
    id: string;
    center: { x: number; y: number; z?: number };
    radius: number;
    startAngle: number; // radians
    endAngle: number;   // radians
    points: Array<{ x: number; y: number }>;
    layer?: string;
  }>;

  /** All CIRCLE entities. */
  circles?: Array<{
    id: string;
    center: { x: number; y: number; z?: number };
    radius: number;
    layer?: string;
  }>;

  /** All TEXT / MTEXT entities. */
  texts?: Array<{
    id: string;
    text: string;
    position: { x: number; y: number; z?: number };
    layer?: string;
  }>;

  /** Every distinct layer name encountered, in first-seen order. */
  layers?: string[];

  /** Drawing extents in metres, origin-normalised like every other coordinate. */
  bounds?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };

  /** Raw DXF entity-type histogram, e.g. { LINE: 412, LWPOLYLINE: 33 }. */
  entityCounts?: Record<string, number>;

  /** Total entities seen in the file, including types we do not model. */
  totalEntities?: number;
}

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