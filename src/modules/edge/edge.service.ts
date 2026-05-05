// src/modules/edge/edge.service.ts
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Inject } from '@nestjs/common';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import { EdgeInstance } from './entities/edge-instance.entity';
import { EdgeMetricsSnapshot } from './entities/edge-metrics-snapshot.entity';
import { EdgeCommand, EdgeCommandStatus } from './entities/edge-command.entity';
import { CreateEdgeInstanceDto } from './dto/create-edge-instance.dto';
import { UpdateEdgeInstanceDto } from './dto/update-edge-instance.dto';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { DispatchCommandDto } from './dto/dispatch-command.dto';
import { AckCommandDto } from './dto/ack-command.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EdgeStatus } from '@common/enums/edge.enum';
import { Device } from '@modules/devices/entities/device.entity';

@Injectable()
export class EdgeService {
  private readonly logger = new Logger(EdgeService.name);

  constructor(
    @InjectRepository(EdgeInstance)
    private readonly edgeRepository: Repository<EdgeInstance>,

    @InjectRepository(EdgeMetricsSnapshot)
    private readonly snapshotRepository: Repository<EdgeMetricsSnapshot>,

    @InjectRepository(EdgeCommand)
    private readonly commandRepository: Repository<EdgeCommand>,

    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,

    @Inject(EventEmitter2)
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // TOKEN GENERATION
  // ──────────────────────────────────────────────────────────────────────────

  private generateEdgeToken(): string {
    return 'edge_' + randomBytes(32).toString('hex');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────────────────────────────────

 async create(
  userId: string,
  tenantId: string,
  createDto: CreateEdgeInstanceDto,
): Promise<EdgeInstance> {
  const edgeToken = this.generateEdgeToken();

  const edge = this.edgeRepository.create({
    ...createDto,
    userId,
    tenantId,
    createdBy: userId,
    edgeToken,
    status: EdgeStatus.OFFLINE,
    deviceCount: 0,
    dataSync: { pending: 0 },
  });

  return await this.edgeRepository.save(edge);
}

async findAll(
  userId: string,
  tenantId: string,
  paginationDto: PaginationDto,
) {
  const {
    page = 1,
    limit = 10,
    search,
    sortBy = 'createdAt',
    sortOrder = 'DESC',
  } = paginationDto;

  const qb = this.edgeRepository
    .createQueryBuilder('edge')
    .where('edge.userId = :userId', { userId })
    .andWhere('edge.tenantId = :tenantId', { tenantId });

  if (search) {
    qb.andWhere(
      '(edge.name ILIKE :search OR edge.location ILIKE :search OR edge.ipAddress ILIKE :search)',
      { search: `%${search}%` },
    );
  }

  qb.orderBy(`edge.${sortBy}`, sortOrder as 'ASC' | 'DESC')
    .skip((page - 1) * limit)
    .take(limit);

  const [data, total] = await qb.getManyAndCount();

  data.forEach((e) => { e.edgeToken = undefined as any; });

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

async findOne(
  id: string,
  userId: string,
  tenantId: string,
): Promise<EdgeInstance> {
  const edge = await this.edgeRepository.findOne({
    where: { id, userId, tenantId },
  });
  if (!edge) throw new NotFoundException('Edge instance not found');

  // Wipe the token from the instance in-place rather than spreading —
  // keeps the class prototype (and all methods) intact
  edge.edgeToken = undefined as any;
  return edge;
}

async update(
  id: string,
  userId: string,
  tenantId: string,
  updateDto: UpdateEdgeInstanceDto,
): Promise<EdgeInstance> {
  const edge = await this.edgeRepository.findOne({
    where: { id, userId, tenantId },
  });
  if (!edge) throw new NotFoundException('Edge instance not found');

  Object.assign(edge, updateDto);
  edge.updatedBy = userId;
  const saved = await this.edgeRepository.save(edge);

  saved.edgeToken = undefined as any;
  return saved;
}

  async remove(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<void> {
    const edge = await this.edgeRepository.findOne({
      where: { id, userId, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge instance not found');
    await this.edgeRepository.softRemove(edge);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TOKEN ROTATION
  // ──────────────────────────────────────────────────────────────────────────

  async regenerateToken(
    id: string,
    userId: string,
    tenantId: string,
  ): Promise<{ edgeToken: string }> {
    const edge = await this.edgeRepository.findOne({
      where: { id, userId, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge instance not found');

    edge.edgeToken = this.generateEdgeToken();
    edge.updatedBy = userId;
    await this.edgeRepository.save(edge);

    return { edgeToken: edge.edgeToken };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HEARTBEAT
  // ──────────────────────────────────────────────────────────────────────────

  async heartbeat(
    id: string,
    dto: HeartbeatDto,
  ): Promise<{ ok: boolean; pendingCommands: number }> {
    // Authenticate via edgeToken — no JWT on this endpoint
    const edge = await this.edgeRepository.findOne({
      where: { id, edgeToken: dto.edgeToken },
    });
    if (!edge) {
      throw new UnauthorizedException('Invalid edge token');
    }

    // Update status, metrics, lastSeen
    edge.status = EdgeStatus.ONLINE;
    edge.updateMetrics(dto.metrics);
    edge.updateSyncStatus(dto.pendingSync, true);

    await this.edgeRepository.save(edge);

    // Persist a metrics snapshot for history
    await this.snapshotRepository.save(
      this.snapshotRepository.create({
        edgeId: edge.id,
        tenantId: edge.tenantId,
        cpu: dto.metrics.cpu,
        memory: dto.metrics.memory,
        storage: dto.metrics.storage,
        uptime: dto.metrics.uptime,
        temperature: dto.metrics.temperature,
        networkIn: dto.metrics.networkIn,
        networkOut: dto.metrics.networkOut,
      }),
    );

    // Tell the agent how many pending commands are waiting
    const pendingCommands = await this.commandRepository.count({
      where: { edgeId: id, status: EdgeCommandStatus.PENDING },
    });

    return { ok: true, pendingCommands };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // OFFLINE DETECTION CRON
  // ──────────────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async detectOfflineEdges(): Promise<void> {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);

    const staleEdges = await this.edgeRepository.find({
      where: {
        status: EdgeStatus.ONLINE,
        lastSeen: LessThan(twoMinutesAgo),
      },
    });

    if (staleEdges.length === 0) return;

    this.logger.log(
      `Offline detection: marking ${staleEdges.length} edge(s) as OFFLINE`,
    );

    for (const edge of staleEdges) {
      edge.status = EdgeStatus.OFFLINE;
      await this.edgeRepository.save(edge);

      this.eventEmitter.emit('edge.offline', {
        edgeId: edge.id,
        tenantId: edge.tenantId,
        userId: edge.userId,
        name: edge.name,
        lastSeen: edge.lastSeen,
      });

      this.logger.warn(
        `Edge "${edge.name}" (${edge.id}) marked OFFLINE — last seen: ${edge.lastSeen?.toISOString()}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // METRICS HISTORY
  // ──────────────────────────────────────────────────────────────────────────

  async getMetricsHistory(
    id: string,
    userId: string,
    tenantId: string,
    hours: number = 24,
  ) {
    // Verify ownership first
    const edge = await this.edgeRepository.findOne({
      where: { id, userId, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge instance not found');

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const snapshots = await this.snapshotRepository
      .createQueryBuilder('snap')
      .where('snap.edgeId = :edgeId', { edgeId: id })
      .andWhere('snap.recordedAt >= :since', { since })
      .orderBy('snap.recordedAt', 'ASC')
      .getMany();

    return {
      edgeId: id,
      edgeName: edge.name,
      hours,
      count: snapshots.length,
      snapshots,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DEVICE ASSOCIATION
  // ──────────────────────────────────────────────────────────────────────────

  async getDevices(id: string, userId: string, tenantId: string) {
    // Ownership check
    const edge = await this.edgeRepository.findOne({
      where: { id, userId, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge instance not found');

    const devices = await this.deviceRepository.find({
      where: { edgeId: id, tenantId },
    });

    return { edgeId: id, edgeName: edge.name, count: devices.length, devices };
  }

  async assignDevice(
    id: string,
    deviceId: string,
    userId: string,
    tenantId: string,
  ): Promise<{ message: string }> {
    const [edge, device] = await Promise.all([
      this.edgeRepository.findOne({ where: { id, userId, tenantId } }),
      this.deviceRepository.findOne({ where: { id: deviceId, tenantId } }),
    ]);

    if (!edge) throw new NotFoundException('Edge instance not found');
    if (!device) throw new NotFoundException('Device not found');

    // Unassign from current edge if already assigned elsewhere
    const wasOnDifferentEdge = device.edgeId && device.edgeId !== id;

    device.edgeId = id;
    await this.deviceRepository.save(device);

    // Keep deviceCount consistent
    await this.syncDeviceCount(id);

    if (wasOnDifferentEdge) {
      await this.syncDeviceCount(device.edgeId!);
    }

    return { message: `Device ${deviceId} assigned to edge ${id}` };
  }

  async unassignDevice(
    id: string,
    deviceId: string,
    userId: string,
    tenantId: string,
  ): Promise<{ message: string }> {
    const [edge, device] = await Promise.all([
      this.edgeRepository.findOne({ where: { id, userId, tenantId } }),
      this.deviceRepository.findOne({
        where: { id: deviceId, edgeId: id, tenantId },
      }),
    ]);

    if (!edge) throw new NotFoundException('Edge instance not found');
    if (!device) {
      throw new NotFoundException(
        'Device not found or not assigned to this edge',
      );
    }

    device.edgeId = undefined;
    await this.deviceRepository.save(device);
    await this.syncDeviceCount(id);

    return { message: `Device ${deviceId} unassigned from edge ${id}` };
  }

  private async syncDeviceCount(edgeId: string): Promise<void> {
    const count = await this.deviceRepository.count({
      where: { edgeId },
    });
    await this.edgeRepository.update({ id: edgeId }, { deviceCount: count });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COMMAND DISPATCH
  // ──────────────────────────────────────────────────────────────────────────

  async dispatchCommand(
    id: string,
    userId: string,
    tenantId: string,
    dto: DispatchCommandDto,
  ): Promise<EdgeCommand> {
    const edge = await this.edgeRepository.findOne({
      where: { id, userId, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge instance not found');

    const command = this.commandRepository.create({
      edgeId: id,
      tenantId,
      command: dto.command,
      payload: dto.payload,
      status: EdgeCommandStatus.PENDING,
    });

    return await this.commandRepository.save(command);
  }

  async getPendingCommands(
    id: string,
    edgeToken: string,
  ): Promise<EdgeCommand[]> {
    // Agent-facing: authenticate by edgeToken
    const edge = await this.edgeRepository.findOne({
      where: { id, edgeToken },
    });
    if (!edge) throw new UnauthorizedException('Invalid edge token');

    const commands = await this.commandRepository.find({
      where: { edgeId: id, status: EdgeCommandStatus.PENDING },
      order: { issuedAt: 'ASC' },
    });

    // Mark as delivered in bulk
    if (commands.length > 0) {
      const now = new Date();
      const ids = commands.map((c) => c.id);

      await this.commandRepository
        .createQueryBuilder()
        .update(EdgeCommand)
        .set({ status: EdgeCommandStatus.DELIVERED, deliveredAt: now })
        .whereInIds(ids)
        .execute();

      commands.forEach((c) => {
        c.status = EdgeCommandStatus.DELIVERED;
        c.deliveredAt = now;
      });
    }

    return commands;
  }

  async ackCommand(
    id: string,
    commandId: string,
    edgeToken: string,
    dto: AckCommandDto,
  ): Promise<EdgeCommand> {
    // Agent-facing: authenticate by edgeToken
    const edge = await this.edgeRepository.findOne({
      where: { id, edgeToken },
    });
    if (!edge) throw new UnauthorizedException('Invalid edge token');

    const command = await this.commandRepository.findOne({
      where: { id: commandId, edgeId: id },
    });
    if (!command) throw new NotFoundException('Command not found');

    command.status =
      dto.result === 'executed'
        ? EdgeCommandStatus.EXECUTED
        : EdgeCommandStatus.FAILED;
    command.executedAt = new Date();
    command.resultMessage = dto.message;

    return await this.commandRepository.save(command);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STATISTICS
  // ──────────────────────────────────────────────────────────────────────────

  async getStatistics(userId: string, tenantId: string) {
    const [total, online, offline, error] = await Promise.all([
      this.edgeRepository.count({ where: { userId, tenantId } }),
      this.edgeRepository.count({
        where: { userId, tenantId, status: EdgeStatus.ONLINE },
      }),
      this.edgeRepository.count({
        where: { userId, tenantId, status: EdgeStatus.OFFLINE },
      }),
      this.edgeRepository.count({
        where: { userId, tenantId, status: EdgeStatus.ERROR },
      }),
    ]);

    // Average metrics across all ONLINE edges
    const metricsResult = await this.edgeRepository
      .createQueryBuilder('edge')
      .select([
        "AVG((edge.metrics->>'cpu')::float)",     'avgCpu',
        "AVG((edge.metrics->>'memory')::float)",  'avgMemory',
        "AVG((edge.metrics->>'storage')::float)", 'avgStorage',
      ])
      .where('edge.userId = :userId', { userId })
      .andWhere('edge.tenantId = :tenantId', { tenantId })
      .andWhere('edge.status = :status', { status: EdgeStatus.ONLINE })
      .andWhere('edge.metrics IS NOT NULL')
      .getRawOne();

    // Total pending sync messages
    const syncResult = await this.edgeRepository
      .createQueryBuilder('edge')
      .select("SUM((edge.dataSync->>'pending')::int)", 'totalPending')
      .where('edge.userId = :userId', { userId })
      .andWhere('edge.tenantId = :tenantId', { tenantId })
      .andWhere('edge.dataSync IS NOT NULL')
      .getRawOne();

    // Edges that need attention (failedAttempts > 3)
    const needsAttention = await this.edgeRepository
      .createQueryBuilder('edge')
      .where('edge.userId = :userId', { userId })
      .andWhere('edge.tenantId = :tenantId', { tenantId })
      .andWhere("(edge.dataSync->>'failedAttempts')::int > 3")
      .andWhere('edge.dataSync IS NOT NULL')
      .select(['edge.id', 'edge.name', 'edge.status', 'edge.lastSeen'])
      .getMany();

    const round = (n: string | null, dec = 1) =>
      n ? parseFloat(parseFloat(n).toFixed(dec)) : null;

    return {
      total,
      online,
      offline,
      error,
      averageMetrics: {
        cpu:     round(metricsResult?.avgCpu),
        memory:  round(metricsResult?.avgMemory),
        storage: round(metricsResult?.avgStorage),
      },
      totalPendingSync: parseInt(syncResult?.totalPending ?? '0', 10),
      needsAttention: needsAttention.map((e) => ({
        id:           e.id,
        name:         e.name,
        status:       e.status,
        lastSeen:     e.lastSeen,
        failedAttempts: (e.dataSync?.failedAttempts ?? 0),
      })),
    };
  }
}