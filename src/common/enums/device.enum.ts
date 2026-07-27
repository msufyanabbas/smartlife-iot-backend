export enum DeviceType {
  // ── Generic (original set — existing rows depend on these) ────────────────
  SENSOR = 'sensor',
  ACTUATOR = 'actuator',
  GATEWAY = 'gateway',
  CONTROLLER = 'controller',
  CAMERA = 'camera',
  TRACKER = 'tracker',

  // ── Smart Home ────────────────────────────────────────────────────────────
  THERMOSTAT = 'thermostat',
  LIGHT = 'light',
  LOCK = 'lock',
  PLUG = 'plug',

  // ── Smart Building ────────────────────────────────────────────────────────
  HVAC = 'hvac',
  ACCESS_CONTROL = 'access_control',
  ELEVATOR = 'elevator',

  // ── Smart City ────────────────────────────────────────────────────────────
  LIGHT_CONTROLLER = 'light_controller',
  TRAFFIC_SENSOR = 'traffic_sensor',

  // ── Agriculture ───────────────────────────────────────────────────────────
  WEATHER_STATION = 'weather_station',
  DRONE = 'drone',

  // ── Energy ────────────────────────────────────────────────────────────────
  ENERGY_METER = 'energy_meter',
  INVERTER = 'inverter',
  BATTERY = 'battery',
  EV_CHARGER = 'ev_charger',
  GRID_METER = 'grid_meter',

  // ── Retail ────────────────────────────────────────────────────────────────
  POS = 'pos',
  DISPLAY = 'display',
  SHELF = 'shelf',

  // ── Water ─────────────────────────────────────────────────────────────────
  FLOW_METER = 'flow_meter',

  // ── Facility ──────────────────────────────────────────────────────────────
  BEACON = 'beacon',
}

export enum DeviceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  OFFLINE = 'offline',
  MAINTENANCE = 'maintenance',
  ERROR = 'error',
}

export enum DeviceConnectionType {
  WIFI = 'wifi',
  ETHERNET = 'ethernet',
  CELLULAR = 'cellular',
  BLUETOOTH = 'bluetooth',
  ZIGBEE = 'zigbee',
  LORA = 'lora',
}
