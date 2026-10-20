// src/modules/protocols/lwm2m/lwm2m.scope.ts
//
// The honest scope of this platform's LwM2M support, in one place, so that the
// backend, the API docs and the frontend all read the same list instead of
// each guessing.
//
// This exists because the opposite was already true once: `LWM2M` was a
// selectable transportType on a device profile, with defaults that mentioned
// `observeOnConnect` and `bootstrapServerUpdateEnabled`, and absolutely no
// server behind it. A profile set to LWM2M received nothing, forever, with no
// indication that anything was missing. Half a transport that advertises
// itself as whole is worse than no transport, so what is implemented and what
// is not is declared here as data and served over the API.

/** One LwM2M interface/operation and whether this platform implements it. */
export interface Lwm2mCapability {
  /** LwM2M interface name, as used in the OMA specification. */
  interface:
    | 'Bootstrap'
    | 'Client Registration'
    | 'Device Management and Service Enablement'
    | 'Information Reporting'
    | 'Security';
  /** The specific operation. */
  operation: string;
  supported: boolean;
  /** Where it is reachable, when it is supported. */
  endpoint?: string;
  /** Why it is not supported / what the caller should do instead. */
  note: string;
}

/**
 * LwM2M version this server speaks on the registration interface.
 * 1.0 registration semantics; clients announcing 1.1 are accepted because
 * registration is backwards compatible, but no 1.1-only feature is used.
 */
export const LWM2M_SERVER_VERSION = '1.0';

export const LWM2M_CAPABILITIES: Lwm2mCapability[] = [
  // ── Implemented ─────────────────────────────────────────────────────────
  {
    interface: 'Client Registration',
    operation: 'Register',
    supported: true,
    endpoint: 'POST coap://<host>:5683/rd?ep=<endpointName>&lt=<lifetime>&b=<binding>',
    note:
      'The endpoint name must equal an existing device\'s deviceKey. Unknown ' +
      'endpoints are rejected with 4.03 — this server never auto-provisions a ' +
      'device from a registration.',
  },
  {
    interface: 'Client Registration',
    operation: 'Update',
    supported: true,
    endpoint: 'POST coap://<host>:5683/rd/<registrationId>',
    note:
      'Refreshes the registration lifetime. lt, b and the object links may be ' +
      'updated. A registration that is not updated within its lifetime ' +
      '(plus a short grace period) expires and the device is marked offline.',
  },
  {
    interface: 'Client Registration',
    operation: 'De-register',
    supported: true,
    endpoint: 'DELETE coap://<host>:5683/rd/<registrationId>',
    note: 'Removes the registration and marks the device offline immediately.',
  },
  {
    interface: 'Information Reporting',
    operation: 'Send',
    supported: true,
    endpoint: 'POST coap://<host>:5683/dp?ep=<endpointName>',
    note:
      'Client-initiated reporting. SenML JSON (content-format 110) is parsed; ' +
      'a plain JSON object of key/value pairs is also accepted. Readings are ' +
      'handed to DeviceListenerService.handleTelemetry(), the same path MQTT ' +
      'and HTTP use, so they get codec decode, alarm evaluation and WebSocket ' +
      'broadcast. SenML CBOR and TLV are not parsed.',
  },

  // ── Deliberately NOT implemented ────────────────────────────────────────
  {
    interface: 'Information Reporting',
    operation: 'Observe / Notify / Cancel Observation',
    supported: false,
    note:
      'NOT IMPLEMENTED. The server never issues an Observe, so a device will ' +
      'not receive one and will never send Notify messages. ' +
      'DeviceProfile.transportConfiguration.lwm2m.observeOnConnect is ' +
      'therefore inert — it is stored but nothing reads it. Use Send (POST ' +
      '/dp) for client-initiated reporting instead.',
  },
  {
    interface: 'Device Management and Service Enablement',
    operation: 'Read / Write / Execute / Create / Delete / Write-Attributes / Discover',
    supported: false,
    note:
      'NOT IMPLEMENTED. No server-initiated operation is sent to the client, ' +
      'so object values cannot be read or written on demand and resources ' +
      'cannot be executed. The object links reported at registration are ' +
      'recorded for visibility only. Device commands must go over a transport ' +
      'that does support downlink (MQTT or CoAP RPC).',
  },
  {
    interface: 'Bootstrap',
    operation: 'Bootstrap-Request / Bootstrap-Write / Bootstrap-Finish',
    supported: false,
    note:
      'NOT IMPLEMENTED. There is no bootstrap server. Clients must be ' +
      'pre-configured with this server\'s address, and the device must already ' +
      'exist on the platform with a matching deviceKey. ' +
      'DeviceProfile.transportConfiguration.lwm2m.bootstrapServerUpdateEnabled ' +
      'is inert.',
  },
  {
    interface: 'Security',
    operation: 'DTLS (PSK / RPK / X.509)',
    supported: false,
    note:
      'NOT IMPLEMENTED. The CoAP server listens on plaintext UDP 5683 only; ' +
      'there is no coaps:// listener on 5684. Registration IS now ' +
      'credential-checked — the endpoint name must be a valid device ' +
      'ACCESS_TOKEN, resolved through DeviceAuthService, and a bare deviceKey ' +
      'is refused unless DEVICE_AUTH_ENFORCED=false — but the token travels ' +
      'in CLEAR TEXT over UDP and is replayable by anyone on the path. Run ' +
      'this on a trusted network or behind a DTLS-terminating gateway; do not ' +
      'treat LwM2M identity here as a transport security boundary.',
  },
  {
    interface: 'Security',
    operation: 'Registration credential check',
    supported: true,
    note:
      'IMPLEMENTED. The LwM2M endpoint name (?ep=) is treated as a ' +
      'credential and resolved through DeviceAuthService, the same verifier ' +
      'the HTTP and CoAP ingest paths use. The resolved deviceId is persisted ' +
      'on the registration, so Update / Send / De-register are bound to the ' +
      'device that authenticated rather than re-trusting an endpoint name. ' +
      'Without DTLS this is replay-protection-free: see the DTLS row.',
  },
  {
    interface: 'Client Registration',
    operation: 'Queue Mode',
    supported: false,
    note:
      'NOT IMPLEMENTED. Queue mode only matters for server-initiated ' +
      'operations, which are out of scope, so a client announcing binding "UQ" ' +
      'is accepted and treated as "U".',
  },
];

