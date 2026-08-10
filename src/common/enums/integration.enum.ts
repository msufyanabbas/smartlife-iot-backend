// src/common/enums/integration.enum.ts
//
// Values are lowercase because they are persisted in the PG enum
// `integrations_type_enum`. Adding a member here needs a migration
// (`ALTER TYPE ... ADD VALUE`) — see IntegrationsRuntime.
export enum IntegrationType {
  CLOUD = 'cloud',
  WEBHOOK = 'webhook',
  MQTT = 'mqtt',
  NOTIFICATION = 'notification',
  API = 'api',
  DATABASE = 'database',

  // ── Dispatch targets with a dedicated adapter ─────────────────────────────
  // CLOUD stays as the generic bucket it always was; these two name the
  // provider explicitly so IntegrationDispatchService can pick an adapter
  // without guessing from the configuration blob.
  TUYA = 'tuya',
  AWS_IOT = 'aws_iot',
}

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}