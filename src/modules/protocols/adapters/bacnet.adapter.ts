// src/modules/protocols/adapters/bacnet.adapter.ts
//
// BACnet/IP adapter — database-driven polling plus Who-Is discovery.
//
// Modelled on SnmpAdapter, the one existing transport whose targets come from
// the database. BACnet is a polling protocol in the same way SNMP is: the
// platform asks, the controller answers.

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
import {
  BacnetDevice,
  type BacnetObjectMapping,
  type BacnetObjectTypeName,
} from '../bacnet/entities/bacnet-device.entity';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ResolvedObject {
  objectType: BacnetObjectTypeName;
  objectTypeId: number;
  objectInstance: number;
  property: string;
  propertyId: number;
  telemetryKey: string;
  dataType: 'string' | 'number' | 'boolean';
  scale?: number;
  unit?: string;
}

export interface BacnetTarget {
  rowId: string;
  name: string;
  tenantId: string;
  deviceId: string;
  deviceKey: string;
  customerId?: string;

  address: string;
  port: number;
  deviceInstance: number;

  objects: ResolvedObject[];
  pollIntervalMs: number;
  useReadPropertyMultiple: boolean;
  apduTimeoutMs: number;

  codecId?: string;
  manufacturer?: string;
  model?: string;
}

interface ScheduledPoll {
  target: BacnetTarget;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  cancelled: boolean;
  consecutiveFailures: number;
  /**
   * Set when ReadPropertyMultiple fails in a way that says the controller does
   * not really support it, so later polls use single reads without having to
   * fail once per cycle to learn it again.
   */
  rpmUnsupported: boolean;
  fingerprint: string;
  lastCounterWriteAt: number;
}

export interface BacnetPollResult {
  rowId: string;
  deviceKey: string;
  ok: boolean;
  values: Record<string, any>;
  /** Objects the controller refused, named so they can be corrected. */
  failed: Array<{ objectType: string; objectInstance: number; error: string }>;
  error?: string;
  /** Which service actually produced the values. */
  method: 'readPropertyMultiple' | 'readProperty' | 'none';
  durationMs: number;
}

export interface BacnetDiscoveredDevice {
  address: string;
  deviceInstance: number;
  maxApdu?: number;
  segmentation?: number;
  vendorId?: number;
  /** Object name and model, when the controller answered the follow-up reads. */
  objectName?: string;
  modelName?: string;
  vendorName?: string;
  /** True when a `bacnet_devices` row already claims this instance number. */
  alreadyRegistered?: boolean;
}

const DEFAULT_PORT = 47808;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Floor on the poll period: BACnet/IP is UDP, and a tight loop floods a BMS. */
const MIN_POLL_INTERVAL_MS = 5_000;
const DEFAULT_APDU_TIMEOUT_MS = 6_000;
const COUNTER_WRITE_INTERVAL_MS = 60_000;
/** Who-Is is a broadcast; this is how long answers are collected. */
const DEFAULT_DISCOVERY_WINDOW_MS = 5_000;
const MAX_DISCOVERY_WINDOW_MS = 30_000;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BACnet/IP Adapter
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── One socket, many controllers ──────────────────────────────────────────
 * BACnet/IP binds a single UDP port (47808 by default) and multiplexes every
 * request over it by invoke id — that is how the protocol works, and it is why
 * there is one shared client here rather than one per device. A second client
 * on the same port would either fail to bind or steal the other's replies.
 *
 * That single socket is also why `BACNET_ENABLED` defaults to **false** in
 * containers that do not ask for it: binding 47808 is a host-level side
 * effect, and on a machine already running a BACnet service it would fight for
 * the port. Set `BACNET_ENABLED=true` and map `47808:47808/udp`.
 *
 * ── What drives a poll ────────────────────────────────────────────────────
 * Rows in `bacnet_devices`, reloaded on a refresh interval exactly as
 * `SnmpAdapter` reloads SNMP profiles. Each row carries the unicast address,
 * the device instance number and the object list.
 *
 * ── Discovery ─────────────────────────────────────────────────────────────
 * `discover()` broadcasts a Who-Is and collects I-Am answers for a few
 * seconds. This is not a nicety: BACnet addresses devices by instance NUMBER,
 * which is not printed on the equipment and cannot be derived from the IP. The
 * alternative to a discovery route is an operator guessing integers.
 *
 * ── Where readings go ─────────────────────────────────────────────────────
 * `DeviceListenerService.handleTelemetry()`, like every other transport, so a
 * BACnet reading gets the same codec decode, Kafka publish, alarm evaluation
 * and WebSocket broadcast.
 *
 * ── Environment ───────────────────────────────────────────────────────────
 *   BACNET_ENABLED=true          REQUIRED — off unless explicitly enabled,
 *                                because it binds a UDP port
 *   BACNET_PORT=47808            local bind port
 *   BACNET_INTERFACE=0.0.0.0     local interface
 *   BACNET_BROADCAST=255.255.255.255   subnet broadcast used by Who-Is
 *   BACNET_REFRESH_SECONDS=60    how often `bacnet_devices` is reloaded
 *   BACNET_MAX_DEVICES=500       safety cap on concurrently polled rows
 */
