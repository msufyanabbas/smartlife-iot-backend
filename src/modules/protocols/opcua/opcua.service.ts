// src/modules/protocols/opcua/opcua.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { OpcuaServer } from './entities/opcua-server.entity';
import { Device } from '@modules/devices/entities/device.entity';
import {
  OpcuaAdapter,
  type OpcuaBrowseEntry,
  type OpcuaTestResult,
} from '../adapters/opcua.adapter';
import { encryptSecret } from '@common/utils/secret-box';
import type {
  CreateOpcuaServerDto,
  UpdateOpcuaServerDto,
} from './dto/opcua-server.dto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * OPC-UA server registry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every query is pinned to the tenant, and a row outside the caller's tenant
 * answers **404, not 403** — a 403 confirms the id exists, which turns a detail
 * route into an enumeration oracle (CLAUDE.md §4g).
 *
 * The connection test and the browse both run through `OpcuaAdapter`, so a
 * pass here means the adapter will connect with the same credentials, security
 * mode and NodeIds that the live subscription uses. A test that reimplemented
 * the connection could pass while the real path failed.
 */
@Injectable()
export class OpcuaService {
  private readonly logger = new Logger(OpcuaService.name);

  constructor(
    @InjectRepository(OpcuaServer)
    private readonly repo: Repository<OpcuaServer>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    private readonly adapter: OpcuaAdapter,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string): Promise<OpcuaServer[]> {
    return this.repo.find({
      where: { tenantId },
      order: { name: 'ASC' },
    });
  }

  async findOne(id: string, tenantId: string): Promise<OpcuaServer> {
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('OPC-UA server not found');
    return row;
  }

  /**
   * The same row with `passwordEncrypted` attached.
   *
   * Separate from `findOne` so the credential is loaded only on the two paths
   * that need it (connect, browse) and can never be returned to a client by
   * accident — the column is `select: false` precisely so that
   * `findOne` cannot leak it.
   */
  private async findOneWithSecret(
    id: string,
    tenantId: string,
  ): Promise<OpcuaServer> {
    const row = await this.repo
      .createQueryBuilder('server')
      .addSelect('server.passwordEncrypted')
      .where('server.id = :id', { id })
      .andWhere('server.tenantId = :tenantId', { tenantId })
      .getOne();
    if (!row) throw new NotFoundException('OPC-UA server not found');
    return row;
  }

  /**
   * What the adapter is currently doing, intersected with this tenant's rows.
   *
   * `getConnectedServers()` is process-wide, so it is filtered here — an
   * unfiltered status route would tell one tenant how many OPC-UA endpoints
   * another tenant runs.
   */
  async getStatus(tenantId: string) {
    const rows = await this.repo.find({
      where: { tenantId },
      select: ['id', 'name', 'enabled', 'lastStatus', 'lastMessage', 'lastReadingAt'],
    });
    const mine = new Set(rows.map((row) => row.id));
    const live = this.adapter
      .getConnectedServers()
      .filter((entry) => mine.has(entry.rowId));

    return {
      adapterEnabled: this.adapter.isEnabled(),
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      connected: live.length,
      subscriptionRows: live.filter((e) => e.mode === 'subscription').length,
      pollingRows: live.filter((e) => e.mode === 'poll').length,
      monitoredItems: live.reduce((sum, e) => sum + e.monitoredItems, 0),
      servers: rows.map((row) => {
        const entry = live.find((e) => e.rowId === row.id);
        return {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          lastStatus: row.lastStatus ?? null,
          lastMessage: row.lastMessage ?? null,
          lastReadingAt: row.lastReadingAt ?? null,
          live: !!entry,
          mode: entry?.mode ?? null,
          monitoredItems: entry?.monitoredItems ?? 0,
        };
      }),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITES
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateOpcuaServerDto,
  ): Promise<OpcuaServer> {
    await this.assertNameFree(tenantId, dto.name);
    if (dto.deviceId) await this.assertDeviceInTenant(dto.deviceId, tenantId);
    this.assertKeysUnique(dto.nodes);

    const { password, nodes, ...rest } = dto;
    const row = this.repo.create({
      ...rest,
      nodes: nodes ?? [],
      tenantId,
      createdBy: userId,
      passwordEncrypted: password ? encryptSecret(password) : null,
      readingCount: '0',
    });

    const saved = await this.repo.save(row);
    this.logger.log(
      `OPC-UA server "${saved.name}" created for tenant ${tenantId} — it will connect within one refresh interval`,
    );
    // Deliberately not forcing an immediate refresh: `refreshTargets()` is the
    // one place that reconciles, and calling it from a request would make a
    // slow or unreachable PLC the request's problem.
    return this.findOne(saved.id, tenantId);
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    dto: UpdateOpcuaServerDto,
  ): Promise<OpcuaServer> {
    const existing = await this.findOne(id, tenantId);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(tenantId, dto.name, id);
    }
    if (dto.deviceId) await this.assertDeviceInTenant(dto.deviceId, tenantId);
    if (dto.nodes) this.assertKeysUnique(dto.nodes);

    const { password, ...rest } = dto;
    Object.assign(existing, rest, { updatedBy: userId });

    // An absent password means "leave it alone": the screen never receives the
    // stored password, so it cannot send it back, and treating absent as
    // "clear" would wipe the credential on every unrelated edit. An explicit
    // empty string is the way to clear it — which also switches the session to
    // anonymous, so it has to be expressible.
    if (typeof password === 'string') {
      existing.passwordEncrypted = password ? encryptSecret(password) : null;
    }

    await this.repo.save(existing);
    this.logger.log(
      `OPC-UA server "${existing.name}" updated — the adapter reconnects on its next refresh`,
    );
    return this.findOne(id, tenantId);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const row = await this.findOne(id, tenantId);
    // Soft delete, matching every other entity here. `refreshTargets()` filters
    // on `deletedAt IS NULL`, so the session is dropped on the next refresh.
    await this.repo.softRemove(row);
  }

