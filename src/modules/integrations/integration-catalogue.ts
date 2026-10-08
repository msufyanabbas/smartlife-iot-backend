import {
  IntegrationType,
  IntegrationDirection,
} from '@common/enums/index.enum';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The integration catalogue — one description of every type, used by both sides.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is the single source of truth for what an integration type IS: what
 * it is called, which way data flows, and exactly which configuration fields it
 * needs. Three consumers read it and they cannot drift apart:
 *
 *   1. `validateIntegrationConfig()` — server-side validation. Before this,
 *      `configuration` was `@IsObject()` and nothing else, so
 *      `POST /integrations {type:'mqtt', configuration:{}}` was a valid 201 and
 *      the first sign of trouble was a dispatch failure hours later.
 *   2. `GET /integrations/catalogue` — the frontend renders its "add
 *      integration" form from this, so a field added here appears in the UI
 *      with no frontend change.
 *   3. `IntegrationDispatchService` — reads `direction` to decide which rows
 *      are legitimate telemetry targets.
 *
 * Adding a type means: a member on IntegrationType, a migration adding the
 * label to `integrations_type_enum`, an entry here, and (if outbound) an
 * adapter in the dispatcher's map.
 */

export type IntegrationFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea';

export interface IntegrationFieldOption {
  value: string;
  label: string;
}

export interface IntegrationConfigField {
  key: string;
  label: string;
  type: IntegrationFieldType;
  required?: boolean;
  placeholder?: string;
  /** Shown under the input. Say what the value is FOR, not what it is called. */
  help?: string;
  options?: IntegrationFieldOption[];
  default?: string | number | boolean;
  /** Groups fields into sections in the form. */
  group?: string;
  min?: number;
  max?: number;
  /**
   * Show this field only when another field has one of these values.
   * Used for things like TLS options that only matter when TLS is on.
   */
  showIf?: { key: string; equals: Array<string | number | boolean> };
}

export type IntegrationCategory =
  | 'http'
  | 'messaging'
  | 'cloud'
  | 'lorawan'
  | 'vendor'
  | 'other';

export interface IntegrationTypeManifest {
  type: IntegrationType;
  label: string;
  category: IntegrationCategory;
  direction: IntegrationDirection;
  description: string;
  /** Lucide icon name the frontend maps to a component. */
  icon: string;
  /** False when the type is storable but telemetry is not forwarded to it. */
  hasAdapter: boolean;
  /** Shown in the UI when `hasAdapter` is false, explaining what does work. */
  adapterNote?: string;
  /** The inbound URL path, for types that receive. `:id` is substituted. */
  inboundPath?: string;
  /** Default value for the entity's `protocol` column. */
  defaultProtocol: string;
  fields: IntegrationConfigField[];
}

// ── Shared field builders ────────────────────────────────────────────────────
// Repeating these by hand is how two MQTT-ish types end up with subtly
// different key names for the same thing.

const timeoutField = (): IntegrationConfigField => ({
  key: 'timeout',
  label: 'Timeout (ms)',
  type: 'number',
  default: 10000,
  min: 1000,
  max: 120000,
  group: 'Advanced',
  help: 'How long to wait for the remote end before counting the message as failed.',
});

const topicTemplateHelp =
  'Supports {{deviceId}}, {{deviceKey}} and {{tenantId}}, substituted per message.';

export const INTEGRATION_CATALOGUE: Record<
  IntegrationType,
  IntegrationTypeManifest
