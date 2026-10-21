// src/lib/websocket/redis-io.adapter.ts
//
// Makes `server.to(room).emit(...)` mean something on more than one replica.
//
// ── The defect ──────────────────────────────────────────────────────────────
// Socket.IO's default adapter keeps its room membership in process memory.
// `server.to('device:abc').emit('device:telemetry', …)` therefore delivers only
// to the sockets connected to the process that called it. Scale to three
// replicas behind a load balancer and the result is not "slower" — it is
// wrong, for every push the platform makes:
//
//   • A browser's socket lands on replica B; the MQTT uplink for the device it
//     is watching is consumed by replica A. `TelemetryConsumer` on A broadcasts
//     to an empty local room, and the dashboard shows nothing — while REST
//     polling makes it look like a latency problem rather than a lost message.
//   • An alarm raised on A never reaches the `/alarms` socket on C, so the
//     alarm bell is silent until a refresh.
//   • `tenant:<id>` and `user:<id>` rooms are per-process, so notifications are
//     delivered to roughly 1/N of the people who should get them.
//
// The Redis adapter publishes each emit on Redis pub/sub and every replica
// re-delivers it to its own local members of that room. Room membership stays
// local; the fan-out becomes global.
//
// `@socket.io/redis-adapter` was already a dependency. It was simply never
// wired up.
//
// ── One adapter covers all three gateways ──────────────────────────────────
// Nest calls `createIOServer` ONCE for the HTTP server, and all gateways —
// `/ws` (WebsocketGateway), `/alarms` (AlarmsGateway) and `/telemetry`
// (TelemetryGateway) — are namespaces on that one Socket.IO server. Setting
// `.adapter()` on the server applies to every namespace created from it,
// including ones created later, so there is nothing per-gateway to do.
//
// ── Degrading gracefully ───────────────────────────────────────────────────
// If the pub/sub connections cannot be established, this returns a server with
// the DEFAULT adapter and logs loudly. Pushes are then replica-local again —
// bad, but the API, ingestion and every REST route still work, which is a far
// better failure than refusing to boot.

import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { ServerOptions } from 'socket.io';
import type Redis from 'ioredis';
import { RedisService } from '@/lib/redis/redis.service';
import { envBoolean, envString } from '@/config/env.utils';

export class RedisIoAdapter extends IoAdapter {
  private static readonly logger = new Logger(RedisIoAdapter.name);

  private adapterConstructor?: ReturnType<typeof createAdapter>;

  /** Set when connect() established pub/sub. Reported by /health and the logs. */
  private connected = false;

  private readonly clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /**
   * Build the two connections the adapter needs and keep the factory.
   *
   * Never throws: a failure here must not stop bootstrap.
   */
  async connect(): Promise<boolean> {
    if (!envBoolean(process.env.WS_REDIS_ADAPTER_ENABLED, true)) {
      RedisIoAdapter.logger.warn(
        'WS_REDIS_ADAPTER_ENABLED=false — WebSocket pushes will only reach ' +
          'sockets on the replica that produced them. Single-instance only.',
      );
      return false;
    }

    try {
      // Reuse RedisService's configured client so host, port, password, db,
      // TLS and the retry strategy are not configured twice. A client in
      // subscribe mode cannot run other commands, hence two duplicates rather
      // than sharing the application's client.
      const base = this.app.get(RedisService, { strict: false }).client;

      const pubClient = base.duplicate();
      const subClient = base.duplicate();
      this.clients.push(pubClient, subClient);

      // duplicate() inherits lazyConnect:true, so these need an explicit
      // connect — without it the first publish queues forever.
      await Promise.all([
        pubClient.status === 'ready' || pubClient.status === 'connecting'
          ? Promise.resolve()
          : pubClient.connect(),
        subClient.status === 'ready' || subClient.status === 'connecting'
          ? Promise.resolve()
          : subClient.connect(),
      ]);

      // The key is the pub/sub channel prefix. Two deployments sharing one
      // Redis MUST set different values, or each would receive the other's
      // emits — rooms are namespaced by this prefix and nothing else.
      const key = envString(process.env.WS_REDIS_ADAPTER_KEY, 'smartlife-ws')!;

      this.adapterConstructor = createAdapter(pubClient, subClient, { key });
      this.connected = true;
      RedisIoAdapter.logger.log(
        `Socket.IO Redis adapter connected (channel prefix "${key}") — ` +
          'room emits now reach every replica',
      );
      return true;
    } catch (error) {
      RedisIoAdapter.logger.error(
        'Socket.IO Redis adapter could NOT be initialised: ' +
          `${(error as Error).message}. Falling back to the in-memory adapter — ` +
          'WebSocket pushes will not cross replicas until Redis is reachable ' +
          'and the process is restarted.',
      );
      this.adapterConstructor = undefined;
      this.connected = false;
      return false;
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);

    if (!this.adapterConstructor) return server;

    try {
      // `server` is the socket.io Server; typed loosely because IoAdapter
      // declares `any` and the shape differs between attach modes.
      (server as { adapter: (a: unknown) => void }).adapter(
        this.adapterConstructor,
      );
    } catch (error) {
      RedisIoAdapter.logger.error(
        `Failed to attach the Redis adapter to the Socket.IO server: ${(error as Error).message}`,
      );
    }

    return server;
  }

  get isClustered(): boolean {
    return this.connected;
  }

  /** Close the pub/sub duplicates. Called from the shutdown hook. */
  async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
    this.clients.length = 0;
  }
}
