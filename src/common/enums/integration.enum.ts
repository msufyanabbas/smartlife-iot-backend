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

  // ── Cloud providers — NO OUTBOUND ADAPTER YET ─────────────────────────────
  // Accepted by POST /integrations so the connection can be configured and
  // stored, but IntegrationDispatchService.resolveAdapter() returns null for
  // both, so telemetry is NOT forwarded to them — dispatch skips the row with
  // a warning. Wiring them up means adding an AzureIotAdapter / GoogleCloud
  // adapter to the `adapters` map in integration-dispatch.service.ts.
  AZURE_IOT = 'azure_iot',
  GOOGLE_CLOUD = 'google_cloud',

  // ── LoRaWAN network servers — INBOUND ONLY ────────────────────────────────
  // These are not dispatch targets. An integration row of this type exists to
  // map an incoming uplink webhook to a tenant (see LorawanService): the
  // network server pushes to /integrations/lorawan/{chirpstack,ttn} and the
  // row identifies whose devices those uplinks belong to.
  CHIRPSTACK = 'chirpstack',
  TTN = 'ttn',
}

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}