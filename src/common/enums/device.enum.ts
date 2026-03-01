export enum DeviceType {
  SENSOR = 'sensor',
  ACTUATOR = 'actuator',
  GATEWAY = 'gateway',
  CONTROLLER = 'controller',
  CAMERA = 'camera',
  TRACKER = 'tracker',
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
