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

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

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

@Injectable()
export class RpcCorrelatorService implements OnModuleDestroy {
  private readonly logger = new Logger(RpcCorrelatorService.name);

  /** requestId → pending request. Must be empty once nothing is in flight. */
  private readonly pending = new Map<string, PendingRpc>();

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
   * Returns true when it matched a pending request. False means the response
   * arrived after the timeout, or was never requested by this node (another
   * replica issued it) — in both cases it is dropped, deliberately, rather
   * than being guessed into some other request.
   */
  resolveResponse(args: {
    requestId: unknown;
    payload?: any;
    via?: 'mqtt' | 'coap';
    /** Optional: reject the match if it is for a different device. */
    deviceKey?: string;
  }): boolean {
    const requestId =
      typeof args.requestId === 'string'
        ? args.requestId
        : args.requestId === undefined || args.requestId === null
          ? ''
          : String(args.requestId);

    if (!requestId) return false;

    const entry = this.pending.get(requestId);
    if (!entry) return false;

    // A response carrying someone else's device key must not resolve this
    // request — the id is the correlation, but this catches a broker or
    // firmware that echoes the wrong one.
    if (args.deviceKey && args.deviceKey !== entry.deviceKey) {
      this.logger.warn(
        `RPC response for id ${requestId} arrived on device ${args.deviceKey} ` +
          `but the request was issued to ${entry.deviceKey} — ignored`,
      );
      return false;
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
    return true;
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
