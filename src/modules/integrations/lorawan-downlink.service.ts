// src/modules/integrations/lorawan-downlink.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { Integration } from './entities/integration.entity';
import { Device, DeviceProtocol } from '@modules/devices/entities/device.entity';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import { IntegrationEventsService } from './integration-events.service';
import {
  IntegrationEventDirection,
  IntegrationEventType,
} from './entities/integration-event.entity';

/**
 * What a caller asks to be sent down to a LoRaWAN device.
 *
 * A LoRaWAN downlink is three things and nothing else: a byte array, the port
 * the application layer listens on, and whether the network should ask the
 * device to acknowledge it. There is no "method" and no "params" at this
 * level — that is a codec concern, resolved before this service is reached.
 */
export interface LorawanDownlinkRequest {
  /** The frame payload, base64. This is the wire format both network servers take. */
  data: string;
  /** Application port, 1–223. 0 is reserved for MAC commands and 224+ for tests. */
  fPort: number;
  /**
   * Confirmed downlinks make the device ACK, which costs it an uplink slot and
   * airtime. Default false, matching both network servers' own defaults.
   */
  confirmed?: boolean;
  /** Free-text tag carried to the network server for correlation in its own logs. */
  reference?: string;
}

export interface LorawanDownlinkResult {
  success: boolean;
  network: 'chirpstack' | 'ttn';
  /** The network server's own queue item / correlation id, when it returns one. */
  queueItemId?: string;
  /** HTTP status from the network server. */
  statusCode?: number;
  /** Endpoint the request went to, so a 404 can be diagnosed without guessing. */
  endpoint: string;
  message: string;
  devEUI: string;
  fPort: number;
  confirmed: boolean;
}

/** Thrown for every failure: a bad configuration, a missing device identity, or a rejected request. */
export class LorawanDownlinkError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LorawanDownlinkError';
  }
}

/** 0 is MAC-layer, 224–255 are the certification test ports. */
const MIN_FPORT = 1;
const MAX_FPORT = 223;

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Queues a downlink to a ChirpStack or The Things Stack device.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `LorawanService` handled uplinks from both network servers and there was no
 * path in the other direction at all. A LoRaWAN actuator — a valve, a relay, a
 * display, a sensor whose reporting interval you want to change — was
 * therefore permanently read-only: `GatewayService.sendCommand()` fell through
 * to its generic branch and published to `milesight/downlink/<devEUI>` on this
 * platform's own broker, which no ChirpStack or TTN deployment subscribes to.
 * The publish succeeded, the command row went DELIVERED, and nothing reached
 * the device. That is the worst shape of failure: it reports success.
 *
 * ── A downlink is QUEUED, not sent ──────────────────────────────────────────
 * This is the single most important thing to understand about the result of
 * this service, and why no method here claims the device received anything.
 * A Class A device — which is almost every battery LoRaWAN sensor — can only
 * receive in the two short windows that follow an uplink it chose to send. The
 * network server therefore holds the frame in a per-device queue and transmits
 * it after the device's next uplink, which may be seconds away or, for a
 * device reporting every six hours, most of a day. HTTP 200 from either
 * network server means "accepted into the queue", and that is exactly what
 * `success: true` here means.
 *
 * Downlink delivery confirmation (even for `confirmed: true`) arrives
 * asynchronously as a separate ChirpStack `ack` event or TTN
 * `downlink_ack`/`downlink_failed` message on the webhook. Those are not wired
 * up — see the note at the end of this comment.
 *
 * ── Credentials come from the integration row, not the environment ──────────
 * Each network server is reached with the API token held in its own
 * `Integration.configuration`, so two tenants can point at two different
 * ChirpStack deployments and a tenant can be cut off by disabling its row. The
 * integration is resolved from the device: `device.metadata.integrationId`
 * first (set when the device was auto-provisioned from an uplink), then the
 * tenant's single ACTIVE integration of the matching network type.
 *
 * ── Not implemented ─────────────────────────────────────────────────────────
 *  · **No ack correlation.** ChirpStack's `ack` event and TTN's
 *    `downlink_ack` / `downlink_failed` / `downlink_nack` messages are not
 *    consumed, so a queued downlink's terminal fate is not recorded. The
 *    device-command row reflects "queued at the network server" and says so.
 *  · **No queue inspection or flush.** Both servers expose the pending queue
 *    (`GET`/`DELETE .../queue`); nothing here reads or clears it, so a device
 *    that has been offline for a week accumulates downlinks at its network
 *    server rather than having stale ones dropped.
 */
