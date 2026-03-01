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