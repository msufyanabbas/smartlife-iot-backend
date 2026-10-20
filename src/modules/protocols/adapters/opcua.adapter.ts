// src/modules/protocols/adapters/opcua.adapter.ts
//
// OPC-UA adapter — database-driven, subscription-first.
//
// Modelled on SnmpAdapter (the one existing transport whose targets come from
// the database rather than from env vars) and NOT on ModbusAdapter, which is
// env-driven and off by default.

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  StandardTelemetry,
  IProtocolAdapter,
} from '@common/interfaces/standard-telemetry.interface';
import { DeviceListenerService } from '@modules/protocols/device-listener.service';
import { Device } from '@modules/devices/entities/device.entity';
import { decryptSecret } from '@common/utils/secret-box';
import {
  OpcuaServer,
  type OpcuaNodeMapping,
  type OpcuaSecurityMode,
  type OpcuaSecurityPolicy,
} from '../opcua/entities/opcua-server.entity';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A node mapping after defaults have been applied. */
interface ResolvedNode {
  nodeId: string;
  key: string;
  dataType: 'string' | 'number' | 'boolean';
  scale?: number;
  unit?: string;
}

/** Everything needed to run one `opcua_servers` row, resolved per refresh. */
export interface OpcuaTarget {
  rowId: string;
  name: string;
  tenantId: string;
  deviceId: string;
  deviceKey: string;
  customerId?: string;

  endpointUrl: string;
  securityMode: OpcuaSecurityMode;
  securityPolicy: OpcuaSecurityPolicy;
  username?: string | null;
  /** Decrypted only in memory, only on the connect path. */
  password?: string | null;

  nodes: ResolvedNode[];
  useSubscription: boolean;
  publishingIntervalMs: number;
  samplingIntervalMs: number;
  pollIntervalMs: number;
  flushWindowMs: number;

  codecId?: string;
  manufacturer?: string;
  model?: string;
}

/** A client+session shared by every row that points at the same endpoint. */
interface SessionHolder {
  key: string;
  client: any;
  session: any;
  /** Row ids currently using it. The holder closes when this empties. */
  refs: Set<string>;
  endpointUrl: string;
}

/** Per-row runtime state. */
interface RunningRow {
  target: OpcuaTarget;
  /** Which session holder this row is attached to. */
  sessionKey: string | null;
  subscription: any | null;
  monitoredItems: any[];
  pollTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  /** Values seen since the last flush, coalesced into one reading. */
  pending: Record<string, any>;
  /** Set on teardown so a late callback cannot resurrect the row. */
  cancelled: boolean;
  /** Config digest — a change forces a restart rather than a silent no-op. */
  fingerprint: string;
  consecutiveFailures: number;
  /** When the row's counters were last written, to keep writes off the hot path. */
  lastCounterWriteAt: number;
}

/** Result of a connection test, returned to the controller. */
export interface OpcuaTestResult {
  success: boolean;
  message: string;
  endpointUrl: string;
  /** Whether the server accepted a subscription, when one was attempted. */
  subscriptionSupported?: boolean;
  serverProductName?: string;
  serverState?: string;
  /** Per-node read outcome, so a bad NodeId is named rather than guessed at. */
  nodes?: Array<{
    nodeId: string;
    key: string;
    ok: boolean;
    value?: any;
    statusCode?: string;
  }>;
  durationMs: number;
}

/** One entry from a browse. */
export interface OpcuaBrowseEntry {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: string;
  /** True for a Variable — i.e. something that can be mapped to telemetry. */
  isVariable: boolean;
}

const DEFAULT_FLUSH_WINDOW_MS = 1000;
/** Floor on the flush window: 0 would make every change its own telemetry row. */
const MIN_FLUSH_WINDOW_MS = 100;
/** Floor on the poll period, so a mis-typed `1` cannot become a request flood. */
const MIN_POLL_INTERVAL_MS = 1000;
/** How often a row's `readingCount` / `lastReadingAt` may be written. */
const COUNTER_WRITE_INTERVAL_MS = 60_000;
/** Hard ceiling on connect + createSession for the test route. */
const TEST_TIMEOUT_MS = 15_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OPC-UA Adapter
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── What drives a read ────────────────────────────────────────────────────
 * Rows in `opcua_servers`, loaded on a refresh interval exactly as
 * `SnmpAdapter` loads SNMP device profiles. A row names an endpoint, a
 * credential, a node list and a landing device. Nothing here is configured by
 * environment variable except the master switch and the refresh cadence —
 * `ModbusAdapter`'s env-driven, off-by-default shape is the pattern this
 * deliberately does not follow.
 *
 * ── Subscriptions, not polling ────────────────────────────────────────────
 * A real OPC-UA subscription with monitored items is the default, because that
 * is the entire point of the protocol: the server evaluates the deadband and
 * sends a value only when it changes, so a 500-point plant costs almost no
 * traffic while it is steady. Polling is still available per row
 * (`useSubscription = false`) because some embedded servers have a session
 * limit of two and a broken subscription implementation, and a transport that
 * cannot talk to the hardware that exists is not a feature.
 *
 * ── One session per endpoint, not per row ─────────────────────────────────
 * Rows are keyed by endpoint + security + user, and rows that agree on all
 * three share one client and one session, each with its own subscription. A
 * PLC exposing twelve devices would otherwise be asked for twelve sessions,
 * and most servers cap sessions in the single digits.
 *
 * ── Coalescing ────────────────────────────────────────────────────────────
 * Monitored-item notifications are staged and flushed once per
 * `flushWindowMs`. Forty nodes changing on one server scan is one instant of
 * plant state; without the window it would be forty telemetry rows, forty
 * Kafka messages and forty alarm evaluations.
 *
 * ── Where readings go ─────────────────────────────────────────────────────
 * `DeviceListenerService.handleTelemetry()` — the same entry point MQTT,
 * HTTP, CoAP and SNMP use, which is what gives an OPC-UA reading the codec
 * decode, the activity update, the Kafka publish and therefore alarm
 * evaluation and WebSocket broadcast. Writing telemetry rows from here would
 * reproduce the Tuya bug where a second persistence path skipped alarms
 * entirely (CLAUDE.md §4d).
 *
 * ── Environment ───────────────────────────────────────────────────────────
 *   OPCUA_ENABLED=false          disable entirely — no DB query, no sockets
 *   OPCUA_REFRESH_SECONDS=60     how often `opcua_servers` is reloaded
 *   OPCUA_MAX_SERVERS=200        safety cap on concurrently connected rows
 */
