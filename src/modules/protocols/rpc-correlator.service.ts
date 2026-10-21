// src/modules/protocols/rpc-correlator.service.ts
//
// The pending-request table for two-way device RPC.
//
// Why it lives in ProtocolsModule rather than GatewayModule: two transports
// need it — MQTT (GatewayService publishes the request, a dedicated subscriber
// resolves it) and CoAP (CoAPAdapter resolves it from a device's POST to
// /api/v1/{token}/rpc). GatewayModule already imports ProtocolsModule, so
// putting the shared mechanism here means no circular import.
//
// It holds no MQTT client, no database and no HTTP concerns on purpose. It is
// a correlation table with a timeout, and that is all, which is what makes it
// testable without a broker.
//
// ── Why there is a Redis relay in a "map with a timeout" ───────────────────
// The promise that a caller awaits lives in the memory of ONE process. The
// device's reply does not come back to that process on purpose — it arrives
// wherever the broker or the load balancer puts it:
//
//   • MQTT: the platform now uses a shared subscription, so the reply topic is
//     delivered to exactly one member of the group — by design, a different
//     replica from the one that published the request about (N-1)/N of the
//     time.
//   • CoAP/HTTP: the device POSTs its response to whichever replica the load
//     balancer picks.
//
// So on N replicas, roughly (N-1)/N of every two-way RPC — `GET /devices/:id/rpc`,
// every "read this register now" from a dashboard — resolved nowhere and
// returned a 30-second timeout, while the device had in fact answered within
// milliseconds. `resolveResponse()` returning false was documented as "another
// replica issued it … dropped, deliberately", which is exactly the hole.
//
// The fix is one Redis pub/sub channel. A replica that receives a response it
// has no pending entry for republishes it; every replica listens and tries to
// settle it locally. The owner settles, the others ignore it. That is all the
// coordination needed: the requestId is already a UUID, so there is nothing to
// arbitrate — at most one process can hold a given id.
//
// Properties worth stating:
//   • **No relay loop.** Messages arriving on the channel are settled with a
//     local-only path that never republishes.
//   • **Degrades to the old behaviour.** If Redis is unavailable the subscribe
//     fails, is logged once, and RPC is replica-local again — the same timeout
//     as before, not a new failure mode.
//   • **No new timeout semantics.** The requester's own `setTimeout` still
//     bounds the wait, so a response that never arrives, or arrives after a
//     relay delay, behaves exactly as it did on one node.

