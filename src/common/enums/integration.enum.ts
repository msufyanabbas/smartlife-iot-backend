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
  LORIOT = 'loriot',
  SIGFOX = 'sigfox',

  // ── Messaging / streaming targets ─────────────────────────────────────────
  KAFKA = 'kafka',
  AZURE_EVENT_HUB = 'azure_event_hub',
  IBM_WATSON = 'ibm_watson',
  COAP = 'coap',

  // ── NB-IoT carrier bearers — INBOUND ONLY ─────────────────────────────────
  // NB-IoT is a radio bearer, not an application protocol, so there is no
  // "NB-IoT wire format" to implement. What a carrier platform actually gives
  // you is one of two deliveries, and these two types model exactly those:
  //
  //  NBIOT_HTTP — the carrier's IoT platform (Zain/STC/Vodafone/Telefónica
  //    Kite, Huawei OceanConnect, …) POSTs each uplink to a URL you register
  //    with it. Served by POST /nbiot/uplink/:id, which resolves the device by
  //    IMEI / IMSI / ICCID / MSISDN against `nbiot_devices`, lifts the radio
  //    metrics out of the body and ends at DeviceListenerService.
  //  NBIOT_COAP — the device talks straight to the platform's CoAP server on
  //    UDP 5683 with its deviceKey as the URI token. No per-integration code
  //    runs at all; the row exists so the endpoint and the PSK note have
  //    somewhere to live and so the UI can tell an operator what to configure.
  NBIOT_HTTP = 'nbiot_http',
  NBIOT_COAP = 'nbiot_coap',
}

/**
 * Which way data flows for a given integration type.
 *
 * This is what stops the telemetry fan-out from touching rows it has no
 * business touching. Before it existed, every ACTIVE integration received every
 * telemetry message regardless of type, which had two concrete consequences:
 *
 *  · A Tuya integration was quarantined by ordinary traffic. TuyaAdapter's
 *    dispatch is command-only, so a telemetry message with no `commands`
 *    returns `success: false`; ten of those set the row to ERROR and
 *    `enabled = false` — which also silently stopped the Tuya device poll,
 *    because that only picks up ACTIVE+enabled rows.
 *  · ChirpStack / TTN / notification / database rows logged
 *    "No adapter for integration type" once per reading, per integration.
 */
export enum IntegrationDirection {
  /** Receives data from an external system. Never a dispatch target. */
  INBOUND = 'inbound',
  /** Telemetry is forwarded to it. */
  OUTBOUND = 'outbound',
  /** Both — e.g. MQTT, which can publish out and subscribe in. */
  BIDIRECTIONAL = 'bidirectional',
}

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}