> = {
  // ── HTTP ───────────────────────────────────────────────────────────────────
  [IntegrationType.WEBHOOK]: {
    type: IntegrationType.WEBHOOK,
    label: 'Webhook',
    category: 'http',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'POST each reading to a URL you control. Optionally HMAC-signed so the receiver can verify it came from here.',
    icon: 'Webhook',
    hasAdapter: true,
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'url',
        label: 'Endpoint URL',
        type: 'text',
        required: true,
        placeholder: 'https://example.com/hooks/telemetry',
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'POST',
        options: ['POST', 'PUT', 'PATCH'].map((value) => ({
          value,
          label: value,
        })),
      },
      {
        key: 'secret',
        label: 'Signing secret',
        type: 'password',
        help: 'When set, each request carries X-Signature: sha256=… over the exact body bytes.',
      },
      timeoutField(),
    ],
  },

  [IntegrationType.API]: {
    type: IntegrationType.API,
    label: 'HTTP / REST API',
    category: 'http',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Call an arbitrary REST endpoint, with bearer-token or basic authentication.',
    icon: 'Globe',
    hasAdapter: true,
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'url',
        label: 'Endpoint URL',
        type: 'text',
        required: true,
        placeholder: 'https://api.example.com/v1/ingest',
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'POST',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((value) => ({
          value,
          label: value,
        })),
      },
      {
        key: 'apiKey',
        label: 'Bearer token',
        type: 'password',
        group: 'Authentication',
        help: 'Sent as Authorization: Bearer …. Ignored if basic auth is filled in.',
      },
      {
        key: 'basicAuthUsername',
        label: 'Basic auth username',
        type: 'text',
        group: 'Authentication',
      },
      {
        key: 'basicAuthPassword',
        label: 'Basic auth password',
        type: 'password',
        group: 'Authentication',
      },
      timeoutField(),
    ],
  },

  // ── Messaging ──────────────────────────────────────────────────────────────
  [IntegrationType.MQTT]: {
    type: IntegrationType.MQTT,
    label: 'MQTT Broker',
    category: 'messaging',
    direction: IntegrationDirection.BIDIRECTIONAL,
    description:
      'Publish readings to an external broker, and optionally subscribe to a topic to pull data back in.',
    icon: 'Radio',
    hasAdapter: true,
    defaultProtocol: 'MQTT',
    fields: [
      {
        key: 'brokerUrl',
        label: 'Broker URL',
        type: 'text',
        required: true,
        placeholder: 'mqtt://broker.example.com:1883',
        help: 'Include the scheme: mqtt://, mqtts://, ws:// or wss://.',
      },
      { key: 'username', label: 'Username', type: 'text', group: 'Authentication' },
      { key: 'password', label: 'Password', type: 'password', group: 'Authentication' },
      {
        key: 'topic',
        label: 'Publish topic',
        type: 'text',
        default: 'smartlife/{{deviceId}}/telemetry',
        group: 'Publish',
        help: topicTemplateHelp,
      },
      {
        key: 'qos',
        label: 'QoS',
        type: 'select',
        default: 1,
        group: 'Publish',
        options: [
          { value: '0', label: '0 — at most once' },
          { value: '1', label: '1 — at least once' },
          { value: '2', label: '2 — exactly once' },
        ],
      },
      {
        key: 'inboundTopic',
        label: 'Subscribe topic',
        type: 'text',
        group: 'Subscribe',
        placeholder: 'external/+/telemetry',
        help: 'Leave blank for publish-only. When set, messages on this topic are ingested as device telemetry — the device is matched by the deviceKey field in the payload, or by the topic segment named below.',
      },
      {
        key: 'inboundDeviceKeyField',
        label: 'Device key field',
        type: 'text',
        default: 'deviceKey',
        group: 'Subscribe',
        help: 'Which JSON property of the incoming message holds the device key.',
      },
      {
        key: 'inboundDeviceKeyTopicIndex',
        label: 'Device key topic segment',
        type: 'number',
        group: 'Subscribe',
        min: 0,
        help: 'Zero-based segment of the topic to read the device key from, when it is not in the payload. For external/ABC123/telemetry that is 1.',
      },
    ],
  },

  [IntegrationType.KAFKA]: {
    type: IntegrationType.KAFKA,
    label: 'Apache Kafka',
    category: 'messaging',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Produce each reading onto a Kafka topic, keyed by device so a device’s readings stay in order.',
    icon: 'Layers',
    hasAdapter: true,
    defaultProtocol: 'KAFKA',
    fields: [
      {
        key: 'brokers',
        label: 'Bootstrap servers',
        type: 'text',
        required: true,
        placeholder: 'kafka-1:9092, kafka-2:9092',
        help: 'Comma-separated host:port list.',
      },
      {
        key: 'topic',
        label: 'Topic',
        type: 'text',
        required: true,
        placeholder: 'iot.telemetry',
        help: topicTemplateHelp,
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        default: 'smartlife-integration',
      },
      {
        key: 'ssl',
        label: 'Use TLS',
        type: 'boolean',
        default: false,
        group: 'Authentication',
      },
      {
        key: 'saslMechanism',
        label: 'SASL mechanism',
        type: 'select',
        group: 'Authentication',
        options: [
          { value: '', label: 'None' },
          { value: 'plain', label: 'PLAIN' },
          { value: 'scram-sha-256', label: 'SCRAM-SHA-256' },
          { value: 'scram-sha-512', label: 'SCRAM-SHA-512' },
        ],
      },
      {
        key: 'saslUsername',
        label: 'SASL username',
        type: 'text',
        group: 'Authentication',
        showIf: {
          key: 'saslMechanism',
          equals: ['plain', 'scram-sha-256', 'scram-sha-512'],
        },
      },
      {
        key: 'saslPassword',
        label: 'SASL password',
        type: 'password',
        group: 'Authentication',
        showIf: {
          key: 'saslMechanism',
          equals: ['plain', 'scram-sha-256', 'scram-sha-512'],
        },
      },
    ],
  },

  [IntegrationType.COAP]: {
    type: IntegrationType.COAP,
    label: 'CoAP Endpoint',
    category: 'messaging',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'POST readings to a CoAP server over UDP. Suited to constrained networks where HTTP is too heavy.',
    icon: 'Antenna',
    hasAdapter: true,
    defaultProtocol: 'COAP',
    fields: [
      {
        key: 'host',
        label: 'Host',
        type: 'text',
        required: true,
        placeholder: 'coap.example.com',
      },
      { key: 'port', label: 'Port', type: 'number', default: 5683, min: 1, max: 65535 },
      {
        key: 'path',
        label: 'Path',
        type: 'text',
        required: true,
        default: '/telemetry',
        help: topicTemplateHelp,
      },
      {
        key: 'method',
        label: 'Method',
        type: 'select',
        default: 'POST',
        options: ['POST', 'PUT'].map((value) => ({ value, label: value })),
      },
      {
        key: 'confirmable',
        label: 'Confirmable',
        type: 'boolean',
        default: true,
        help: 'Wait for an acknowledgement. Turn off for fire-and-forget on a lossy link.',
      },
      timeoutField(),
    ],
  },

  // ── Cloud ──────────────────────────────────────────────────────────────────
  [IntegrationType.AWS_IOT]: {
    type: IntegrationType.AWS_IOT,
    label: 'AWS IoT Core',
    category: 'cloud',
    direction: IntegrationDirection.OUTBOUND,
    description: 'Publish readings to an AWS IoT Core topic via the Data Plane API.',
    icon: 'Cloud',
    hasAdapter: true,
    defaultProtocol: 'MQTT',
    fields: [
      {
        key: 'endpoint',
        label: 'Data endpoint',
        type: 'text',
        required: true,
        placeholder: 'a1b2c3d4e5f6-ats.iot.eu-west-1.amazonaws.com',
        help: 'The ATS data endpoint, from AWS IoT → Settings.',
      },
      { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' },
      {
        key: 'accessKeyId',
        label: 'Access key ID',
        type: 'text',
        required: true,
        group: 'Credentials',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret access key',
        type: 'password',
        required: true,
        group: 'Credentials',
      },
      {
        key: 'sessionToken',
        label: 'Session token',
        type: 'password',
        group: 'Credentials',
        help: 'Only for temporary STS credentials.',
      },
      {
        key: 'topic',
        label: 'Topic',
        type: 'text',
        required: true,
        default: 'smartlife/{{deviceId}}/telemetry',
        help: topicTemplateHelp,
      },
      {
        key: 'qos',
        label: 'QoS',
        type: 'select',
        default: 1,
        options: [
          { value: '0', label: '0 — at most once' },
          { value: '1', label: '1 — at least once' },
        ],
      },
    ],
  },

  [IntegrationType.AZURE_IOT]: {
    type: IntegrationType.AZURE_IOT,
    label: 'Azure IoT Hub',
    category: 'cloud',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Send device-to-cloud messages to an Azure IoT Hub over its REST API.',
    icon: 'Cloud',
    hasAdapter: true,
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'hostName',
        label: 'Hub host name',
        type: 'text',
        required: true,
        placeholder: 'my-hub.azure-devices.net',
      },
      {
        key: 'deviceId',
        label: 'Azure device ID',
        type: 'text',
        required: true,
        help: 'The identity in IoT Hub that messages are sent as. Use {{deviceKey}} to map each platform device to its own identity.',
      },
      {
        key: 'sharedAccessKey',
        label: 'Shared access key',
        type: 'password',
        required: true,
        group: 'Credentials',
        help: 'The primary key of the device or of a shared-access policy. Used to sign a short-lived SAS token per request.',
      },
      {
        key: 'sharedAccessKeyName',
        label: 'Policy name',
        type: 'text',
        group: 'Credentials',
        help: 'Leave blank when using a per-device key. Set it when using a hub-level policy such as "device".',
      },
      timeoutField(),
    ],
  },

  [IntegrationType.AZURE_EVENT_HUB]: {
    type: IntegrationType.AZURE_EVENT_HUB,
    label: 'Azure Event Hubs',
    category: 'cloud',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Stream readings into an Event Hub for downstream analytics pipelines.',
    icon: 'Cloud',
    hasAdapter: true,
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'namespace',
        label: 'Namespace',
        type: 'text',
        required: true,
        placeholder: 'my-namespace.servicebus.windows.net',
      },
      { key: 'eventHubName', label: 'Event Hub name', type: 'text', required: true },
      {
        key: 'sharedAccessKeyName',
        label: 'Policy name',
        type: 'text',
        required: true,
        default: 'RootManageSharedAccessKey',
        group: 'Credentials',
      },
      {
        key: 'sharedAccessKey',
        label: 'Policy key',
        type: 'password',
        required: true,
        group: 'Credentials',
      },
      timeoutField(),
    ],
  },

  [IntegrationType.GOOGLE_CLOUD]: {
    type: IntegrationType.GOOGLE_CLOUD,
    label: 'Google Cloud Pub/Sub',
    category: 'cloud',
    direction: IntegrationDirection.OUTBOUND,
    description: 'Publish readings to a Pub/Sub topic using a service account.',
    icon: 'Cloud',
    hasAdapter: true,
    defaultProtocol: 'HTTPS',
    fields: [
      { key: 'projectId', label: 'Project ID', type: 'text', required: true },
      {
        key: 'topic',
        label: 'Topic ID',
        type: 'text',
        required: true,
        placeholder: 'iot-telemetry',
        help: 'The short topic name, not the full projects/…/topics/… path.',
      },
      {
        key: 'clientEmail',
        label: 'Service account email',
        type: 'text',
        required: true,
        group: 'Credentials',
        placeholder: 'publisher@my-project.iam.gserviceaccount.com',
      },
      {
        key: 'privateKey',
        label: 'Private key',
        type: 'textarea',
        required: true,
        group: 'Credentials',
        help: 'The private_key value from the service account JSON, including the BEGIN/END lines.',
      },
      timeoutField(),
    ],
  },

  [IntegrationType.IBM_WATSON]: {
    type: IntegrationType.IBM_WATSON,
    label: 'IBM Watson IoT',
    category: 'cloud',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Publish events to the Watson IoT Platform as an application client over MQTT.',
    icon: 'Cloud',
    hasAdapter: true,
    defaultProtocol: 'MQTT',
    fields: [
      {
        key: 'orgId',
        label: 'Organisation ID',
        type: 'text',
        required: true,
        placeholder: 'ab1cde',
        help: 'The six-character org from your Watson IoT URL.',
      },
      { key: 'apiKey', label: 'API key', type: 'text', required: true, group: 'Credentials' },
      {
        key: 'apiToken',
        label: 'Authentication token',
        type: 'password',
        required: true,
        group: 'Credentials',
      },
      {
        key: 'deviceType',
        label: 'Device type',
        type: 'text',
        required: true,
        default: 'smartlife',
        help: 'The Watson device type to publish under.',
      },
      {
        key: 'eventId',
        label: 'Event ID',
        type: 'text',
        default: 'telemetry',
      },
    ],
  },

  // ── Vendor clouds ──────────────────────────────────────────────────────────
  [IntegrationType.TUYA]: {
    type: IntegrationType.TUYA,
    label: 'Tuya Smart',
    category: 'vendor',
    direction: IntegrationDirection.INBOUND,
    description:
      'Mirror a Tuya cloud project: its devices become devices here and their datapoints become telemetry. Commands can be sent back to Tuya devices.',
    icon: 'Boxes',
    hasAdapter: true,
    adapterNote:
      'Inbound: devices and readings are pulled from Tuya every 10 seconds. Platform telemetry is NOT forwarded to Tuya — which is why the direction is "receives" even though commands travel the other way. Send those from the Tuya devices tab on this integration.',
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'clientId',
        label: 'Access ID',
        type: 'text',
        required: true,
        group: 'Credentials',
        help: 'From your Tuya IoT project, Authorization Key.',
      },
      {
        key: 'clientSecret',
        label: 'Access secret',
        type: 'password',
        required: true,
        group: 'Credentials',
      },
      {
        key: 'region',
        label: 'Data centre',
        type: 'select',
        required: true,
        default: 'eu',
        options: [
          { value: 'eu', label: 'Central Europe' },
          { value: 'us', label: 'Western America' },
          { value: 'cn', label: 'China' },
          { value: 'in', label: 'India' },
        ],
        help: 'Must match the data centre your Tuya project was created in, or authentication fails.',
      },
      {
        key: 'pollDeviceLogs',
        label: 'Poll per-device event logs',
        type: 'boolean',
        default: false,
        group: 'Advanced',
        help: 'Catches datapoints that change and revert between two polls, at the cost of one API call per device per tick.',
      },
      {
        key: 'maxLogDevices',
        label: 'Max devices per log poll',
        type: 'number',
        default: 25,
        min: 1,
        max: 200,
        group: 'Advanced',
        showIf: { key: 'pollDeviceLogs', equals: [true] },
      },
      {
        key: 'webhookSecret',
        label: 'Bridge secret',
        type: 'password',
        group: 'Advanced',
        help: 'Required in the x-webhook-secret header on the HTTP bridge endpoint. Tuya itself has no HTTP callback — this is for a Pulsar sidecar.',
      },
    ],
  },

  // ── LoRaWAN network servers (inbound) ──────────────────────────────────────
  [IntegrationType.CHIRPSTACK]: {
    type: IntegrationType.CHIRPSTACK,
    label: 'ChirpStack',
    category: 'lorawan',
    direction: IntegrationDirection.INBOUND,
    description:
      'Receive LoRaWAN uplinks from a ChirpStack network server. Devices are auto-provisioned on first uplink.',
    icon: 'RadioTower',
    hasAdapter: false,
    adapterNote:
      'Inbound only. Point ChirpStack’s HTTP integration at the URL below; telemetry is not sent back to it.',
    inboundPath: '/integrations/lorawan/chirpstack',
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'applicationId',
        label: 'Application ID',
        type: 'text',
        help: 'Only needed when this tenant has more than one ChirpStack integration — it tells them apart.',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook secret',
        type: 'password',
        help: 'When set, uplinks must carry a matching x-webhook-secret header.',
      },
    ],
  },

  [IntegrationType.TTN]: {
    type: IntegrationType.TTN,
    label: 'The Things Stack',
    category: 'lorawan',
    direction: IntegrationDirection.INBOUND,
    description:
      'Receive LoRaWAN uplinks from The Things Stack v3 via its webhook integration.',
    icon: 'RadioTower',
    hasAdapter: false,
    adapterNote: 'Inbound only. Add a custom webhook in TTS pointing at the URL below.',
    inboundPath: '/integrations/lorawan/ttn',
    defaultProtocol: 'HTTPS',
    fields: [
      { key: 'applicationId', label: 'Application ID', type: 'text' },
      { key: 'webhookSecret', label: 'Webhook secret', type: 'password' },
    ],
  },

  [IntegrationType.LORIOT]: {
    type: IntegrationType.LORIOT,
    label: 'LORIOT',
    category: 'lorawan',
    direction: IntegrationDirection.INBOUND,
    description: 'Receive LoRaWAN uplinks from a LORIOT network server.',
    icon: 'RadioTower',
    hasAdapter: false,
    adapterNote:
      'Inbound only, over the generic uplink endpoint below. Configure a LORIOT HTTP push output pointing at it.',
    inboundPath: '/integrations/http/:id',
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'routingKey',
        label: 'Routing key',
        type: 'password',
        required: true,
        help: 'A shared secret that must appear in the x-routing-key header. This is what authenticates the uplink.',
      },
      {
        key: 'deviceKeyField',
        label: 'Device key field',
        type: 'text',
        default: 'EUI',
        help: 'Which property of the uplink body holds the device EUI.',
      },
      {
        key: 'dataField',
        label: 'Payload field',
        type: 'text',
        default: 'data',
        help: 'Which property holds the payload. Leave blank to ingest the whole body.',
      },
    ],
  },

  [IntegrationType.SIGFOX]: {
    type: IntegrationType.SIGFOX,
    label: 'Sigfox',
    category: 'lorawan',
    direction: IntegrationDirection.INBOUND,
    description: 'Receive messages from the Sigfox backend via a custom callback.',
    icon: 'RadioTower',
    hasAdapter: false,
    adapterNote:
      'Inbound only, over the generic uplink endpoint below. Create a Sigfox DATA callback of type "custom" pointing at it.',
    inboundPath: '/integrations/http/:id',
    defaultProtocol: 'HTTPS',
    fields: [
      {
        key: 'routingKey',
        label: 'Routing key',
        type: 'password',
        required: true,
        help: 'Must appear in the x-routing-key header on every callback.',
      },
      {
        key: 'deviceKeyField',
        label: 'Device key field',
        type: 'text',
        default: 'device',
        help: 'Sigfox sends the device ID as "device" by default.',
      },
      { key: 'dataField', label: 'Payload field', type: 'text', default: 'data' },
    ],
  },

  // ── Generic buckets kept for backwards compatibility ───────────────────────
  [IntegrationType.CLOUD]: {
    type: IntegrationType.CLOUD,
    label: 'Generic Cloud',
    category: 'other',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Legacy catch-all. Prefer a named provider — the dispatcher has to guess which adapter to use from the configuration keys.',
    icon: 'Cloud',
    hasAdapter: true,
    adapterNote:
      'Resolved by inspecting the configuration: an accessKeyId or endpoint routes to AWS IoT, a clientId plus clientSecret routes to Tuya. Anything else is not dispatched.',
    defaultProtocol: 'HTTPS',
    fields: [],
  },

  [IntegrationType.NOTIFICATION]: {
    type: IntegrationType.NOTIFICATION,
    label: 'Notification',
    category: 'other',
    direction: IntegrationDirection.OUTBOUND,
    description:
      'Placeholder type with no adapter. Use the Notifications module for alerting instead.',
    icon: 'Bell',
    hasAdapter: false,
    adapterNote:
      'No adapter — telemetry is not forwarded. Notifications are configured under Notifications, not here.',
    defaultProtocol: 'HTTPS',
    fields: [],
  },

  [IntegrationType.DATABASE]: {
    type: IntegrationType.DATABASE,
    label: 'External Database',
    category: 'other',
    direction: IntegrationDirection.OUTBOUND,
    description: 'Placeholder type with no adapter.',
    icon: 'Database',
    hasAdapter: false,
    adapterNote:
      'No adapter — telemetry is not forwarded. Use a webhook or Kafka into your own pipeline instead.',
    defaultProtocol: 'TCP',
    fields: [],
  },
};