/** Machine-readable summary for the frontend transport-capability panel. */
export const LWM2M_SCOPE_SUMMARY = {
  transport: 'LWM2M' as const,
  serverVersion: LWM2M_SERVER_VERSION,
  // False means TRANSPORT security: there is no DTLS. Registration is
  // credential-checked (see `registrationAuthenticated`), but the credential
  // is sent in clear over UDP, so this stays false.
  secure: false,
  registrationAuthenticated: true,
  coapPort: 5683,
  /**
   * Registrations are rows in `lwm2m_registrations`, so they survive a
   * restart and are the same on every replica. They used to live in two
   * in-process Maps, which meant a deploy silently dropped the whole fleet's
   * registrations until each client's lifetime elapsed.
   */
  registrationStorage: 'database (lwm2m_registrations)' as const,
  supported: [
    'Register (credential-checked)',
    'Update',
    'De-register',
    'Send (SenML JSON)',
    'Durable registrations across restarts and replicas',
  ],
  notSupported: [
    'Observe / Notify',
    'Server-initiated Read / Write / Execute',
    'Bootstrap',
    'DTLS / coaps://',
    'SenML CBOR / TLV payloads',
    'Queue Mode',
  ],
  summary:
    'Registration and client-initiated reporting only. Nothing is ever sent ' +
    'down to an LwM2M client; it cannot be read, written or commanded. ' +
    'Registration requires a device credential, but there is no DTLS, so the ' +
    'credential is in clear on the wire — put this port on a trusted network.',
};
