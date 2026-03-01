// src/common/enums/integration.enum.ts 
export enum IntegrationType {
  CLOUD = 'cloud',
  WEBHOOK = 'webhook',
  MQTT = 'mqtt',
  NOTIFICATION = 'notification',
  API = 'api',
  DATABASE = 'database',
}

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}