import {
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '@/lib/redis/redis.service';

/** What a device sent back, or why we gave up waiting. */
export interface RpcOutcome {
  requestId: string;
  deviceKey: string;
  method: string;
  /** 'response' — the device answered. 'timeout' — it never did. */
  status: 'response' | 'timeout' | 'cancelled';
  /** The device's payload, when it answered. */
  response?: any;
  /** Set when the device reported an error, or on timeout/cancel. */
  error?: string;
  /** Which transport delivered the response. */
  via?: 'mqtt' | 'coap';
  /** Milliseconds from publish to outcome. */
  durationMs: number;
}

interface PendingRpc {
  requestId: string;
  deviceKey: string;
  method: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  settle: (outcome: RpcOutcome) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * The relay channel. Not namespaced per tenant: the payload is only acted on
 * by the process already holding that requestId, which it only holds because
 * it issued the request, so there is nothing to scope.
 */
const RELAY_CHANNEL = 'cluster:rpc:response';

interface RelayedResponse {
  requestId: string;
  payload?: unknown;
  via?: 'mqtt' | 'coap';
  deviceKey?: string;
  /** The node that relayed it, so a node can ignore its own echo. */
  origin: string;
}

@Injectable()
export class RpcCorrelatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RpcCorrelatorService.name);

  /** requestId → pending request. Must be empty once nothing is in flight. */
  private readonly pending = new Map<string, PendingRpc>();

  /** Identifies this process in relayed messages. */
  private readonly nodeId = `${process.env.HOSTNAME ?? 'node'}-${process.pid}-${randomUUID().slice(0, 8)}`;

  /** False when the subscribe failed — RPC is then replica-local. */
  private relayReady = false;

  /**
   * `@Optional()` so the service keeps its "correlation table with a timeout
   * and nothing else" property: `scripts/verify-device-rpc.ts` and
   * `scripts/verify-lwm2m.ts` construct it by hand with no container, and the
   * class must stay testable without Redis. Absent, the relay is simply off
   * and behaviour is exactly what it was before.
   */
  constructor(@Optional() private readonly redis?: RedisService) {}

  async onModuleInit(): Promise<void> {
    if (!this.redis) {
      this.logger.warn(
        'No RedisService — the cross-replica RPC response relay is disabled. ' +
          'A device reply that lands on a different replica than the one that ' +
          'issued the request will time out.',
      );
      return;
    }

    try {
      await this.redis.subscribe(RELAY_CHANNEL, (message) => {
        this.onRelayed(message);
      });
      this.relayReady = true;
      this.logger.log(
        `RPC response relay active on "${RELAY_CHANNEL}" (node ${this.nodeId}) — ` +
          'a reply landing on another replica still settles the caller',
      );
    } catch (error) {
      // Not fatal. Without the relay, a reply that lands on another replica is
      // dropped and the caller times out — the pre-existing behaviour.
      this.logger.error(
        `RPC response relay unavailable: ${(error as Error).message}. ` +
          'Two-way RPC will only work when the reply reaches the same replica ' +
          'that issued the request.',
      );
    }
  }

  /** Did the cross-replica relay come up? Reported by the guard script and ops. */
  get isRelayActive(): boolean {
    return this.relayReady;
  }

  /**
   * Allocate a correlation id.
   *
   * The previous id was `Date.now().toString()` in GatewayService. That is not
   * a correlation id: two requests issued in the same millisecond — the normal
   * case for a dashboard that fans a command out to a group of devices — get
   * the same id, so one device's response resolves the other's request and the
   * second request can never be matched. A UUID has no such collision.
   */
  newRequestId(): string {
    return randomUUID();
  }

  /**
   * Register a request and return a promise that settles exactly once: when
   * `resolveResponse` is called with this id, or when the timeout fires.
   *
   * The caller must publish the request AFTER calling this, so a very fast
   * device cannot answer before the entry exists.
   */
  register(args: {
    requestId: string;
    deviceKey: string;
    method: string;
    timeoutMs?: number;
  }): Promise<RpcOutcome> {
    const timeoutMs = this.clampTimeout(args.timeoutMs);

    return new Promise<RpcOutcome>((resolve) => {
      const startedAt = Date.now();

      // One settle path for both outcomes, and it always removes the map
      // entry first. That is what keeps the map from leaking: a timeout, a
      // response, a cancel and a shutdown all go through here.
      const settle = (outcome: RpcOutcome) => {
        const entry = this.pending.get(outcome.requestId);
        if (!entry) return; // already settled
        this.pending.delete(outcome.requestId);
        clearTimeout(entry.timer);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        settle({
          requestId: args.requestId,
          deviceKey: args.deviceKey,
          method: args.method,
          status: 'timeout',
          error: `Device did not respond within ${timeoutMs}ms`,
          durationMs: Date.now() - startedAt,
        });
        this.logger.warn(
          `RPC timeout — device: ${args.deviceKey}, method: ${args.method}, id: ${args.requestId}`,
        );
      }, timeoutMs);
      // A pending RPC must not keep the process alive on shutdown.
      timer.unref?.();

      this.pending.set(args.requestId, {
        requestId: args.requestId,
        deviceKey: args.deviceKey,
        method: args.method,
        startedAt,
        timer,
        settle,
      });
    });
  }

  /**
   * Deliver a device's response.
   *
   * Returns true when it settled a request held BY THIS PROCESS. False no
   * longer means "dropped": an id this node does not know is relayed over
   * Redis so the replica that issued it can settle it, and the relay is
   * asynchronous, so the caller cannot be told the outcome synchronously. The
   * boolean is therefore "did I settle it myself", which is what the transports
   * use it for (deciding whether to log an unmatched reply).
   */
  resolveResponse(args: {
    requestId: unknown;
    payload?: any;
    via?: 'mqtt' | 'coap';
    /** Optional: reject the match if it is for a different device. */
    deviceKey?: string;
  }): boolean {
    const requestId = this.normaliseId(args.requestId);
    if (!requestId) return false;

    const outcome = this.settleLocal({ ...args, requestId });
    if (outcome === 'settled') return true;

    // 'rejected' means we DO hold the id and the device key did not match, so
    // the response is bogus and must not be offered to anyone else.
    if (outcome === 'unknown') {
      this.relay({
        requestId,
        payload: args.payload,
        via: args.via,
        deviceKey: args.deviceKey,
        origin: this.nodeId,
      });
    }

    return false;
  }

  /**
   * Try to settle a response against this process's own pending table. Never
   * publishes, so it is safe to call from the relay subscriber.
   */
  private settleLocal(args: {
    requestId: string;
    payload?: any;
    via?: 'mqtt' | 'coap';
    deviceKey?: string;
  }): 'settled' | 'unknown' | 'rejected' {
    const requestId = args.requestId;

    const entry = this.pending.get(requestId);
    if (!entry) return 'unknown';

    // A response carrying someone else's device key must not resolve this
    // request — the id is the correlation, but this catches a broker or
    // firmware that echoes the wrong one.
    if (args.deviceKey && args.deviceKey !== entry.deviceKey) {
      this.logger.warn(
        `RPC response for id ${requestId} arrived on device ${args.deviceKey} ` +
          `but the request was issued to ${entry.deviceKey} — ignored`,
      );
      return 'rejected';
    }

    const payload = args.payload;
    // ThingsBoard-style response shapes: { id, error } or { id, result } or a
    // bare value. An explicit `error` makes the outcome a failure, while still
    // being a response (the device answered).
    const error =
      payload && typeof payload === 'object' && payload.error
        ? typeof payload.error === 'string'
          ? payload.error
          : JSON.stringify(payload.error)
        : undefined;

    entry.settle({
      requestId,
      deviceKey: entry.deviceKey,
      method: entry.method,
      status: 'response',
      response: payload,
      error,
      via: args.via,
      durationMs: Date.now() - entry.startedAt,
    });

    this.logger.log(
      `RPC response matched — device: ${entry.deviceKey}, method: ${entry.method}, id: ${requestId}, via: ${args.via ?? 'unknown'}`,
    );
    return 'settled';
  }

  // ── Cross-replica relay ───────────────────────────────────────────────────

  /** Offer a response this node does not own to every other node. */
  private relay(message: RelayedResponse): void {
    if (!this.relayReady || !this.redis) {
      // Same outcome as before the relay existed: the caller times out. Logged
      // at debug because an unknown id is also what a late reply looks like.
      this.logger.debug(
        `RPC response ${message.requestId} matches no local request and the ` +
          'relay is not available — dropped',
      );
      return;
    }

    // JSON.stringify can throw on a payload with a circular reference (a
    // decoded device frame holding a back-reference). Publishing must not throw
    // into a broker message handler.
    let body: string;
    try {
      body = JSON.stringify(message);
    } catch (error) {
      this.logger.warn(
        `RPC response ${message.requestId} could not be relayed — payload is ` +
          `not serialisable: ${(error as Error).message}`,
      );
      return;
    }

    void this.redis.publish(RELAY_CHANNEL, body).catch((error: Error) => {
      this.logger.warn(
        `Failed to relay RPC response ${message.requestId}: ${error.message}`,
      );
    });
  }

  /**
   * A response relayed by another replica. Settled LOCAL-ONLY — calling
   * `resolveResponse()` here would republish an id nobody owns and the
   * message would circulate for ever.
   */
  private onRelayed(raw: string): void {
    let message: RelayedResponse;
    try {
      message = JSON.parse(raw) as RelayedResponse;
    } catch {
      return;
    }

    // Our own publish comes back to us on the same channel.
    if (!message?.requestId || message.origin === this.nodeId) return;

    // Cheap pre-check: the overwhelming majority of relayed messages are for
    // ids this node does not hold, and settleLocal() would log nothing for
    // them anyway.
    if (!this.pending.has(message.requestId)) return;

    const outcome = this.settleLocal({
      requestId: message.requestId,
      payload: message.payload,
      via: message.via,
      deviceKey: message.deviceKey,
    });

    if (outcome === 'settled') {
      this.logger.log(
        `RPC response ${message.requestId} relayed from ${message.origin} and ` +
          'settled here',
      );
    }
  }

  private normaliseId(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (raw === undefined || raw === null) return '';
    return String(raw);
  }

  /**
   * Fail every pending request for a reason outside the request itself —
   * the MQTT connection dropping, or module shutdown.
   *
   * Without this, a reconnect would leave entries that can never be resolved
   * (the device's response was published while we were not subscribed) sitting
   * in the map until their individual timeouts, and a shutdown would leave the
   * callers' promises pending forever.
   */
  cancelAll(reason: string): number {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      entry.settle({
        requestId: entry.requestId,
        deviceKey: entry.deviceKey,
        method: entry.method,
        status: 'cancelled',
        error: reason,
        durationMs: Date.now() - entry.startedAt,
      });
    }
    if (entries.length > 0) {
      this.logger.warn(
        `Cancelled ${entries.length} pending RPC request(s): ${reason}`,
      );
    }
    return entries.length;
  }

  /** Cancel one request, e.g. when the publish itself failed. */
  cancel(requestId: string, reason: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.settle({
      requestId,
      deviceKey: entry.deviceKey,
      method: entry.method,
      status: 'cancelled',
      error: reason,
      durationMs: Date.now() - entry.startedAt,
    });
    return true;
  }

  onModuleDestroy(): void {
    this.cancelAll('Server is shutting down');
  }

  // ── Introspection (used by the verification script and by ops) ────────────

  /** How many requests are waiting. A leak shows up here as a number that never returns to 0. */
  pendingCount(): number {
    return this.pending.size;
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  clampTimeout(raw?: number): number {
    const timeout = Number(raw);
    if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(timeout)));
  }
}