  async setEnabled(
    id: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<OpcuaServer> {
    const row = await this.findOne(id, tenantId);
    row.enabled = enabled;
    if (!enabled) {
      row.lastStatus = 'disconnected';
      row.lastMessage = 'Disabled by an operator';
    }
    await this.repo.save(row);
    return this.findOne(id, tenantId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE OPERATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /** Connect for real, read the mapped nodes, record the outcome on the row. */
  async testConnection(
    id: string,
    tenantId: string,
  ): Promise<OpcuaTestResult> {
    const row = await this.findOneWithSecret(id, tenantId);
    const result = await this.adapter.testConnection(row);

    await this.repo.update(id, {
      lastStatus: result.success ? 'connected' : 'error',
      lastMessage: result.message,
      ...(result.success ? { lastConnectedAt: new Date() } : {}),
    });

    return result;
  }

  /**
   * Test a configuration that has not been saved yet.
   *
   * Without this, the only way to find out whether an endpoint and credential
   * work is to save a row that does not work — and then the row exists, the
   * adapter keeps retrying it, and the operator's screen is full of errors
   * from a mistake they already know about.
   */
  async testDraft(
    tenantId: string,
    dto: CreateOpcuaServerDto,
  ): Promise<OpcuaTestResult> {
    const draft = this.repo.create({
      ...dto,
      nodes: dto.nodes ?? [],
      tenantId,
    });
    return this.adapter.testConnection(draft, dto.password ?? null);
  }

  async browse(
    id: string,
    tenantId: string,
    nodeId?: string,
  ): Promise<{ nodeId: string; entries: OpcuaBrowseEntry[] }> {
    const row = await this.findOneWithSecret(id, tenantId);
    try {
      return await this.adapter.browse(row, nodeId);
    } catch (error) {
      // A browse failure is an operator-facing problem ("wrong credentials",
      // "node does not exist"), not a 500 — so it is reported as a 400 with
      // the server's own words rather than an opaque internal error.
      throw new BadRequestException(
        `Could not browse ${row.endpointUrl}: ${(error as Error).message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GUARDS
  // ══════════════════════════════════════════════════════════════════════════

  private async assertNameFree(
    tenantId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.repo.findOne({
      where: {
        tenantId,
        name,
        ...(exceptId ? { id: Not(exceptId) } : {}),
        deletedAt: IsNull(),
      },
    });
    if (clash) {
      throw new ConflictException(
        `An OPC-UA server named "${name}" already exists in this organisation`,
      );
    }
  }

  /**
   * The device must be in the CALLER's tenant.
   *
   * Taking `deviceId` from the body unchecked is the hole §4g found eight
   * times: it would let one tenant write telemetry onto another tenant's
   * device by naming its id.
   */
  private async assertDeviceInTenant(
    deviceId: string,
    tenantId: string,
  ): Promise<void> {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) {
      throw new NotFoundException('Device not found');
    }
  }

  /**
   * Two nodes mapped to one telemetry key would silently overwrite each other
   * inside the flush window, and the surviving value would depend on arrival
   * order. Rejected at save, where it can still be corrected.
   */
  private assertKeysUnique(
    nodes?: Array<{ key: string; nodeId: string }>,
  ): void {
    if (!nodes?.length) return;
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const node of nodes) {
      const key = node.key?.trim();
      if (!key) continue;
      const first = seen.get(key);
      if (first) clashes.push(`"${key}" (${first} and ${node.nodeId})`);
      else seen.set(key, node.nodeId);
    }
    if (clashes.length) {
      throw new BadRequestException(
        `Two nodes map to the same telemetry key: ${clashes.join('; ')}`,
      );
    }
  }
}