@Injectable()
export class OpcuaAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'opcua';
  private readonly logger = new Logger(OpcuaAdapter.name);

  private readonly enabled: boolean;
  private readonly refreshIntervalMs: number;
  private readonly maxServers: number;

  private readonly rows = new Map<string, RunningRow>();
  private readonly sessions = new Map<string, SessionHolder>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private isStarted = false;

  /**
   * The dynamically imported library, cached after the first success.
   *
   * `node-opcua` is a large dependency with native-ish peers and a long load
   * time. A static import would mean a broken or missing install stops the
   * application booting rather than failing one transport — the same reason
   * the AWS SDK is imported dynamically in `AwsIotAdapter` (CLAUDE.md §4e).
   */
  private lib: any = null;
  private libError: string | null = null;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(OpcuaServer)
    private readonly serverRepository: Repository<OpcuaServer>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
  ) {
    // Consistent with COAP_ENABLED / SNMP_ENABLED: on unless switched off.
    this.enabled = this.configService.get<string>('OPCUA_ENABLED') !== 'false';
    this.refreshIntervalMs =
      Number(this.configService.get<string>('OPCUA_REFRESH_SECONDS') ?? 60) *
      1000;
    this.maxServers = Number(
      this.configService.get<string>('OPCUA_MAX_SERVERS') ?? 200,
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('OPC-UA adapter disabled (OPCUA_ENABLED=false)');
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('OPC-UA adapter already started');
      return;
    }
    this.isStarted = true;

    await this.refreshTargets().catch((error) =>
      this.logger.error(
        `OPC-UA initial refresh failed: ${(error as Error).message}`,
      ),
    );

    this.refreshTimer = setInterval(() => {
      void this.refreshTargets().catch((error) =>
        this.logger.error(
          `OPC-UA target refresh failed: ${(error as Error).message}`,
        ),
      );
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();

    this.logger.log(
      `OPC-UA adapter started — ${this.rows.size} server(s), refresh every ${this.refreshIntervalMs / 1000}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const rowId of [...this.rows.keys()]) {
      await this.teardownRow(rowId);
    }
    this.rows.clear();
    this.isStarted = false;
    this.logger.log('OPC-UA adapter stopped');
  }

  // ── Library loading ───────────────────────────────────────────────────────

  /**
   * Load `node-opcua` once.
   *
   * The interop dance is not decoration: `node-opcua` ships as ESM, this
   * module is compiled to CommonJS by SWC, and depending on whether the
   * dynamic import survives transpilation or is downlevelled to `require()`
   * the named exports arrive either on the namespace or under `.default`.
   * Checking for a known export rather than assuming one shape is what makes
   * this work in `nest start`, in the SWC build and under ts-node.
   */
  private async loadLib(): Promise<any> {
    if (this.lib) return this.lib;
    if (this.libError) throw new Error(this.libError);
    try {
      const mod: any = await import('node-opcua');
      const resolved = mod?.OPCUAClient ? mod : mod?.default;
      if (!resolved?.OPCUAClient) {
        throw new Error('node-opcua loaded but exports no OPCUAClient');
      }
      this.lib = resolved;
      return resolved;
    } catch (error) {
      this.libError = `OPC-UA support is unavailable: ${(error as Error).message}`;
      throw new Error(this.libError);
    }
  }

  // ── Target discovery ──────────────────────────────────────────────────────

  /**
   * Reload `opcua_servers` and reconcile: new rows connect, removed or
   * disabled rows disconnect, and a row whose configuration changed restarts
   * on the new one.
   *
   * Exposed rather than private so a verification script can drive one refresh
   * without waiting for the interval — the same reason `SnmpAdapter` exposes
   * `refreshTargets()`.
   */
  async refreshTargets(): Promise<OpcuaTarget[]> {
    // `passwordEncrypted` is `select: false`, so it has to be asked for.
    const rows = await this.serverRepository
      .createQueryBuilder('server')
      .addSelect('server.passwordEncrypted')
      .where('server.enabled = true')
      .andWhere('server.deletedAt IS NULL')
      .take(this.maxServers)
      .getMany();

    const targets: OpcuaTarget[] = [];
    for (const row of rows) {
      const target = await this.resolveTarget(row);
      if (target) targets.push(target);
    }

    await this.reconcile(targets);
    return targets;
  }

  /**
   * Turn a row into a runnable target, or return null with the reason logged.
   *
   * Every rejection is a thing an operator can fix, and each is named: a row
   * with no device has nowhere to put readings, a row with no nodes would hold
   * a session open and read nothing.
   */
  async resolveTarget(row: OpcuaServer): Promise<OpcuaTarget | null> {
    const nodes = this.resolveNodes(row.nodes);
    if (nodes.length === 0) {
      this.logger.warn(
        `OPC-UA server "${row.name}" skipped — its node map is empty, so a session would read nothing`,
      );
      return null;
    }

    if (!row.deviceId) {
      this.logger.warn(
        `OPC-UA server "${row.name}" skipped — no device is set, so there is nowhere for the readings to land`,
      );
      return null;
    }

    const device = await this.deviceRepository.findOne({
      where: { id: row.deviceId, tenantId: row.tenantId, deletedAt: IsNull() },
    });
    if (!device) {
      this.logger.warn(
        `OPC-UA server "${row.name}" skipped — device ${row.deviceId} does not exist in tenant ${row.tenantId}`,
      );
      return null;
    }

    let password: string | null = null;
    if (row.username && row.passwordEncrypted) {
      try {
        password = decryptSecret(row.passwordEncrypted);
      } catch (error) {
        // A wrong CREDENTIALS_ENCRYPTION_KEY must not take the adapter down
        // with it, and it must not silently fall back to anonymous either.
        this.logger.error(
          `OPC-UA server "${row.name}" skipped — ${(error as Error).message}`,
        );
        return null;
      }
    }

    return {
      rowId: row.id,
      name: row.name,
      tenantId: row.tenantId,
      deviceId: device.id,
      deviceKey: device.deviceKey,
      customerId: device.customerId,
      endpointUrl: row.endpointUrl.trim(),
      securityMode: row.securityMode ?? 'None',
      securityPolicy: row.securityPolicy ?? 'None',
      username: row.username ?? null,
      password,
      nodes,
      useSubscription: row.useSubscription !== false,
      publishingIntervalMs: Math.max(
        100,
        Number(row.publishingIntervalMs ?? 1000),
      ),
      samplingIntervalMs: Math.max(0, Number(row.samplingIntervalMs ?? 1000)),
      pollIntervalMs: Math.max(
        MIN_POLL_INTERVAL_MS,
        Number(row.pollIntervalMs ?? 10000),
      ),
      flushWindowMs: Math.max(
        MIN_FLUSH_WINDOW_MS,
        Number(row.flushWindowMs ?? DEFAULT_FLUSH_WINDOW_MS),
      ),
      codecId: device.metadata?.codecId as string | undefined,
      manufacturer:
        (device.metadata?.manufacturer as string | undefined) ??
        device.manufacturer,
      model: (device.metadata?.model as string | undefined) ?? device.model,
    };
  }

  private resolveNodes(raw?: OpcuaNodeMapping[] | null): ResolvedNode[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (node) =>
          node && typeof node.nodeId === 'string' && node.nodeId.trim() !== '',
      )
      .map((node) => ({
        nodeId: node.nodeId.trim(),
        // A mapping with no key is useless as telemetry; fall back to the
        // NodeId so the reading is at least visible rather than dropped.
        key: node.key?.trim() || node.nodeId.trim(),
        dataType: node.dataType ?? 'number',
        scale:
          typeof node.scale === 'number' && Number.isFinite(node.scale)
            ? node.scale
            : undefined,
        unit: node.unit,
      }));
  }

  // ── Reconciliation ────────────────────────────────────────────────────────

  private fingerprintOf(target: OpcuaTarget): string {
    return JSON.stringify({
      e: target.endpointUrl,
      m: target.securityMode,
      p: target.securityPolicy,
      u: target.username ?? '',
      // The password participates: rotating it has to force a reconnect, or
      // the old session keeps working and the new credential is never proven.
      k: target.password ? 'set' : 'none',
      s: target.useSubscription,
      pi: target.publishingIntervalMs,
      si: target.samplingIntervalMs,
      poll: target.pollIntervalMs,
      f: target.flushWindowMs,
      d: target.deviceKey,
      n: target.nodes.map((n) => [n.nodeId, n.key, n.dataType, n.scale]),
    });
  }

  private sessionKeyOf(target: OpcuaTarget): string {
    return [
      target.endpointUrl,
      target.securityMode,
      target.securityPolicy,
      target.username ?? '',
    ].join('|');
  }

  private async reconcile(targets: OpcuaTarget[]): Promise<void> {
    const seen = new Set<string>();

    for (const target of targets) {
      seen.add(target.rowId);
      const fingerprint = this.fingerprintOf(target);
      const existing = this.rows.get(target.rowId);

      if (existing && existing.fingerprint === fingerprint) {
        // Unchanged. Keep the live subscription rather than restarting it —
        // a restart drops the server-side deadband state and replays values.
        existing.target = target;
        continue;
      }

      if (existing) {
        this.logger.log(
          `OPC-UA server "${target.name}" configuration changed — reconnecting`,
        );
        await this.teardownRow(target.rowId);
      }

      await this.startRow(target, fingerprint);
    }

    for (const rowId of [...this.rows.keys()]) {
      if (seen.has(rowId)) continue;
      const row = this.rows.get(rowId);
      this.logger.log(
        `OPC-UA server "${row?.target.name ?? rowId}" removed or disabled — disconnecting`,
      );
      await this.teardownRow(rowId);
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /**
   * A client + session for this target's endpoint, shared with any other row
   * that agrees on endpoint, security and user.
   */
  private async acquireSession(target: OpcuaTarget): Promise<SessionHolder> {
    const key = this.sessionKeyOf(target);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.refs.add(target.rowId);
      return existing;
    }

    const opcua = await this.loadLib();

    const client = opcua.OPCUAClient.create({
      applicationName: 'SmartLifeIoTPlatform',
      // The endpoint may legitimately not be in the server's own endpoint
      // list — reverse proxies and NAT rewrite the advertised host, and
      // insisting on an exact match is the most common reason a working
      // server appears unreachable.
      endpointMustExist: false,
      securityMode:
        opcua.MessageSecurityMode[target.securityMode] ??
        opcua.MessageSecurityMode.None,
      securityPolicy:
        opcua.SecurityPolicy[target.securityPolicy] ??
        opcua.SecurityPolicy.None,
      connectionStrategy: {
        // Retry forever with a capped backoff. A PLC rebooting for twenty
        // minutes must not need an application restart to be picked up again.
        initialDelay: 2000,
        maxDelay: 30000,
        maxRetry: -1,
      },
      keepSessionAlive: true,
      requestedSessionTimeout: 60000,
    });

    // These are the events that tell an operator what is happening. Logged at
    // warn/log rather than swallowed, because "no data" with a silent log is
    // the hardest kind of OPC-UA fault to diagnose.
    client.on('backoff', (retry: number, delay: number) =>
      this.logger.warn(
        `OPC-UA ${target.endpointUrl}: connection attempt ${retry + 1} failed, retrying in ${delay}ms`,
      ),
    );
    client.on('connection_lost', () =>
      this.logger.warn(`OPC-UA ${target.endpointUrl}: connection lost`),
    );
    client.on('connection_reestablished', () =>
      this.logger.log(`OPC-UA ${target.endpointUrl}: connection re-established`),
    );
    // Without a listener an EventEmitter 'error' is an unhandled exception,
    // which for a transport means one unreachable PLC kills the process.
    client.on('error', (error: Error) =>
      this.logger.warn(`OPC-UA ${target.endpointUrl}: ${error.message}`),
    );

    await client.connect(target.endpointUrl);
    const session = await client.createSession(this.identityOf(opcua, target));

    session.on?.('session_closed', () =>
      this.logger.warn(`OPC-UA ${target.endpointUrl}: session closed`),
    );

    const holder: SessionHolder = {
      key,
      client,
      session,
      refs: new Set([target.rowId]),
      endpointUrl: target.endpointUrl,
    };
    this.sessions.set(key, holder);
    this.logger.log(
      `OPC-UA session open on ${target.endpointUrl} (${target.username ? `user ${target.username}` : 'anonymous'}, ${target.securityMode}/${target.securityPolicy})`,
    );
    return holder;
  }

  /** Anonymous unless a username is set — which is how most endpoints ship. */
  private identityOf(opcua: any, target: OpcuaTarget): any {
    if (!target.username) {
      return { type: opcua.UserTokenType.Anonymous };
    }
    return {
      type: opcua.UserTokenType.UserName,
      userName: target.username,
      password: target.password ?? '',
    };
  }

  private async releaseSession(
    sessionKey: string | null,
    rowId: string,
  ): Promise<void> {
    if (!sessionKey) return;
    const holder = this.sessions.get(sessionKey);
    if (!holder) return;
    holder.refs.delete(rowId);
    if (holder.refs.size > 0) return;

    this.sessions.delete(sessionKey);
    try {
      await holder.session?.close();
    } catch {
      /* already gone */
    }
    try {
      await holder.client?.disconnect();
    } catch {
      /* already gone */
    }
    this.logger.log(`OPC-UA session closed on ${holder.endpointUrl}`);
  }

  // ── Starting and stopping one row ─────────────────────────────────────────

  private async startRow(
    target: OpcuaTarget,
    fingerprint: string,
  ): Promise<void> {
    const row: RunningRow = {
      target,
      sessionKey: null,
      subscription: null,
      monitoredItems: [],
      pollTimer: null,
      flushTimer: null,
      pending: {},
      cancelled: false,
      fingerprint,
      consecutiveFailures: 0,
      lastCounterWriteAt: 0,
    };
    this.rows.set(target.rowId, row);

    try {
      const holder = await this.acquireSession(target);
      row.sessionKey = holder.key;

      if (target.useSubscription) {
        await this.attachSubscription(row, holder);
      } else {
        this.armPoll(row, holder, 0);
      }

      await this.recordStatus(target.rowId, 'connected', null, true);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(
        `OPC-UA server "${target.name}" failed to start: ${message}`,
      );
      await this.recordStatus(target.rowId, 'error', message, false);
      // Leave the row OUT of the map so the next refresh retries it cleanly
      // rather than finding a half-built entry with a matching fingerprint.
      await this.teardownRow(target.rowId);
    }
  }

  private async teardownRow(rowId: string): Promise<void> {
    const row = this.rows.get(rowId);
    if (!row) return;
    row.cancelled = true;

    if (row.pollTimer) clearInterval(row.pollTimer);
    if (row.flushTimer) clearTimeout(row.flushTimer);
    row.pollTimer = null;
    row.flushTimer = null;

    for (const item of row.monitoredItems) {
      try {
        await item.terminate?.();
      } catch {
        /* the session may already be gone */
      }
    }
    row.monitoredItems = [];

    try {
      await row.subscription?.terminate?.();
    } catch {
      /* ditto */
    }
    row.subscription = null;

    this.rows.delete(rowId);
    await this.releaseSession(row.sessionKey, rowId);
  }

  // ── Subscriptions: the preferred path ─────────────────────────────────────

  /**
   * Create a subscription and one monitored item per mapped node.
   *
   * `requestedMaxKeepAliveCount` is set so a steady plant still produces a
   * keep-alive roughly every 10 publishing intervals; without it a server can
   * decide the subscription is idle and drop it, and the first sign would be
   * telemetry that simply stops.
   */
  private async attachSubscription(
    row: RunningRow,
    holder: SessionHolder,
  ): Promise<void> {
    const opcua = await this.loadLib();
    const target = row.target;

    const subscription = await holder.session.createSubscription2({
      requestedPublishingInterval: target.publishingIntervalMs,
      requestedLifetimeCount: 1000,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });
    row.subscription = subscription;

    subscription.on('keepalive', () =>
      this.logger.debug(`OPC-UA "${target.name}": subscription keep-alive`),
    );
    subscription.on('terminated', () =>
      this.logger.warn(
        `OPC-UA "${target.name}": subscription terminated by the server`,
      ),
    );
    subscription.on('internal_error', (error: Error) =>
      this.logger.warn(
        `OPC-UA "${target.name}": subscription error — ${error.message}`,
      ),
    );

    for (const node of target.nodes) {
      const item = opcua.ClientMonitoredItem.create(
        subscription,
        { nodeId: node.nodeId, attributeId: opcua.AttributeIds.Value },
        {
          samplingInterval: target.samplingIntervalMs,
          discardOldest: true,
          // Depth 1: this is live monitoring, not a historian. A deeper queue
          // only delivers stale values in a burst after a network hiccup, each
          // of which would be stored with its own timestamp.
          queueSize: 1,
        },
        opcua.TimestampsToReturn.Both,
      );

      item.on('changed', (dataValue: any) => {
        if (row.cancelled) return;
        const coerced = this.coerceDataValue(dataValue, node);
        if (coerced === undefined) return;
        row.pending[node.key] = coerced;
        this.scheduleFlush(row);
      });

      // A bad NodeId fails per-ITEM, not per-subscription: the other 39 points
      // keep working and this one is named in the log so it can be corrected.
      item.on('err', (message: string) =>
        this.logger.warn(
          `OPC-UA "${target.name}": node ${node.nodeId} (${node.key}) rejected — ${message}`,
        ),
      );

      row.monitoredItems.push(item);
    }

    this.logger.log(
      `OPC-UA "${target.name}": subscribed to ${row.monitoredItems.length} node(s) at ${target.publishingIntervalMs}ms on ${target.endpointUrl}`,
    );
  }

  // ── Polling: the fallback path ────────────────────────────────────────────

  private armPoll(
    row: RunningRow,
    holder: SessionHolder,
    initialDelayMs: number,
  ): void {
    const run = () => {
      void this.pollOnce(row, holder);
    };
    // One timer per row; a slow server stretches only its own interval because
    // `pollOnce` never throws and the interval is not reset on completion.
    setTimeout(() => {
      if (row.cancelled) return;
      run();
      row.pollTimer = setInterval(run, row.target.pollIntervalMs);
      row.pollTimer.unref?.();
    }, initialDelayMs).unref?.();

    this.logger.log(
      `OPC-UA "${row.target.name}": polling ${row.target.nodes.length} node(s) every ${row.target.pollIntervalMs}ms (subscriptions disabled for this row)`,
    );
  }

  private async pollOnce(
    row: RunningRow,
    holder: SessionHolder,
  ): Promise<void> {
    if (row.cancelled) return;
    const target = row.target;

    try {
      const opcua = await this.loadLib();
      const dataValues: any[] = await holder.session.read(
        target.nodes.map((node) => ({
          nodeId: node.nodeId,
          attributeId: opcua.AttributeIds.Value,
        })),
      );

      const values: Record<string, any> = {};
      dataValues.forEach((dataValue, index) => {
        const node = target.nodes[index];
        if (!node) return;
        const coerced = this.coerceDataValue(dataValue, node);
        if (coerced !== undefined) values[node.key] = coerced;
      });

      if (Object.keys(values).length === 0) {
        row.consecutiveFailures += 1;
        const message =
          'server answered but every requested NodeId errored or was unreadable';
        if (row.consecutiveFailures <= 3) {
          this.logger.warn(`OPC-UA "${target.name}": ${message}`);
        }
        return;
      }

      row.consecutiveFailures = 0;
      await this.emit(row, values);
    } catch (error) {
      row.consecutiveFailures += 1;
      const message = `OPC-UA poll failed for "${target.name}" (${target.endpointUrl}): ${(error as Error).message}`;
      // First few at warn, then debug: one permanently dead server must not
      // dominate the log (the same back-off SnmpAdapter uses).
      if (row.consecutiveFailures <= 3) this.logger.warn(message);
      else this.logger.debug(`${message} [x${row.consecutiveFailures}]`);
      if (row.consecutiveFailures === 1) {
        await this.recordStatus(
          target.rowId,
          'error',
          (error as Error).message,
          false,
        );
      }
    }
  }

  // ── Coalescing and emission ───────────────────────────────────────────────

  private scheduleFlush(row: RunningRow): void {
    if (row.flushTimer || row.cancelled) return;
    row.flushTimer = setTimeout(() => {
      row.flushTimer = null;
      const values = row.pending;
      row.pending = {};
      if (Object.keys(values).length === 0) return;
      void this.emit(row, values).catch((error) =>
        this.logger.error(
          `OPC-UA "${row.target.name}": could not hand off telemetry — ${(error as Error).message}`,
        ),
      );
    }, row.target.flushWindowMs);
    row.flushTimer.unref?.();
  }

  /** The unified path — codec decode, activity update, Kafka, alarms, WS. */
  private async emit(
    row: RunningRow,
    values: Record<string, any>,
  ): Promise<void> {
    await this.deviceListener.handleTelemetry(this.parse(values, row.target));

    this.logger.debug(
      `OPC-UA reading — "${row.target.name}" → ${row.target.deviceKey}, keys: [${Object.keys(values).join(', ')}]`,
    );

    // Counters are useful and must not be a write per reading: a subscription
    // over a busy plant would otherwise UPDATE this row several times a second
    // purely to record that it is working.
    const now = Date.now();
    if (now - row.lastCounterWriteAt < COUNTER_WRITE_INTERVAL_MS) return;
    row.lastCounterWriteAt = now;
    try {
      await this.serverRepository.update(row.target.rowId, {
        lastStatus: 'connected',
        lastMessage: null,
        lastReadingAt: new Date(),
        readingCount: () => '"readingCount" + 1',
      } as any);
    } catch (error) {
      // A failed bookkeeping write must never fail the reading it describes.
      this.logger.debug(
        `OPC-UA counter update failed for "${row.target.name}": ${(error as Error).message}`,
      );
    }
  }

  private async recordStatus(
    rowId: string,
    status: 'connected' | 'error' | 'disconnected',
    message: string | null,
    touchConnectedAt: boolean,
  ): Promise<void> {
    try {
      await this.serverRepository.update(rowId, {
        lastStatus: status,
        lastMessage: message,
        ...(touchConnectedAt ? { lastConnectedAt: new Date() } : {}),
      });
    } catch (error) {
      this.logger.debug(
        `OPC-UA status update failed for ${rowId}: ${(error as Error).message}`,
      );
    }
  }

  // ── Value coercion ────────────────────────────────────────────────────────

  /**
   * DataValue → telemetry value, or `undefined` to drop it.
   *
   * A bad status code is dropped rather than stored. OPC-UA distinguishes
   * "the sensor reads 0" from "the value is unavailable and the placeholder
   * happens to be 0", and collapsing the second into the first is how a failed
   * transmitter looks like a cold room on a dashboard.
   */
  private coerceDataValue(dataValue: any, node: ResolvedNode): any {
    const status = dataValue?.statusCode;
    // `isGood()` where available, else the numeric severity: a StatusCode with
    // value 0 is Good, anything with the high bits set is Bad or Uncertain.
    const isGood =
      typeof status?.isGood === 'function'
        ? status.isGood()
        : status?.value === undefined || status.value === 0;
    if (!isGood) {
      this.logger.debug(
        `OPC-UA node ${node.nodeId} (${node.key}) returned ${status?.toString?.() ?? 'a bad status'} — dropped`,
      );
      return undefined;
    }

    let raw = dataValue?.value?.value;
    if (raw === null || raw === undefined) return undefined;

    // An array-valued node (a Variant of arrayType Array) is stored as-is for
    // `string`, and reduced to its first element for a scalar type — storing
    // "[1,2,3]" in a numeric series would make the chart unreadable.
    if (Array.isArray(raw) && node.dataType !== 'string') {
      if (raw.length === 0) return undefined;
      raw = raw[0];
    }

    switch (node.dataType) {
      case 'string':
        if (Buffer.isBuffer(raw)) return raw.toString('utf8');
        if (typeof raw === 'object') return JSON.stringify(raw);
        return String(raw);

      case 'boolean':
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'number') return raw !== 0;
        if (typeof raw === 'bigint') return raw !== 0n;
        if (typeof raw === 'string') {
          const lowered = raw.trim().toLowerCase();
          if (['1', 'true', 'on', 'yes'].includes(lowered)) return true;
          if (['0', 'false', 'off', 'no'].includes(lowered)) return false;
        }
        return undefined;

      case 'number':
      default: {
        const numeric =
          typeof raw === 'bigint'
            ? Number(raw)
            : typeof raw === 'boolean'
              ? Number(raw)
              : Number(raw);
        if (!Number.isFinite(numeric)) return undefined;
        return node.scale !== undefined ? numeric * node.scale : numeric;
      }
    }
  }

  // ── StandardTelemetry mapping ─────────────────────────────────────────────

  parse(rawPayload: any, context?: any): StandardTelemetry {
    const target: Partial<OpcuaTarget> = context ?? {};
    const payload: Record<string, any> = rawPayload ?? {};

    return {
      deviceId: target.deviceId ?? '',
      deviceKey: target.deviceKey ?? '',
      tenantId: target.tenantId,
      customerId: target.customerId,
      data: payload,
      temperature: payload.temperature ?? payload.temp,
      humidity: payload.humidity ?? payload.hum,
      pressure: payload.pressure,
      batteryLevel: payload.battery ?? payload.batteryLevel,
      signalStrength: payload.rssi ?? payload.signalStrength,
      timestamp: new Date().toISOString(),
      receivedAt: Date.now(),
      // `StandardTelemetry.protocol` is a closed literal union declared in
      // @common/interfaces/standard-telemetry.interface, which this module does
      // not own — the same cast SnmpAdapter documents. 'opcua' is the honest
      // value and is what reaches Kafka and the telemetry row; widening the
      // union to include 'snmp' | 'opcua' | 'bacnet' | 'lwm2m' is the real fix.
      protocol: 'opcua' as StandardTelemetry['protocol'],
      metadata: {
        opcuaServer: target.name,
        opcuaEndpoint: target.endpointUrl,
        opcuaMode: target.useSubscription ? 'subscription' : 'poll',
        codecId: target.codecId,
        manufacturer: target.manufacturer,
        model: target.model,
      },
      rawPayload: payload,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OPERATOR TOOLS — used by OpcuaController
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Really connect to the endpoint, really create a session, and really read
   * the configured nodes.
   *
   * A test that only checked the URL parsed would pass for every
   * misconfiguration an operator can make. This one opens its own short-lived
   * client so it cannot disturb a running subscription, and closes it in a
   * `finally` so a failure part-way through does not leak a session against a
   * server whose session limit is probably ten.
   */
  async testConnection(
    row: OpcuaServer,
    plainPassword?: string | null,
  ): Promise<OpcuaTestResult> {
    const startedAt = Date.now();
    const endpointUrl = row.endpointUrl?.trim() ?? '';
    const fail = (message: string): OpcuaTestResult => ({
      success: false,
      message,
      endpointUrl,
      durationMs: Date.now() - startedAt,
    });

    if (!endpointUrl) return fail('No endpoint URL is set');

    let opcua: any;
    try {
      opcua = await this.loadLib();
    } catch (error) {
      return fail((error as Error).message);
    }

    const password =
      plainPassword ??
      (row.passwordEncrypted ? this.tryDecrypt(row.passwordEncrypted) : null);

    const client = opcua.OPCUAClient.create({
      applicationName: 'SmartLifeIoTPlatform',
      endpointMustExist: false,
      securityMode:
        opcua.MessageSecurityMode[row.securityMode ?? 'None'] ??
        opcua.MessageSecurityMode.None,
      securityPolicy:
        opcua.SecurityPolicy[row.securityPolicy ?? 'None'] ??
        opcua.SecurityPolicy.None,
      // One attempt. A test route that retried for two minutes would look like
      // a hung request to whoever clicked the button.
      connectionStrategy: { initialDelay: 500, maxDelay: 1000, maxRetry: 0 },
    });
    client.on('error', () => undefined);
    client.on('backoff', () => undefined);

    let session: any = null;
    try {
      const nodes = this.resolveNodes(row.nodes);

      await this.withTimeout(
        (async () => {
          await client.connect(endpointUrl);
          session = await client.createSession(
            row.username
              ? {
                  type: opcua.UserTokenType.UserName,
                  userName: row.username,
                  password: password ?? '',
                }
              : { type: opcua.UserTokenType.Anonymous },
          );
        })(),
        TEST_TIMEOUT_MS,
        `no response from ${endpointUrl} within ${TEST_TIMEOUT_MS}ms`,
      );

      // ServerStatus is mandatory on every compliant server, so reading it
      // separates "we have a working session" from "your NodeIds are wrong".
      const status = await session
        .read({
          nodeId: 'ns=0;i=2259', // Server_ServerStatus_State
          attributeId: opcua.AttributeIds.Value,
        })
        .catch(() => null);
      const product = await session
        .read({
          nodeId: 'ns=0;i=2261', // Server_ServerStatus_BuildInfo_ProductName
          attributeId: opcua.AttributeIds.Value,
        })
        .catch(() => null);

      const nodeResults: OpcuaTestResult['nodes'] = [];
      if (nodes.length > 0) {
        const dataValues: any[] = await session.read(
          nodes.map((node) => ({
            nodeId: node.nodeId,
            attributeId: opcua.AttributeIds.Value,
          })),
        );
        dataValues.forEach((dataValue, index) => {
          const node = nodes[index];
          const coerced = this.coerceDataValue(dataValue, node);
          nodeResults.push({
            nodeId: node.nodeId,
            key: node.key,
            ok: coerced !== undefined,
            value: coerced,
            statusCode: dataValue?.statusCode?.toString?.(),
          });
        });
      }

      // Prove the subscription path too, because that is what the adapter will
      // use. A server that accepts a session and refuses subscriptions is a
      // real and common configuration, and the operator should learn it here
      // rather than from an empty chart tomorrow.
      let subscriptionSupported: boolean | undefined;
      if (row.useSubscription !== false) {
        try {
          const subscription = await session.createSubscription2({
            requestedPublishingInterval: Math.max(
              100,
              Number(row.publishingIntervalMs ?? 1000),
            ),
            requestedLifetimeCount: 100,
            requestedMaxKeepAliveCount: 10,
            maxNotificationsPerPublish: 100,
            publishingEnabled: true,
            priority: 1,
          });
          subscriptionSupported = true;
          await subscription.terminate();
        } catch {
          subscriptionSupported = false;
        }
      }

      const failedNodes = nodeResults.filter((node) => !node.ok);
      const message =
        nodes.length === 0
          ? 'Connected. No nodes are mapped yet, so nothing was read.'
          : failedNodes.length === 0
            ? `Connected. All ${nodeResults.length} node(s) read successfully.`
            : `Connected, but ${failedNodes.length} of ${nodeResults.length} node(s) could not be read: ${failedNodes
                .map((node) => node.nodeId)
                .slice(0, 5)
                .join(', ')}`;

      return {
        success: failedNodes.length === 0,
        message:
          subscriptionSupported === false
            ? `${message} The server refused a subscription — set this server to polling.`
            : message,
        endpointUrl,
        subscriptionSupported,
        serverState: this.describeVariant(status?.value?.value),
        serverProductName: this.describeVariant(product?.value?.value),
        nodes: nodeResults,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return fail((error as Error).message);
    } finally {
      try {
        await session?.close();
      } catch {
        /* nothing to close */
      }
      try {
        await client.disconnect();
      } catch {
        /* nothing to disconnect */
      }
    }
  }

  /**
   * Browse one node's children so an operator can find NodeIds from the UI.
   *
   * Without this the only way to fill in `nodes[]` is to run UaExpert against
   * the server and copy strings by hand, which is exactly the kind of
   * out-of-band step that ends with a typo in a NodeId and a chart that never
   * updates.
   */
  async browse(
    row: OpcuaServer,
    nodeId?: string,
    plainPassword?: string | null,
  ): Promise<{ nodeId: string; entries: OpcuaBrowseEntry[] }> {
    const opcua = await this.loadLib();
    // ObjectsFolder: where everything an integrator cares about hangs.
    const root = nodeId?.trim() || 'ns=0;i=85';
    const password =
      plainPassword ??
      (row.passwordEncrypted ? this.tryDecrypt(row.passwordEncrypted) : null);

    const client = opcua.OPCUAClient.create({
      applicationName: 'SmartLifeIoTPlatform',
      endpointMustExist: false,
      securityMode:
        opcua.MessageSecurityMode[row.securityMode ?? 'None'] ??
        opcua.MessageSecurityMode.None,
      securityPolicy:
        opcua.SecurityPolicy[row.securityPolicy ?? 'None'] ??
        opcua.SecurityPolicy.None,
      connectionStrategy: { initialDelay: 500, maxDelay: 1000, maxRetry: 0 },
    });
    client.on('error', () => undefined);
    client.on('backoff', () => undefined);

    let session: any = null;
    try {
      await this.withTimeout(
        (async () => {
          await client.connect(row.endpointUrl.trim());
          session = await client.createSession(
            row.username
              ? {
                  type: opcua.UserTokenType.UserName,
                  userName: row.username,
                  password: password ?? '',
                }
              : { type: opcua.UserTokenType.Anonymous },
          );
        })(),
        TEST_TIMEOUT_MS,
        `no response from ${row.endpointUrl} within ${TEST_TIMEOUT_MS}ms`,
      );

      const result: any = await session.browse({
        nodeId: root,
        browseDirection: opcua.BrowseDirection.Forward,
        includeSubtypes: true,
        nodeClassMask: 0, // every class — folders are how you navigate
        resultMask: 63,
      });

      const references: any[] = result?.references ?? [];
      const entries: OpcuaBrowseEntry[] = references.map((reference) => {
        const nodeClass = this.nodeClassName(opcua, reference.nodeClass);
        return {
          nodeId: reference.nodeId?.toString?.() ?? String(reference.nodeId),
          browseName:
            reference.browseName?.name ??
            reference.browseName?.toString?.() ??
            '',
          displayName:
            reference.displayName?.text ??
            reference.displayName?.toString?.() ??
            '',
          nodeClass,
          isVariable: nodeClass === 'Variable',
        };
      });

      return { nodeId: root, entries };
    } finally {
      try {
        await session?.close();
      } catch {
        /* nothing to close */
      }
      try {
        await client.disconnect();
      } catch {
        /* nothing to disconnect */
      }
    }
  }

  // ── Introspection (for ops and the verification script) ───────────────────

  getConnectedServers(): Array<{
    rowId: string;
    name: string;
    endpointUrl: string;
    deviceKey: string;
    mode: 'subscription' | 'poll';
    monitoredItems: number;
    nodes: number;
    consecutiveFailures: number;
  }> {
    return [...this.rows.values()].map((row) => ({
      rowId: row.target.rowId,
      name: row.target.name,
      endpointUrl: row.target.endpointUrl,
      deviceKey: row.target.deviceKey,
      mode: row.target.useSubscription ? 'subscription' : 'poll',
      monitoredItems: row.monitoredItems.length,
      nodes: row.target.nodes.length,
      consecutiveFailures: row.consecutiveFailures,
    }));
  }

  /** Open sessions, which is the number an OPC-UA server's limit applies to. */
  getOpenSessionCount(): number {
    return this.sessions.size;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private tryDecrypt(stored: string): string | null {
    try {
      return decryptSecret(stored);
    } catch {
      return null;
    }
  }

  /**
   * Bound a promise that has no timeout of its own.
   *
   * `client.connect()` with `maxRetry: 0` still waits on the TCP stack, and a
   * silently dropped SYN leaves it pending for the OS default — over a minute
   * on Linux. An HTTP request behind that would simply hang.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private describeVariant(value: any): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') {
      return value.text ?? value.toString?.() ?? undefined;
    }
    return String(value);
  }

  private nodeClassName(opcua: any, nodeClass: any): string {
    const numeric = typeof nodeClass === 'number' ? nodeClass : nodeClass?.value;
    const names = opcua.NodeClass ?? {};
    for (const [name, value] of Object.entries(names)) {
      if (value === numeric && Number.isNaN(Number(name))) return name;
    }
    return String(numeric ?? 'Unknown');
  }
}