/** Manifests in the order the UI should offer them: usable types first. */
export const listCatalogue = (): IntegrationTypeManifest[] =>
  Object.values(INTEGRATION_CATALOGUE).sort((a, b) => {
    // A type with no adapter and no inbound path cannot do anything yet, so it
    // sinks to the bottom rather than sitting between two working options.
    const usable = (manifest: IntegrationTypeManifest) =>
      manifest.hasAdapter || manifest.inboundPath ? 0 : 1;
    const byUsable = usable(a) - usable(b);
    if (byUsable !== 0) return byUsable;
    return a.label.localeCompare(b.label);
  });

/** True when telemetry should be forwarded to integrations of this type. */
export const isOutboundType = (type: IntegrationType): boolean => {
  const direction = INTEGRATION_CATALOGUE[type]?.direction;
  return (
    direction === IntegrationDirection.OUTBOUND ||
    direction === IntegrationDirection.BIDIRECTIONAL
  );
};

/**
 * True when a reading is worth handing to the dispatcher at all.
 *
 * Outbound AND backed by an adapter. The second half matters because
 * `notification` and `database` are declared outbound but have no adapter: the
 * dispatcher resolves nothing, returns early, and logs
 * "No adapter for integration type" — once per reading, per row. On a tenant
 * with 100 devices reporting each minute and one `database` row, that is
 * 144,000 warning lines a day about a decision that could have been made here.
 *
 * CLOUD stays in: it declares an adapter and resolves one dynamically from its
 * configuration keys.
 */
