// src/common/enums/floor-plan.enum.ts
export enum FloorPlanStatus {
  ACTIVE = 'active',
  DRAFT = 'draft',
  ARCHIVED = 'archived',
  PROCESSING = 'processing',
  FAILED = 'failed',
}

export enum DeviceAnimationType {
  SMOKE = 'smoke',
  DOOR_OPEN_CLOSE = 'door_open_close',
  LIGHT_PULSE = 'light_pulse',
  WATER_LEAK = 'water_leak',
  TEMPERATURE_GRADIENT = 'temperature_gradient',
  MOTION_WAVE = 'motion_wave',
  ALARM_FLASH = 'alarm_flash',
  NONE = 'none',
}