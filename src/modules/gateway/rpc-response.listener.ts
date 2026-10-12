// src/modules/gateway/rpc-response.listener.ts
//
// The half of two-way RPC that was missing: something that listens on the
// response topic.
//
// `GatewayService.sendRpcRequest()` published to
// `devices/{deviceKey}/rpc/request` and nothing anywhere subscribed to any
// response topic, so the API answered "RPC request sent" whether the device
// executed the command, rejected it, or was unplugged. This closes the loop.
//
// ── Why its own MQTT client ───────────────────────────────────────────────
// `lib/mqtt/MQTTService` is deliberately the single client for device UPLINKS:
// every message it receives is routed into
// `DeviceListenerService.handleTelemetry()`. Adding `devices/+/rpc/response`
// to its subscription list would push RPC responses through the telemetry
// pipeline — codec decode, Kafka, alarm evaluation — which is wrong, and
// MQTTService exposes no per-topic handler hook to avoid that.
//
// So this is a second, narrowly scoped client: subscribe-only, one topic
// pattern, no publish, no telemetry handling. That is the same shape as the
// existing `IntegrationMqttInboundService`, and it is not the duplicate-client
// problem CLAUDE.md warns about (a second *ingestion* client that would
// double-process every uplink).

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as mqtt from 'mqtt';
import mqttConfig from '../../config/mqtt.config';
import { RpcCorrelatorService } from '@modules/protocols/rpc-correlator.service';

/**
 * Topic the device publishes its RPC answer to. `{deviceKey}` is segment 2,
 * matching the request topic `devices/{deviceKey}/rpc/request` that
 * GatewayService publishes to.
 */
const RPC_RESPONSE_TOPIC = 'devices/+/rpc/response';

@Injectable()
export class RpcResponseListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RpcResponseListener.name);
  private client: mqtt.MqttClient | null = null;
  private readonly enabled: boolean;

  constructor(
    @Inject(mqttConfig.KEY)
    private readonly config: ConfigType<typeof mqttConfig>,
    private readonly correlator: RpcCorrelatorService,
  ) {
    this.enabled = process.env.GATEWAY_RPC_LISTENER_ENABLED !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'RPC response listener disabled (GATEWAY_RPC_LISTENER_ENABLED=false) — ' +
          'every two-way RPC will time out.',
      );
      return;
    }
    this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Pending callers are settled by RpcCorrelatorService.onModuleDestroy;
    // here we just let go of the socket.
    if (this.client) {
      try {
        await this.client.endAsync(true);
      } catch (error) {
        this.logger.warn(
          `Error closing RPC response client: ${(error as Error).message}`,
        );
      }
      this.client = null;
    }
  }

  private connect(): void {
    // MQTT requires unique client ids; a duplicate makes two replicas kick
    // each other off in a loop. Same uniquifying as MQTTService.
    const clientId = `${this.config.clientId ?? 'smartlife-platform'}-rpc-${process.pid}-${Date.now()}`;

    this.client = mqtt.connect(this.config.brokerUrl!, {
      clientId,
      username: this.config.username,
      password: this.config.password,
      clean: true,
      keepalive: this.config.keepAlive,
      connectTimeout: this.config.connectTimeout,
      reconnectPeriod: this.config.reconnectPeriod,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
    });

    this.client.on('connect', () => {
      this.client!.subscribe(
        RPC_RESPONSE_TOPIC,
        { qos: this.config.qos ?? 1 },
        (error) => {
          if (error) {
            this.logger.error(
              `Failed to subscribe to ${RPC_RESPONSE_TOPIC}: ${error.message} — two-way RPC will time out`,
            );
          } else {
            this.logger.log(`RPC responses subscribed → ${RPC_RESPONSE_TOPIC}`);
          }
        },
      );
    });

    this.client.on('message', (topic, payload) => {
      this.handleResponse(topic, payload);
    });

    this.client.on('error', (error) =>
      this.logger.error(`RPC response client error: ${error.message}`),
    );

    this.client.on('close', () => {
      // A dropped connection means any response published while we were away
      // is gone — MQTT has no replay for a clean session. Leaving those
      // requests in the map until their individual timeouts would report
      // "timeout" for requests the device may well have answered, and would
      // keep the map populated for up to the timeout window on every blip.
      // Failing them now is both faster and more truthful.
      const cancelled = this.correlator.cancelAll(
        'MQTT connection to the broker dropped before the device responded',
      );
      if (cancelled > 0) {
        this.logger.warn(
          `RPC response connection closed — ${cancelled} pending request(s) failed`,
        );
      }
    });
  }

  /** `devices/{deviceKey}/rpc/response` → correlate by the request id. */
  private handleResponse(topic: string, raw: Buffer): void {
    const segments = topic.split('/');
    const deviceKey = segments[1];

    let payload: any;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn(
        `RPC response on ${topic} is not JSON — ignored: ${raw.toString('utf8').slice(0, 200)}`,
      );
      return;
    }

    // The id is what correlates. A response without one cannot be matched to
    // anything and is dropped rather than guessed at — guessing is exactly how
    // two concurrent requests to the same device would cross their answers.
    const requestId = payload?.id;
    if (requestId === undefined || requestId === null) {
      this.logger.warn(
        `RPC response from ${deviceKey} carries no 'id' — cannot correlate, ignored`,
      );
      return;
    }

    const matched = this.correlator.resolveResponse({
      requestId,
      payload,
      via: 'mqtt',
      deviceKey,
    });

    if (!matched) {
      // Normal and benign: the request already timed out, or another replica
      // issued it. Logged at debug so it is visible when investigating without
      // being noise in steady state.
      this.logger.debug(
        `RPC response from ${deviceKey} id=${requestId} matched no pending request (late, or issued by another node)`,
      );
    }
  }

  /** For the status endpoint — is the loop actually closed right now? */
  isListening(): boolean {
    return Boolean(this.enabled && this.client?.connected);
  }
}