export const isDispatchableType = (type: IntegrationType): boolean =>
  isOutboundType(type) && INTEGRATION_CATALOGUE[type]?.hasAdapter === true;

/** True when this type receives data from outside. */
export const isInboundType = (type: IntegrationType): boolean => {
  const direction = INTEGRATION_CATALOGUE[type]?.direction;
  return (
    direction === IntegrationDirection.INBOUND ||
    direction === IntegrationDirection.BIDIRECTIONAL
  );
};

/**
 * Validate a configuration against its type's manifest.
 *
 * Returns messages rather than throwing so the caller decides the status code
 * and can report every problem at once — a form that fixes one missing field
 * per round trip is miserable to use.
 *
 * Only declared fields are checked. Extra keys are allowed on purpose: the
 * entity's `configuration` is a free jsonb column and several types grew
 * undeclared keys over time (`payloadTemplate`, `applicationId`); rejecting
 * them would break existing rows on their next edit.
 */
export const validateIntegrationConfig = (
  type: IntegrationType,
  configuration: Record<string, unknown> | undefined | null,
): string[] => {
  const manifest = INTEGRATION_CATALOGUE[type];
  if (!manifest) return [`Unknown integration type "${type}"`];

  const config = configuration ?? {};
  const errors: string[] = [];

  for (const field of manifest.fields) {
    // A hidden field is not being asked for, so it cannot be required.
    if (field.showIf) {
      const governing = config[field.showIf.key];
      if (!field.showIf.equals.includes(governing as never)) continue;
    }

    const value = config[field.key];
    const isEmpty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '');

    if (field.required && isEmpty) {
      errors.push(`${manifest.label}: "${field.label}" is required`);
      continue;
    }
    if (isEmpty) continue;

    if (field.type === 'number') {
      const numeric = typeof value === 'string' ? Number(value) : value;
      if (typeof numeric !== 'number' || Number.isNaN(numeric)) {
        errors.push(`"${field.label}" must be a number`);
        continue;
      }
      if (field.min !== undefined && numeric < field.min) {
        errors.push(`"${field.label}" must be at least ${field.min}`);
      }
      if (field.max !== undefined && numeric > field.max) {
        errors.push(`"${field.label}" must be at most ${field.max}`);
      }
    }

    if (field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`"${field.label}" must be true or false`);
    }

    if (field.type === 'select' && field.options?.length) {
      const allowed = field.options.map((option) => option.value);
      if (!allowed.includes(String(value))) {
        errors.push(`"${field.label}" must be one of: ${allowed.join(', ')}`);
      }
    }
  }

  return errors;
};
