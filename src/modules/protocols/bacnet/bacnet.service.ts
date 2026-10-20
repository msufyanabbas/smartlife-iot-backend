// src/modules/protocols/bacnet/bacnet.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { BacnetDevice } from './entities/bacnet-device.entity';
import { Device } from '@modules/devices/entities/device.entity';
import {
  BacnetAdapter,
  type BacnetDiscoveredDevice,
  type BacnetPollResult,
} from '../adapters/bacnet.adapter';
import type {
  BacnetDiscoverDto,
  CreateBacnetDeviceDto,
  UpdateBacnetDeviceDto,
} from './dto/bacnet-device.dto';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BACnet device registry
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every query is pinned to the tenant, and a row outside the caller's tenant
 * answers **404, not 403** (CLAUDE.md §4g).
 *
 * The test and discovery routes both run through `BacnetAdapter` and its one
 * shared UDP socket, so a pass means the poller will work with the same
 * address, instance number and object list.
 */
@Injectable()
export class BacnetService {
  private readonly logger = new Logger(BacnetService.name);

  constructor(
    @InjectRepository(BacnetDevice)
    private readonly repo: Repository<BacnetDevice>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    private readonly adapter: BacnetAdapter,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // READS
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(tenantId: string): Promise<BacnetDevice[]> {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }

  async findOne(id: string, tenantId: string): Promise<BacnetDevice> {
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('BACnet device not found');
    return row;
  }

  /** Adapter state, filtered to this tenant's rows. */
  async getStatus(tenantId: string) {
    const rows = await this.repo.find({
      where: { tenantId },
      select: [
        'id',
        'name',
        'enabled',
        'deviceInstance',
        'lastStatus',
        'lastMessage',
        'lastReadingAt',
      ],
    });
    const mine = new Set(rows.map((row) => row.id));
    const live = this.adapter
      .getScheduledTargets()
      .filter((entry) => mine.has(entry.rowId));

    return {
      adapterEnabled: this.adapter.isEnabled(),
      bindPort: this.adapter.getBindPort(),
      // Said out loud, because "no readings" with an adapter that was never
      // switched on is otherwise indistinguishable from a network fault.
      adapterNote: this.adapter.isEnabled()
        ? 'The BACnet poller is running.'
        : 'The BACnet poller is OFF. Set BACNET_ENABLED=true and map UDP 47808 — ' +
          'it is off by default because it binds a host UDP port.',
      total: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      polling: live.length,
      devices: rows.map((row) => {
        const entry = live.find((candidate) => candidate.rowId === row.id);
        return {
          id: row.id,
          name: row.name,
          deviceInstance: row.deviceInstance,
          enabled: row.enabled,
          lastStatus: row.lastStatus ?? null,
          lastMessage: row.lastMessage ?? null,
          lastReadingAt: row.lastReadingAt ?? null,
          live: !!entry,
          objects: entry?.objects ?? 0,
          // Worth surfacing: it means the controller rejected
          // ReadPropertyMultiple and is being read one object at a time, which
          // is far slower and explains a long poll cycle.
          readingOneByOne: entry?.rpmUnsupported ?? false,
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
    dto: CreateBacnetDeviceDto,
  ): Promise<BacnetDevice> {
    await this.assertNameFree(tenantId, dto.name);
    await this.assertInstanceFree(tenantId, dto.deviceInstance);
    if (dto.deviceId) await this.assertDeviceInTenant(dto.deviceId, tenantId);
    this.assertKeysUnique(dto.objects);

    const row = this.repo.create({
      ...dto,
      objects: dto.objects ?? [],
      tenantId,
      createdBy: userId,
      readingCount: '0',
    });

    const saved = await this.repo.save(row);
    this.logger.log(
      `BACnet device "${saved.name}" (instance ${saved.deviceInstance}) created for tenant ${tenantId}`,
    );
    return this.findOne(saved.id, tenantId);
  }

  async update(
    id: string,
    tenantId: string,
    userId: string,
    dto: UpdateBacnetDeviceDto,
  ): Promise<BacnetDevice> {
    const existing = await this.findOne(id, tenantId);

    if (dto.name && dto.name !== existing.name) {
      await this.assertNameFree(tenantId, dto.name, id);
    }
    if (
      dto.deviceInstance !== undefined &&
      dto.deviceInstance !== existing.deviceInstance
    ) {
      await this.assertInstanceFree(tenantId, dto.deviceInstance, id);
    }
    if (dto.deviceId) await this.assertDeviceInTenant(dto.deviceId, tenantId);
    if (dto.objects) this.assertKeysUnique(dto.objects);

    Object.assign(existing, dto, { updatedBy: userId });
    await this.repo.save(existing);
    return this.findOne(id, tenantId);
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const row = await this.findOne(id, tenantId);
    await this.repo.softRemove(row);
  }

  async setEnabled(
    id: string,
    tenantId: string,
    enabled: boolean,
  ): Promise<BacnetDevice> {
    const row = await this.findOne(id, tenantId);
    row.enabled = enabled;
    await this.repo.save(row);
    return this.findOne(id, tenantId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LIVE OPERATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Poll the controller once, right now, and report what came back.
   *
   * This DOES ingest: the reading goes through `handleTelemetry()` like a
   * scheduled poll, because a test that read the values and threw them away
   * would not prove the path that matters. `POST /integrations/:id/test`
   * behaves the same way and reports its side effect for the same reason.
   */
  async testRead(id: string, tenantId: string): Promise<BacnetPollResult> {
    const row = await this.findOneForAdapter(id, tenantId);
    const target = await this.adapter.resolveTarget(row);
    if (!target) {
      throw new BadRequestException(
        'This row cannot be polled yet — it needs at least one mapped object ' +
          'and a platform device for the readings to land on.',
      );
    }
    return this.adapter.pollTarget(target);
  }

  /**
   * Who-Is discovery.
   *
   * 503 rather than 500 when the adapter is off: the request is well formed and
   * will work once UDP 47808 is bound, and saying so is more useful than a
   * generic failure.
   */
  async discover(
    tenantId: string,
    dto: BacnetDiscoverDto,
  ): Promise<{
    windowMs: number;
    devices: BacnetDiscoveredDevice[];
    note: string;
  }> {
    if (!this.adapter.isEnabled()) {
      throw new ServiceUnavailableException(
        'The BACnet adapter is disabled, so no Who-Is can be sent. Set ' +
          'BACNET_ENABLED=true and map UDP 47808 into the container.',
      );
    }
    try {
      return await this.adapter.discover({ ...dto, tenantId });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Discovery could not run: ${(error as Error).message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GUARDS
  // ══════════════════════════════════════════════════════════════════════════

  private async findOneForAdapter(
    id: string,
    tenantId: string,
  ): Promise<BacnetDevice> {
    return this.findOne(id, tenantId);
  }

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
        `A BACnet device named "${name}" already exists in this organisation`,
      );
    }
  }

  /**
   * Two rows claiming one instance number means one of them is addressing the
   * wrong controller, and the poll would read the same points into two
   * different platform devices.
   */
  private async assertInstanceFree(
    tenantId: string,
    deviceInstance: number,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.repo.findOne({
      where: {
        tenantId,
        deviceInstance,
        ...(exceptId ? { id: Not(exceptId) } : {}),
        deletedAt: IsNull(),
      },
    });
    if (clash) {
      throw new ConflictException(
        `Device instance ${deviceInstance} is already registered as "${clash.name}". ` +
          'A BACnet instance number is unique on the internetwork, so two rows ' +
          'cannot both be right.',
      );
    }
  }

  private async assertDeviceInTenant(
    deviceId: string,
    tenantId: string,
  ): Promise<void> {
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');
  }

  private assertKeysUnique(
    objects?: Array<{ telemetryKey: string; objectType: string; objectInstance: number }>,
  ): void {
    if (!objects?.length) return;
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const object of objects) {
      const key = object.telemetryKey?.trim();
      if (!key) continue;
      const label = `${object.objectType}:${object.objectInstance}`;
      const first = seen.get(key);
      if (first) clashes.push(`"${key}" (${first} and ${label})`);
      else seen.set(key, label);
    }
    if (clashes.length) {
      throw new BadRequestException(
        `Two objects map to the same telemetry key: ${clashes.join('; ')}`,
      );
    }
  }
}