@Injectable()
export class LorawanDownlinkService {
  private readonly logger = new Logger(LorawanDownlinkService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    private readonly events: IntegrationEventsService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════════════════

  /** True when this protocol is one this service can carry a downlink for. */
  static handles(protocol?: string | null): boolean {
    return (
      protocol === DeviceProtocol.LORAWAN_CHIRPSTACK ||
      protocol === DeviceProtocol.LORAWAN_TTN
    );
  }

  /**
   * Queue a downlink for a device.
   *
   * Throws `LorawanDownlinkError` on every failure rather than returning a
   * falsy result, because the two callers — `GatewayService.sendCommand()` and
   * through it `DeviceCommandsConsumer` — both treat a thrown error as "this
   * command failed" and a return as "it was accepted". A soft failure here
   * would mark a command DELIVERED that never left the host, which is the bug
   * this service was written to remove.
   */
  async enqueue(
    device: Device,
    request: LorawanDownlinkRequest,
  ): Promise<LorawanDownlinkResult> {
    const network =
      device.protocol === DeviceProtocol.LORAWAN_TTN ? 'ttn' : 'chirpstack';

    const devEUI = this.resolveDevEUI(device);
    const fPort = this.validateFPort(request.fPort);
    const data = this.validateBase64(request.data);
    const confirmed = request.confirmed === true;

    const integration = await this.resolveIntegration(device, network);
    const started = Date.now();

    try {
      const result =
        network === 'ttn'
          ? await this.enqueueTtn(integration, device, devEUI, {
              data,
              fPort,
              confirmed,
              reference: request.reference,
            })
          : await this.enqueueChirpStack(integration, devEUI, {
              data,
              fPort,
              confirmed,
              reference: request.reference,
            });

      this.events.record({
        integrationId: integration.id,
        tenantId: integration.tenantId,
        direction: IntegrationEventDirection.OUTBOUND,
        eventType: IntegrationEventType.DOWNLINK,
        success: true,
        message: result.message,
        deviceId: device.id,
        deviceKey: device.deviceKey,
        statusCode: result.statusCode ?? null,
        durationMs: Date.now() - started,
        payload: { devEUI, fPort, confirmed, bytes: this.byteLength(data) },
      });

      this.logger.log(
        `Downlink queued at ${network} for ${devEUI} ` +
          `(fPort ${fPort}${confirmed ? ', confirmed' : ''}, ${this.byteLength(data)} bytes)`,
      );

      return result;
    } catch (error) {
      const message = (error as Error).message;
      const statusCode =
        error instanceof LorawanDownlinkError ? error.statusCode : undefined;

      this.events.record({
        integrationId: integration.id,
        tenantId: integration.tenantId,
        direction: IntegrationEventDirection.OUTBOUND,
        eventType: IntegrationEventType.DOWNLINK,
        success: false,
        message,
        deviceId: device.id,
        deviceKey: device.deviceKey,
        statusCode: statusCode ?? null,
        durationMs: Date.now() - started,
        payload: { devEUI, fPort, confirmed },
      });

      throw error instanceof LorawanDownlinkError
        ? error
        : new LorawanDownlinkError(message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CHIRPSTACK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * `POST {serverUrl}/api/devices/{devEUI}/queue`.
   *
   * Two wire formats, selected by `configuration.apiVersion`:
   *
   *   v4 → `{ queueItem:   { devEui, fPort, confirmed, data } }`
   *   v3 → `{ deviceQueueItem: { devEUI, fPort, confirmed, data } }`
   *
   * The key AND the casing of the EUI field both changed between the two major
   * versions, and ChirpStack answers a wrong-shaped body with a 400 naming
   * neither — so this is declared configuration rather than sniffed. v4 is the
   * default because v3 has been end-of-life since 2023.
   *
   * Authentication is `Grpc-Metadata-Authorization: Bearer <token>`, NOT a
   * plain `Authorization` header: ChirpStack's REST surface is a grpc-gateway
   * transcoding, and it reads credentials out of the `Grpc-Metadata-` prefix.
   * A token sent as `Authorization` is silently ignored and the request comes
   * back 401 as if the token were wrong.
   */
  private async enqueueChirpStack(
    integration: Integration,
    devEUI: string,
    request: Required<Pick<LorawanDownlinkRequest, 'data' | 'fPort' | 'confirmed'>> &
      Pick<LorawanDownlinkRequest, 'reference'>,
  ): Promise<LorawanDownlinkResult> {
    const config = (integration.configuration ?? {}) as Record<string, any>;
    const serverUrl = this.requireConfig(
      config.serverUrl,
      integration,
      'serverUrl',
      'the ChirpStack API base URL, e.g. https://chirpstack.example.com:8080',
    );
    const apiToken = this.requireConfig(
      config.apiToken,
      integration,
      'apiToken',
      'a ChirpStack API key (Tenant → API keys)',
    );
    const version = String(config.apiVersion ?? 'v4').toLowerCase();
    const endpoint = `${this.trimSlash(serverUrl)}/api/devices/${devEUI}/queue`;

    const body =
      version === 'v3'
        ? {
            deviceQueueItem: {
              devEUI,
              fPort: request.fPort,
              confirmed: request.confirmed,
              data: request.data,
            },
          }
        : {
            queueItem: {
              devEui: devEUI,
              fPort: request.fPort,
              confirmed: request.confirmed,
              data: request.data,
            },
          };

    const response = await this.post(endpoint, body, {
      'Grpc-Metadata-Authorization': `Bearer ${apiToken}`,
    }, config);

    // v4 returns {id}; v3 returns {fCnt}. Neither is a delivery receipt.
    const queueItemId =
      response.data?.id ??
      (response.data?.fCnt !== undefined ? String(response.data.fCnt) : undefined);

    return {
      success: true,
      network: 'chirpstack',
      queueItemId,
      statusCode: response.status,
      endpoint,
      devEUI,
      fPort: request.fPort,
      confirmed: request.confirmed,
      message:
        'Accepted into the ChirpStack downlink queue. For a Class A device it ' +
        'is transmitted after the next uplink, not now.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE THINGS STACK
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * `POST {base}/api/v3/as/applications/{appId}/devices/{deviceId}/down/push`.
   *
   * Three things about this endpoint are easy to get wrong:
   *
   *  1. **It addresses the device by TTN `device_id`, not by DevEUI.** The
   *     device id is the user-chosen slug in the TTS console. It is captured
   *     into `device.metadata.lorawanDeviceId` from the uplink envelope
   *     (`end_device_ids.device_id`), which is why a device that has never
   *     sent an uplink cannot be reached — stated plainly in the error rather
   *     than guessed at, because guessing produces a 404 from TTN that reads
   *     as "no such application".
   *  2. **`push` vs `replace`.** `push` appends to the device's queue;
   *     `replace` discards whatever is queued. `push` is used because
   *     discarding a downlink the operator queued a minute ago is not a
   *     decision this layer gets to make. `configuration.downlinkMode` selects
   *     `replace` for the "latest value wins" case.
   *  3. **The host is cluster-specific.** `eu1.cloud.thethings.network` and
   *     `nam1...` are different deployments with different data; an API key
   *     from one is invalid on the other. `configuration.apiBaseUrl` takes a
   *     full URL, or `configuration.cluster` names the cluster for the public
   *     Community/Cloud hosts.
   */
  private async enqueueTtn(
    integration: Integration,
    device: Device,
    devEUI: string,
    request: Required<Pick<LorawanDownlinkRequest, 'data' | 'fPort' | 'confirmed'>> &
      Pick<LorawanDownlinkRequest, 'reference'>,
  ): Promise<LorawanDownlinkResult> {
    const config = (integration.configuration ?? {}) as Record<string, any>;
    const apiKey = this.requireConfig(
      config.apiKey,
      integration,
      'apiKey',
      'a TTS API key with the "write downlink" right',
    );
    const applicationId = this.requireConfig(
      config.applicationId,
      integration,
      'applicationId',
      'the TTS application id that owns this device',
    );

    const base = config.apiBaseUrl
      ? this.trimSlash(String(config.apiBaseUrl))
      : `https://${String(config.cluster ?? 'eu1')}.cloud.thethings.network`;

    const deviceId = this.resolveTtnDeviceId(device);
    const mode = String(config.downlinkMode ?? 'push').toLowerCase() === 'replace'
      ? 'replace'
      : 'push';

    const endpoint =
      `${base}/api/v3/as/applications/${encodeURIComponent(applicationId)}` +
      `/devices/${encodeURIComponent(deviceId)}/down/${mode}`;

    const body = {
      downlinks: [
        {
          frm_payload: request.data,
          f_port: request.fPort,
          confirmed: request.confirmed,
          priority: String(config.downlinkPriority ?? 'NORMAL').toUpperCase(),
          ...(request.reference && {
            correlation_ids: [`platform:${request.reference}`],
          }),
        },
      ],
    };

    const response = await this.post(endpoint, body, {
      Authorization: `Bearer ${apiKey}`,
    }, config);

    return {
      success: true,
      network: 'ttn',
      statusCode: response.status,
      endpoint,
      devEUI,
      fPort: request.fPort,
      confirmed: request.confirmed,
      message:
        `Accepted into The Things Stack downlink queue (${mode}) for device ` +
        `"${deviceId}". For a Class A device it is transmitted after the next ` +
        'uplink, not now.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED
  // ══════════════════════════════════════════════════════════════════════════

  private async post(
    endpoint: string,
    body: unknown,
    headers: Record<string, string>,
    config: Record<string, any>,
  ): Promise<{ status: number; data: any }> {
    try {
      const response = await axios.post(endpoint, body, {
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: Number(config.timeout) > 0 ? Number(config.timeout) : DEFAULT_TIMEOUT_MS,
        // The network server's own error body is the only useful diagnostic
        // for a 400 — ChirpStack names the offending field there and nowhere
        // else — so every status is resolved and the body is read below rather
        // than letting axios throw it away.
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, data: response.data };
      }

      throw new LorawanDownlinkError(
        `Network server rejected the downlink (HTTP ${response.status}): ` +
          this.describeBody(response.data),
        response.status,
      );
    } catch (error: any) {
      if (error instanceof LorawanDownlinkError) throw error;
      // A connection-level failure — DNS, TLS, refused, timed out. The
      // endpoint is included because the single most common cause is a
      // serverUrl or cluster that points at nothing.
      throw new LorawanDownlinkError(
        `Could not reach ${endpoint}: ${error?.message ?? 'unknown transport error'}` +
          (error?.response?.status ? ` (HTTP ${error.response.status})` : ''),
        error?.response?.status,
      );
    }
  }

  private describeBody(data: unknown): string {
    if (!data) return 'no response body';
    if (typeof data === 'string') return data.slice(0, 500);
    const asRecord = data as Record<string, any>;
    const message =
      asRecord.message ?? asRecord.error ?? asRecord.message_format ?? null;
    if (typeof message === 'string') return message.slice(0, 500);
    try {
      return JSON.stringify(data).slice(0, 500);
    } catch {
      return 'unreadable response body';
    }
  }

  /**
   * The integration that holds this device's network-server credentials.
   *
   * `metadata.integrationId` is tried first and still verified against the
   * device's tenant and the expected network type: the id is stored on the
   * device row, and a device that was moved between tenants or whose
   * integration was replaced must not reach the old one's credentials.
   */
  private async resolveIntegration(
    device: Device,
    network: 'chirpstack' | 'ttn',
  ): Promise<Integration> {
    const type =
      network === 'ttn' ? IntegrationType.TTN : IntegrationType.CHIRPSTACK;

    const integrationId = device.metadata?.integrationId as string | undefined;
    if (integrationId) {
      const pinned = await this.integrationRepository.findOne({
        where: {
          id: integrationId,
          tenantId: device.tenantId,
          type,
          status: IntegrationStatus.ACTIVE,
          enabled: true,
        },
      });
      if (pinned) return pinned;
    }

    const candidates = await this.integrationRepository.find({
      where: {
        tenantId: device.tenantId,
        type,
        status: IntegrationStatus.ACTIVE,
        enabled: true,
      },
    });

    if (candidates.length === 1) return candidates[0];

    if (candidates.length === 0) {
      throw new LorawanDownlinkError(
        `Device ${device.deviceKey} is a ${network} device but this tenant has ` +
          `no active ${type} integration, so there are no credentials to queue ` +
          'a downlink with. Add one under Integrations.',
      );
    }

    // Pick by applicationId when the device recorded one on its first uplink.
    const applicationId = device.metadata?.lorawanApplicationId as
      | string
      | undefined;
    if (applicationId) {
      const matched = candidates.filter(
        (candidate) =>
          (candidate.configuration as any)?.applicationId === applicationId,
      );
      if (matched.length === 1) return matched[0];
    }

    throw new LorawanDownlinkError(
      `This tenant has ${candidates.length} active ${type} integrations and ` +
        `device ${device.deviceKey} does not say which one it belongs to. ` +
        'Set the Application ID on each integration, or re-provision the device ' +
        'so its metadata records its integration.',
    );
  }

  private resolveDevEUI(device: Device): string {
    const devEUI =
      (device.metadata?.devEUI as string | undefined) ?? device.deviceKey;
    if (!devEUI || !/^[0-9a-fA-F]{16}$/.test(devEUI)) {
      throw new LorawanDownlinkError(
        `Device ${device.deviceKey} has no usable DevEUI ` +
          `(metadata.devEUI=${device.metadata?.devEUI ?? 'unset'}). A LoRaWAN ` +
          'downlink is addressed by DevEUI, so there is nothing to send it to.',
      );
    }
    return devEUI.toLowerCase();
  }

  /**
   * TTN addresses devices by their console `device_id`, which is captured from
   * the uplink envelope. There is deliberately NO fall back to the DevEUI: the
   * two are different identifiers, and `.../devices/0011223344556677/down/push`
   * resolves to no device and answers 404 — a failure that reads like a wrong
   * application id and sends the reader looking in the wrong place.
   */
  private resolveTtnDeviceId(device: Device): string {
    const deviceId = device.metadata?.lorawanDeviceId as string | undefined;
    if (deviceId && typeof deviceId === 'string' && deviceId.trim()) {
      return deviceId.trim();
    }
    throw new LorawanDownlinkError(
      `Device ${device.deviceKey} has no TTN device id recorded ` +
        '(metadata.lorawanDeviceId). It is captured from the device’s first ' +
        'uplink; a device that has never reported cannot be addressed, because ' +
        'The Things Stack downlink API takes the console device id, not the DevEUI.',
    );
  }

  private validateFPort(fPort: unknown): number {
    const port = Number(fPort);
    if (!Number.isInteger(port) || port < MIN_FPORT || port > MAX_FPORT) {
      throw new LorawanDownlinkError(
        `fPort must be an integer between ${MIN_FPORT} and ${MAX_FPORT} ` +
          `(got ${String(fPort)}). 0 is reserved for MAC commands and 224+ for ` +
          'certification tests, so neither can carry application data.',
      );
    }
    return port;
  }

  /**
   * Both network servers take the frame as base64 and answer a malformed one
   * with an opaque 400, so it is checked here where the message can say what
   * is wrong. A decode/re-encode round trip rejects strings `Buffer` would
   * otherwise accept leniently and silently truncate — `Buffer.from` ignores
   * every character outside the base64 alphabet, so `"AQID!!"` becomes two
   * bytes rather than an error.
   *
   * What this canNOT catch: a hex payload whose length is a multiple of four,
   * such as `"01020304"`. Every character is in the base64 alphabet, so it is
   * genuinely valid base64 — of different bytes than the author meant. There
   * is no way to tell the two apart from the string alone, which is exactly
   * why `GatewayService.buildLorawanDownlink()` accepts `params.hex` as a
   * separate field and converts it, rather than guessing at the encoding.
   */
  private validateBase64(data: unknown): string {
    if (typeof data !== 'string' || !data.length) {
      throw new LorawanDownlinkError(
        'A downlink needs a base64 `data` payload; none was given.',
      );
    }
    const normalised = data.trim();
    if (Buffer.from(normalised, 'base64').toString('base64') !== normalised) {
      throw new LorawanDownlinkError(
        '`data` is not valid base64. A LoRaWAN downlink payload is the raw ' +
          'frame bytes, base64-encoded — not hex and not JSON.',
      );
    }
    if (this.byteLength(normalised) > 242) {
      // The absolute ceiling across every region and data rate. The usable
      // limit is often 51 bytes (DR0), and the network server fragments
      // nothing — an oversized frame is dropped at transmit time, silently.
      throw new LorawanDownlinkError(
        `Downlink payload is ${this.byteLength(normalised)} bytes. No LoRaWAN ` +
          'region allows more than 242, and at the slowest data rate the limit ' +
          'is 51 — an oversized frame is dropped at transmit time without an error.',
      );
    }
    return normalised;
  }

  private byteLength(base64: string): number {
    return Buffer.from(base64, 'base64').byteLength;
  }

  private requireConfig(
    value: unknown,
    integration: Integration,
    key: string,
    describe: string,
  ): string {
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new LorawanDownlinkError(
      `Integration "${integration.name}" is missing \`${key}\` — ${describe}. ` +
        'Uplinks work without it; a downlink cannot, because there is no API ' +
        'endpoint or credential to queue it against.',
    );
  }

  private trimSlash(url: string): string {
    return url.replace(/\/+$/, '');
  }
}