@Injectable()
export class BacnetAdapter
  implements IProtocolAdapter, OnModuleInit, OnModuleDestroy
{
  protocol = 'bacnet';
  private readonly logger = new Logger(BacnetAdapter.name);

  private readonly enabled: boolean;
  private readonly refreshIntervalMs: number;
  private readonly maxDevices: number;
  private readonly bindPort: number;
  private readonly bindInterface: string | undefined;
  private readonly broadcastAddress: string | undefined;

  private readonly scheduled = new Map<string, ScheduledPoll>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private isStarted = false;

  /** The one shared BACnet/IP client. Created lazily on first use. */
  private client: any = null;
  private clientError: string | null = null;
  private bacnetEnum: any = null;

  constructor(
    private readonly deviceListener: DeviceListenerService,
    @InjectRepository(BacnetDevice)
    private readonly bacnetRepository: Repository<BacnetDevice>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly configService: ConfigService,
  ) {
    // NOT the "on unless disabled" default the other adapters use: this one
    // binds a privileged-ish UDP port on the host, which is a side effect a
    // deployment has to opt into.
    this.enabled =
      this.configService.get<string>('BACNET_ENABLED') === 'true';
    this.refreshIntervalMs =
      Number(this.configService.get<string>('BACNET_REFRESH_SECONDS') ?? 60) *
      1000;
    this.maxDevices = Number(
      this.configService.get<string>('BACNET_MAX_DEVICES') ?? 500,
    );
    this.bindPort = Number(
      this.configService.get<string>('BACNET_PORT') ?? DEFAULT_PORT,
    );
    this.bindInterface = this.configService.get<string>('BACNET_INTERFACE');
    this.broadcastAddress = this.configService.get<string>('BACNET_BROADCAST');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        'BACnet adapter disabled (set BACNET_ENABLED=true and map UDP 47808 to enable)',
      );
      return;
    }
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(): Promise<void> {
    if (this.isStarted) {
      this.logger.warn('BACnet adapter already started');
      return;
    }
    this.isStarted = true;

    await this.refreshTargets().catch((error) =>
      this.logger.error(
        `BACnet initial refresh failed: ${(error as Error).message}`,
      ),
    );

    this.refreshTimer = setInterval(() => {
      void this.refreshTargets().catch((error) =>
        this.logger.error(
          `BACnet target refresh failed: ${(error as Error).message}`,
        ),
      );
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();

    this.logger.log(
      `BACnet adapter started — ${this.scheduled.size} device(s), refresh every ${this.refreshIntervalMs / 1000}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const entry of this.scheduled.values()) {
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.scheduled.clear();

    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* already closed */
      }
      this.client = null;
    }
    this.isStarted = false;
    this.logger.log('BACnet adapter stopped');
  }

  // ── Library and client ────────────────────────────────────────────────────

  /**
   * Get (or build) the shared client.
   *
   * `node-bacnet` is imported dynamically so a broken install degrades to a
   * failed poll rather than stopping the application from booting — the same
   * reason the AWS SDK is imported dynamically in `AwsIotAdapter`
   * (CLAUDE.md §4e). It also means the UDP port is not bound until something
   * actually needs BACnet.
   *
   * The interop branch is real: the package's `index.js` is
   * `module.exports = require('./lib/client')`, so under esModuleInterop the
   * constructor arrives on `.default`, while a plain `require` hands back the
   * class itself.
   */
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (this.clientError) throw new Error(this.clientError);

    try {
      const mod: any = await import('node-bacnet');
      const ClientCtor =
        typeof mod === 'function' ? mod : (mod?.default ?? mod);
      if (typeof ClientCtor !== 'function') {
        throw new Error('node-bacnet loaded but exports no client constructor');
      }
      this.bacnetEnum = ClientCtor.enum ?? mod?.enum ?? mod?.default?.enum;
      if (!this.bacnetEnum?.ObjectType || !this.bacnetEnum?.PropertyIdentifier) {
        throw new Error(
          'node-bacnet loaded but its ObjectType / PropertyIdentifier enums are missing',
        );
      }

      const client = new ClientCtor({
        port: this.bindPort,
        ...(this.bindInterface ? { interface: this.bindInterface } : {}),
        ...(this.broadcastAddress
          ? { broadcastAddress: this.broadcastAddress }
          : {}),
        apduTimeout: DEFAULT_APDU_TIMEOUT_MS,
        reuseAddr: true,
      });

      // Without an 'error' listener a socket error is an unhandled exception,
      // which for a UDP transport means one malformed datagram from any device
      // on the subnet takes the process down.
      client.on('error', (error: Error) =>
        this.logger.warn(`BACnet socket error: ${error.message}`),
      );
      client.on('listening', () =>
        this.logger.log(`BACnet/IP listening on UDP ${this.bindPort}`),
      );

      this.client = client;
      return client;
    } catch (error) {
      this.clientError = `BACnet support is unavailable: ${(error as Error).message}`;
      this.logger.error(this.clientError);
      throw new Error(this.clientError);
    }
  }

  // ── Target discovery ──────────────────────────────────────────────────────

  async refreshTargets(): Promise<BacnetTarget[]> {
    const rows = await this.bacnetRepository.find({
      where: { enabled: true, deletedAt: IsNull() },
      take: this.maxDevices,
    });

    const targets: BacnetTarget[] = [];
    for (const row of rows) {
      const target = await this.resolveTarget(row);
      if (target) targets.push(target);
    }

    this.reconcile(targets);
    return targets;
  }

  async resolveTarget(row: BacnetDevice): Promise<BacnetTarget | null> {
    if (!this.bacnetEnum) {
      // Resolution needs the library's enums to turn 'analogInput' into 0.
      try {
        await this.getClient();
      } catch {
        return null;
      }
    }

    const objects = this.resolveObjects(row.objects);
    if (objects.length === 0) {
      this.logger.warn(
        `BACnet device "${row.name}" skipped — its object list is empty, so a poll would read nothing`,
      );
      return null;
    }

    if (!row.deviceId) {
      this.logger.warn(
        `BACnet device "${row.name}" skipped — no platform device is set, so there is nowhere for the readings to land`,
      );
      return null;
    }

    const device = await this.deviceRepository.findOne({
      where: { id: row.deviceId, tenantId: row.tenantId, deletedAt: IsNull() },
    });
    if (!device) {
      this.logger.warn(
        `BACnet device "${row.name}" skipped — device ${row.deviceId} does not exist in tenant ${row.tenantId}`,
      );
      return null;
    }

    return {
      rowId: row.id,
      name: row.name,
      tenantId: row.tenantId,
      deviceId: device.id,
      deviceKey: device.deviceKey,
      customerId: device.customerId,
      address: this.formatReceiver(row.address, row.port),
      port: Number(row.port ?? DEFAULT_PORT),
      deviceInstance: Number(row.deviceInstance),
      objects,
      pollIntervalMs: Math.max(
        MIN_POLL_INTERVAL_MS,
        Number(row.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
      ),
      useReadPropertyMultiple: row.useReadPropertyMultiple !== false,
      apduTimeoutMs: Math.max(
        1000,
        Number(row.apduTimeoutMs ?? DEFAULT_APDU_TIMEOUT_MS),
      ),
      codecId: device.metadata?.codecId as string | undefined,
      manufacturer:
        (device.metadata?.manufacturer as string | undefined) ??
        device.manufacturer,
      model: (device.metadata?.model as string | undefined) ?? device.model,
    };
  }

  /**
   * `address` plus `port`, in the `host:port` form the library accepts.
   *
   * The default port is left off: `node-bacnet` treats a bare host as 47808,
   * and appending it explicitly for every row would make a non-standard port
   * (which some routers use) harder to spot in a log line.
   */
  private formatReceiver(address: string, port?: number | null): string {
    const host = (address ?? '').trim();
    const effective = Number(port ?? DEFAULT_PORT);
    if (!host || host.includes(':')) return host;
    return effective === DEFAULT_PORT ? host : `${host}:${effective}`;
  }

  private resolveObjects(raw?: BacnetObjectMapping[] | null): ResolvedObject[] {
    if (!Array.isArray(raw) || !this.bacnetEnum) return [];

    const objectTypes = this.bacnetEnum.ObjectType;
    const propertyIds = this.bacnetEnum.PropertyIdentifier;

    const resolved: ResolvedObject[] = [];
    for (const mapping of raw) {
      if (!mapping?.objectType) continue;
      const objectTypeId = this.lookupEnum(objectTypes, mapping.objectType);
      if (objectTypeId === undefined) {
        this.logger.warn(
          `BACnet mapping skipped — unknown object type "${mapping.objectType}"`,
        );
        continue;
      }
      const instance = Number(mapping.objectInstance);
      if (!Number.isInteger(instance) || instance < 0) {
        this.logger.warn(
          `BACnet mapping skipped — object instance "${mapping.objectInstance}" is not a non-negative integer`,
        );
        continue;
      }

      const property = mapping.property ?? 'presentValue';
      const propertyId = this.lookupEnum(propertyIds, property);
      if (propertyId === undefined) {
        this.logger.warn(
          `BACnet mapping skipped — unknown property "${property}"`,
        );
        continue;
      }

      resolved.push({
        objectType: mapping.objectType,
        objectTypeId,
        objectInstance: instance,
        property,
        propertyId,
        // A mapping with no key is useless as telemetry; fall back to a
        // readable composite so the reading is visible rather than dropped.
        telemetryKey:
          mapping.telemetryKey?.trim() ||
          `${mapping.objectType}_${instance}_${property}`,
        dataType: mapping.dataType ?? this.defaultDataType(mapping.objectType),
        scale:
          typeof mapping.scale === 'number' && Number.isFinite(mapping.scale)
            ? mapping.scale
            : undefined,
        unit: mapping.unit,
      });
    }
    return resolved;
  }

  /**
   * `node-bacnet`'s enums are objects with BOTH `{NAME: 0}` and `{0: 'NAME'}`
   * entries, and the names are SCREAMING_SNAKE (`ANALOG_INPUT`) while this
   * platform's mapping uses camelCase (`analogInput`). Both spellings are
   * accepted so a hand-edited mapping is not silently dropped.
   */
  private lookupEnum(
    bag: Record<string, any>,
    name: string,
  ): number | undefined {
    if (!bag) return undefined;
    const direct = bag[name];
    if (typeof direct === 'number') return direct;

    const screaming = name
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toUpperCase();
    const snake = bag[screaming];
    if (typeof snake === 'number') return snake;

    const squashed = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value !== 'number') continue;
      if (key.replace(/[^a-z0-9]/gi, '').toLowerCase() === squashed) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * A binary object's present value is an enumerated 0/1 that means
   * inactive/active, so storing it as a number produces a chart of zeroes and
   * ones where a boolean series was wanted. Analog and multi-state are
   * numeric.
   */
  private defaultDataType(
    objectType: BacnetObjectTypeName,
  ): 'string' | 'number' | 'boolean' {
    return objectType.startsWith('binary') ? 'boolean' : 'number';
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  private fingerprintOf(target: BacnetTarget): string {
    return JSON.stringify({
      a: target.address,
      i: target.deviceInstance,
      p: target.pollIntervalMs,
      r: target.useReadPropertyMultiple,
      t: target.apduTimeoutMs,
      d: target.deviceKey,
      o: target.objects.map((o) => [
        o.objectTypeId,
        o.objectInstance,
        o.propertyId,
        o.telemetryKey,
        o.dataType,
        o.scale,
      ]),
    });
  }

  private reconcile(targets: BacnetTarget[]): void {
    const seen = new Set<string>();

    for (const target of targets) {
      seen.add(target.rowId);
      const fingerprint = this.fingerprintOf(target);
      const existing = this.scheduled.get(target.rowId);

      if (!existing) {
        const entry: ScheduledPoll = {
          target,
          timer: null,
          inFlight: false,
          cancelled: false,
          consecutiveFailures: 0,
          rpmUnsupported: false,
          fingerprint,
          lastCounterWriteAt: 0,
        };
        this.scheduled.set(target.rowId, entry);
        // Stagger first polls so N controllers do not all get a datagram on
        // the same tick — a BMS subnet is often 10 Mbit of shared bandwidth.
        this.arm(entry, Math.floor(Math.random() * 2000));
        continue;
      }

      const changed = existing.fingerprint !== fingerprint;
      existing.target = target;
      existing.fingerprint = fingerprint;
      if (changed) {
        // A changed object list means the learned "RPM does not work" verdict
        // may no longer apply, so it is re-tested.
        existing.rpmUnsupported = false;
        if (existing.timer) {
          clearTimeout(existing.timer);
          this.arm(existing, 0);
        }
      }
    }

    for (const [rowId, entry] of this.scheduled) {
      if (seen.has(rowId)) continue;
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
      this.scheduled.delete(rowId);
      this.logger.log(
        `BACnet polling stopped for "${entry.target.name}" (removed or disabled)`,
      );
    }
  }

  /**
   * Arm one row's next poll.
   *
   * Each row re-arms itself only AFTER its own poll has settled, so a slow
   * controller stretches its own interval and nothing else. There is no shared
   * `setInterval` whose tick one dead device could block.
   */
  private arm(entry: ScheduledPoll, delayMs: number): void {
    if (entry.cancelled) return;
    entry.timer = setTimeout(() => {
      void this.tick(entry);
    }, delayMs);
    entry.timer.unref?.();
  }

  private async tick(entry: ScheduledPoll): Promise<void> {
    if (entry.cancelled) return;

    if (entry.inFlight) {
      this.arm(entry, entry.target.pollIntervalMs);
      return;
    }

    entry.inFlight = true;
    let result: BacnetPollResult;
    try {
      result = await this.pollTarget(entry.target, entry);
    } finally {
      entry.inFlight = false;
    }

    if (result.ok) {
      entry.consecutiveFailures = 0;
    } else {
      entry.consecutiveFailures += 1;
      const message = `BACnet poll failed for "${entry.target.name}" (${entry.target.address}, instance ${entry.target.deviceInstance}): ${result.error}`;
      if (entry.consecutiveFailures <= 3) this.logger.warn(message);
      else this.logger.debug(`${message} [x${entry.consecutiveFailures}]`);
    }

    this.arm(entry, entry.target.pollIntervalMs);
  }

  // ── Polling one controller ────────────────────────────────────────────────

  /**
   * Poll one target once and, on success, hand the readings to
   * `DeviceListenerService.handleTelemetry()`.
   *
   * Never throws: a failure is reported in the returned result so the caller's
   * scheduler keeps running. Exposed for the test route and a verification
   * script.
   */
  async pollTarget(
    target: BacnetTarget,
    entry?: ScheduledPoll,
  ): Promise<BacnetPollResult> {
    const startedAt = Date.now();
    const base: Omit<BacnetPollResult, 'ok' | 'method'> = {
      rowId: target.rowId,
      deviceKey: target.deviceKey,
      values: {},
      failed: [],
      durationMs: 0,
    };

    let client: any;
    try {
      client = await this.getClient();
    } catch (error) {
      return {
        ...base,
        ok: false,
        method: 'none',
        error: (error as Error).message,
        durationMs: Date.now() - startedAt,
      };
    }

    const useRpm = target.useReadPropertyMultiple && !entry?.rpmUnsupported;
    let values: Record<string, any> = {};
    let failed: BacnetPollResult['failed'] = [];
    let method: BacnetPollResult['method'] = 'none';
    let error: string | undefined;

    if (useRpm) {
      try {
        values = await this.readPropertyMultiple(client, target);
        method = 'readPropertyMultiple';
      } catch (rpmError) {
        const message = (rpmError as Error).message;
        // Plenty of field controllers advertise RPM in their
        // services-supported bitstring and then reject it, or answer with a
        // truncated APDU. Falling back once and REMEMBERING the verdict is the
        // only way through that without failing every cycle.
        this.logger.warn(
          `BACnet "${target.name}": ReadPropertyMultiple failed (${message}) — falling back to single ReadProperty requests for this device`,
        );
        if (entry) entry.rpmUnsupported = true;
        const single = await this.readPropertiesOneByOne(client, target);
        values = single.values;
        failed = single.failed;
        method = 'readProperty';
      }
    } else {
      const single = await this.readPropertiesOneByOne(client, target);
      values = single.values;
      failed = single.failed;
      method = 'readProperty';
    }

    if (Object.keys(values).length === 0) {
      error =
        failed.length > 0
          ? `every object errored (first: ${failed[0].objectType}:${failed[0].objectInstance} — ${failed[0].error})`
          : 'controller did not answer';
      await this.recordStatus(target.rowId, 'error', error);
      return {
        ...base,
        failed,
        ok: false,
        method,
        error,
        durationMs: Date.now() - startedAt,
      };
    }

    // The unified path — codec decode, activity update, Kafka, alarms, WS.
    await this.deviceListener.handleTelemetry(this.parse(values, target));

    this.logger.debug(
      `BACnet reading — "${target.name}" → ${target.deviceKey} via ${method}, keys: [${Object.keys(values).join(', ')}]`,
    );

    const now = Date.now();
    if (!entry || now - entry.lastCounterWriteAt >= COUNTER_WRITE_INTERVAL_MS) {
      if (entry) entry.lastCounterWriteAt = now;
      try {
        await this.bacnetRepository.update(target.rowId, {
          lastStatus: 'ok',
          lastMessage:
            failed.length > 0
              ? `${failed.length} object(s) could not be read`
              : null,
          lastReadingAt: new Date(),
          readingCount: () => '"readingCount" + 1',
        } as any);
      } catch (updateError) {
        // Bookkeeping must never fail the reading it describes.
        this.logger.debug(
          `BACnet counter update failed for "${target.name}": ${(updateError as Error).message}`,
        );
      }
    }

    return {
      ...base,
      values,
      failed,
      ok: true,
      method,
      durationMs: Date.now() - startedAt,
    };
  }

  /** One ReadPropertyMultiple for the whole object list. */
  private readPropertyMultiple(
    client: any,
    target: BacnetTarget,
  ): Promise<Record<string, any>> {
    const request = target.objects.map((object) => ({
      objectId: { type: object.objectTypeId, instance: object.objectInstance },
      properties: [{ id: object.propertyId }],
    }));

    return new Promise<Record<string, any>>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, values?: Record<string, any>) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClock);
        if (error) reject(error);
        else resolve(values ?? {});
      };

      // The library's own apduTimeout is set on the CLIENT, not per request,
      // and the callback is not guaranteed to fire if the socket errors — so a
      // wall-clock guard is what stops this row's scheduler stalling forever.
      const wallClock = setTimeout(
        () =>
          finish(
            new Error(`no response within ${target.apduTimeoutMs + 2000}ms`),
          ),
        target.apduTimeoutMs + 2000,
      );
      wallClock.unref?.();

      try {
        client.readPropertyMultiple(
          target.address,
          request,
          { maxApdu: 1476 },
          (error: Error | null, result: any) => {
            if (error) return finish(error);
            finish(null, this.mapReadAccessResults(target, result));
          },
        );
      } catch (thrown) {
        finish(thrown as Error);
      }
    });
  }

  /** ReadProperty per object, so one bad object cannot lose the whole poll. */
  private async readPropertiesOneByOne(
    client: any,
    target: BacnetTarget,
  ): Promise<{ values: Record<string, any>; failed: BacnetPollResult['failed'] }> {
    const values: Record<string, any> = {};
    const failed: BacnetPollResult['failed'] = [];

    // Sequential, not parallel. BACnet/IP multiplexes by invoke id and the
    // field controllers that need this fallback are also the ones with a
    // one-request queue; firing 40 datagrams at a VAV box loses most of them.
    for (const object of target.objects) {
      try {
        const value = await this.readOneProperty(client, target, object);
        if (value !== undefined) values[object.telemetryKey] = value;
      } catch (error) {
        failed.push({
          objectType: object.objectType,
          objectInstance: object.objectInstance,
          error: (error as Error).message,
        });
      }
    }

    return { values, failed };
  }

  private readOneProperty(
    client: any,
    target: BacnetTarget,
    object: ResolvedObject,
  ): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClock);
        if (error) reject(error);
        else resolve(value);
      };

      const wallClock = setTimeout(
        () =>
          finish(
            new Error(`no response within ${target.apduTimeoutMs + 1000}ms`),
          ),
        target.apduTimeoutMs + 1000,
      );
      wallClock.unref?.();

      try {
        client.readProperty(
          target.address,
          {
            type: object.objectTypeId,
            instance: object.objectInstance,
          },
          object.propertyId,
          {},
          (error: Error | null, result: any) => {
            if (error) return finish(error);
            const raw = result?.values?.[0]?.value;
            finish(null, this.coerce(raw, object));
          },
        );
      } catch (thrown) {
        finish(thrown as Error);
      }
    });
  }

  /**
   * ReadPropertyMultiple acknowledge → telemetry keys.
   *
   * A per-property BACnet ERROR arrives as a value whose type is the error
   * tag, so an unreadable object shows up here as a nested `{errorClass,
   * errorCode}` rather than as a failure of the whole request. Those are
   * dropped and logged, not stored.
   */
  private mapReadAccessResults(
    target: BacnetTarget,
    result: any,
  ): Record<string, any> {
    const values: Record<string, any> = {};
    const accessResults: any[] = result?.values ?? [];

    for (const accessResult of accessResults) {
      const objectId = accessResult?.objectId;
      for (const property of accessResult?.values ?? []) {
        const object = target.objects.find(
          (candidate) =>
            candidate.objectTypeId === objectId?.type &&
            candidate.objectInstance === objectId?.instance &&
            candidate.propertyId === property?.id,
        );
        if (!object) continue;

        const first = property?.value?.[0];
        const raw = first?.value;
        if (
          raw &&
          typeof raw === 'object' &&
          ('errorClass' in raw || 'errorCode' in raw)
        ) {
          this.logger.debug(
            `BACnet "${target.name}": ${object.objectType}:${object.objectInstance} returned error class ${raw.errorClass} code ${raw.errorCode}`,
          );
          continue;
        }

        const coerced = this.coerce(raw, object);
        if (coerced !== undefined) values[object.telemetryKey] = coerced;
      }
    }

    return values;
  }

  /**
   * BACnet application values arrive as numbers, booleans, strings, Dates or
   * `{value}` wrappers for bit strings. Coerce to the declared telemetry type;
   * an un-coercible value is dropped rather than stored as NaN.
   */
  private coerce(raw: any, object: ResolvedObject): any {
    if (raw === null || raw === undefined) return undefined;

    switch (object.dataType) {
      case 'string':
        if (typeof raw === 'object') {
          // statusFlags and the like decode to a bit-string object; its JSON
          // is more useful than "[object Object]".
          return JSON.stringify(raw);
        }
        return String(raw);

      case 'boolean':
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'number') return raw !== 0;
        if (typeof raw === 'string') {
          const lowered = raw.trim().toLowerCase();
          if (['1', 'true', 'active', 'on'].includes(lowered)) return true;
          if (['0', 'false', 'inactive', 'off'].includes(lowered)) return false;
        }
        return undefined;

      case 'number':
      default: {
        const numeric =
          typeof raw === 'boolean'
            ? Number(raw)
            : typeof raw === 'object'
              ? Number((raw as any).value)
              : Number(raw);
        if (!Number.isFinite(numeric)) return undefined;
        return object.scale !== undefined ? numeric * object.scale : numeric;
      }
    }
  }

  private async recordStatus(
    rowId: string,
    status: 'ok' | 'error',
    message: string | null,
  ): Promise<void> {
    try {
      await this.bacnetRepository.update(rowId, {
        lastStatus: status,
        lastMessage: message,
      });
    } catch (error) {
      this.logger.debug(
        `BACnet status update failed for ${rowId}: ${(error as Error).message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DISCOVERY — Who-Is / I-Am
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Broadcast a Who-Is and collect I-Am answers.
   *
   * This exists because BACnet identifies a device by its **instance number**,
   * a 22-bit integer that is not on the nameplate, not derivable from the IP
   * and not guessable. Without discovery, adding a controller means asking the
   * mechanical contractor for a number.
   *
   * The window is a fixed listen period rather than a count: Who-Is is an
   * unconfirmed broadcast, so there is no "all devices have answered" signal —
   * you listen, and whatever arrived is what is there. `lowLimit`/`highLimit`
   * narrow the broadcast where a large site would otherwise answer with
   * hundreds of devices at once.
   */
  async discover(options?: {
    windowMs?: number;
    lowLimit?: number;
    highLimit?: number;
    /** Unicast target, for a device behind a BBMD that ignores broadcasts. */
    address?: string;
    /** Ask each answering device for its object name and model. */
    describe?: boolean;
    /** Tenant whose existing rows are checked, to flag duplicates. */
    tenantId?: string;
  }): Promise<{
    windowMs: number;
    devices: BacnetDiscoveredDevice[];
    note: string;
  }> {
    const client = await this.getClient();
    const windowMs = Math.min(
      MAX_DISCOVERY_WINDOW_MS,
      Math.max(1000, Number(options?.windowMs ?? DEFAULT_DISCOVERY_WINDOW_MS)),
    );

    const found = new Map<string, BacnetDiscoveredDevice>();

    const onIAm = (message: any) => {
      const address = message?.header?.sender?.address;
      const payload = message?.payload;
      if (!address || payload?.deviceId === undefined) return;
      // Keyed by instance number, not address: a BBMD forwards on behalf of
      // devices, so two answers can share a source address while being
      // different devices — and the instance number is the identity.
      const key = String(payload.deviceId);
      if (found.has(key)) return;
      found.set(key, {
        address,
        deviceInstance: Number(payload.deviceId),
        maxApdu: payload.maxApdu,
        segmentation: payload.segmentation,
        vendorId: payload.vendorId,
      });
    };

    client.on('iAm', onIAm);
    try {
      if (options?.address) {
        client.whoIs(this.formatReceiver(options.address, DEFAULT_PORT), {
          lowLimit: options.lowLimit,
          highLimit: options.highLimit,
        });
      } else {
        client.whoIs({
          lowLimit: options?.lowLimit,
          highLimit: options?.highLimit,
        });
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, windowMs);
        timer.unref?.();
      });
    } finally {
      // `off` rather than `removeAllListeners`: another concurrent discovery
      // may be listening on the same shared client.
      client.off?.('iAm', onIAm);
    }

    const devices = [...found.values()].sort(
      (a, b) => a.deviceInstance - b.deviceInstance,
    );

    // Names make the list usable. "Instance 2001" is not something an operator
    // can match to a chiller; "AHU-3 / Trane" is.
    if (options?.describe !== false) {
      for (const device of devices) {
        Object.assign(device, await this.describeDevice(client, device));
      }
    }

    if (options?.tenantId) {
      const existing = await this.bacnetRepository.find({
        where: { tenantId: options.tenantId, deletedAt: IsNull() },
        select: ['deviceInstance'],
      });
      const claimed = new Set(existing.map((row) => row.deviceInstance));
      for (const device of devices) {
        device.alreadyRegistered = claimed.has(device.deviceInstance);
      }
    }

    return {
      windowMs,
      devices,
      note:
        devices.length === 0
          ? 'No device answered. Who-Is is a UDP broadcast, so it does not cross ' +
            'subnets: the platform has to be on the BACnet network, or reach it ' +
            'through a BBMD. Try a unicast address if you know one.'
          : `${devices.length} device(s) answered within ${windowMs}ms. Listening longer may find more — Who-Is is unconfirmed, so there is no "complete" signal.`,
    };
  }

  /**
   * Read a discovered device's own Device-object name, model and vendor.
   *
   * Best-effort and never fatal: a controller that answers Who-Is but refuses
   * a ReadProperty on its Device object is still a device worth listing, just
   * without a label.
   */
  private async describeDevice(
    client: any,
    device: BacnetDiscoveredDevice,
  ): Promise<Partial<BacnetDiscoveredDevice>> {
    const deviceTypeId = this.lookupEnum(this.bacnetEnum.ObjectType, 'device');
    if (deviceTypeId === undefined) return {};

    const read = (propertyName: string): Promise<string | undefined> => {
      const propertyId = this.lookupEnum(
        this.bacnetEnum.PropertyIdentifier,
        propertyName,
      );
      if (propertyId === undefined) return Promise.resolve(undefined);

      return new Promise<string | undefined>((resolve) => {
        let settled = false;
        const finish = (value?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(undefined), 3000);
        timer.unref?.();
        try {
          client.readProperty(
            device.address,
            { type: deviceTypeId, instance: device.deviceInstance },
            propertyId,
            {},
            (error: Error | null, result: any) => {
              if (error) return finish(undefined);
              const raw = result?.values?.[0]?.value;
              finish(
                raw === null || raw === undefined ? undefined : String(raw),
              );
            },
          );
        } catch {
          finish(undefined);
        }
      });
    };

    const [objectName, modelName, vendorName] = await Promise.all([
      read('objectName'),
      read('modelName'),
      read('vendorName'),
    ]);

    return { objectName, modelName, vendorName };
  }

  // ── StandardTelemetry mapping ─────────────────────────────────────────────

  parse(rawPayload: any, context?: any): StandardTelemetry {
    const target: Partial<BacnetTarget> = context ?? {};
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
      // Same closed-union cast SnmpAdapter documents: 'bacnet' is the honest
      // value and is what reaches Kafka and the telemetry row. Widening
      // StandardTelemetry['protocol'] is the real fix.
      protocol: 'bacnet' as StandardTelemetry['protocol'],
      metadata: {
        bacnetDevice: target.name,
        bacnetAddress: target.address,
        bacnetInstance: target.deviceInstance,
        polled: true,
        codecId: target.codecId,
        manufacturer: target.manufacturer,
        model: target.model,
      },
      rawPayload: payload,
    };
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  getScheduledTargets(): Array<{
    rowId: string;
    name: string;
    address: string;
    deviceInstance: number;
    deviceKey: string;
    pollIntervalMs: number;
    objects: number;
    rpmUnsupported: boolean;
    consecutiveFailures: number;
  }> {
    return [...this.scheduled.values()].map((entry) => ({
      rowId: entry.target.rowId,
      name: entry.target.name,
      address: entry.target.address,
      deviceInstance: entry.target.deviceInstance,
      deviceKey: entry.target.deviceKey,
      pollIntervalMs: entry.target.pollIntervalMs,
      objects: entry.target.objects.length,
      rpmUnsupported: entry.rpmUnsupported,
      consecutiveFailures: entry.consecutiveFailures,
    }));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** The port the shared socket binds, for the status route. */
  getBindPort(): number {
    return this.bindPort;
  }
}
