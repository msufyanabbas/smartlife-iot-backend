// src/modules/edge/edge.service.ts
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { randomBytes, createHash, randomUUID } from 'crypto';

import { Edge } from './entities/edge.entity';
import {
  EdgeEvent,
  EdgeEventSeverity,
  EdgeEventType,
} from './entities/edge-event.entity';
import {
  EdgeCommand,
  EdgeCommandType,
} from './entities/edge-command.entity';
import { EdgeMetricsSnapshot } from './entities/edge-metrics-snapshot.entity';
import { CreateEdgeDto } from './dto/create-edge.dto';
import { UpdateEdgeDto } from './dto/update-edge.dto';
import { AgentHeartbeatDto } from './dto/agent-heartbeat.dto';
import { AgentRegisterDto } from './dto/agent-register.dto';
import { SendCommandDto } from './dto/send-command.dto';

import { Device } from '@modules/devices/entities/device.entity';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Node } from '@modules/nodes/entities/node.entity';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';
import {
  NotificationChannel,
  NotificationPriority,
  NotificationType,
} from '@common/enums/index.enum';

/** An edge is considered lost after this long without a heartbeat. */
const OFFLINE_AFTER_MS = 2 * 60 * 1000;

const DEFAULT_SYNC_CONFIG = {
  syncRules: true,
  syncDashboards: true,
  syncDevices: true,
  syncInterval: 300,
  offlineBufferHours: 24,
};

@Injectable()
export class EdgeService {
  private readonly logger = new Logger(EdgeService.name);

  constructor(
    @InjectRepository(Edge)
    private readonly edgeRepository: Repository<Edge>,
    @InjectRepository(EdgeEvent)
    private readonly eventRepository: Repository<EdgeEvent>,
    @InjectRepository(EdgeCommand)
    private readonly commandRepository: Repository<EdgeCommand>,
    @InjectRepository(EdgeMetricsSnapshot)
    private readonly snapshotRepository: Repository<EdgeMetricsSnapshot>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(RuleChain)
    private readonly ruleChainRepository: Repository<RuleChain>,
    @InjectRepository(Dashboard)
    private readonly dashboardRepository: Repository<Dashboard>,
    @InjectRepository(Node)
    private readonly nodeRepository: Repository<Node>,
    private readonly notificationsService: NotificationsService,
    private readonly websocketGateway: WebsocketGateway,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    dto: CreateEdgeDto,
    tenantId: string,
    userId: string,
  ): Promise<Edge> {
    const edge = this.edgeRepository.create({
      ...dto,
      tenantId,
      userId,
      createdBy: userId,
      status: 'inactive',
      syncConfig: { ...DEFAULT_SYNC_CONFIG, ...(dto.syncConfig ?? {}) },
    } as Partial<Edge>);

    const saved = await this.edgeRepository.save(edge);

    await this.logEvent(
      saved.id,
      tenantId,
      'CONFIG_UPDATED',
      'Edge device created',
      {},
      'info',
    );

    return saved;
  }

  async findAll(tenantId: string, query: any) {
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;
    const skip = (page - 1) * limit;

    const qb = this.edgeRepository
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId', { tenantId });

    if (query?.status) qb.andWhere('e.status = :status', { status: query.status });
    if (query?.type) qb.andWhere('e.type = :type', { type: query.type });
    if (query?.search) {
      qb.andWhere('(e.name ILIKE :search OR e.location ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    const [data, total] = await qb
      .orderBy('e.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async findOne(id: string, tenantId: string): Promise<Edge> {
    const edge = await this.edgeRepository.findOne({
      where: { id, tenantId },
    });
    if (!edge) throw new NotFoundException('Edge device not found');
    return edge;
  }

  async update(
    id: string,
    dto: UpdateEdgeDto,
    tenantId: string,
    userId?: string,
  ): Promise<Edge> {
    const edge = await this.findOne(id, tenantId);

    Object.assign(edge, dto);
    if (dto.syncConfig) {
      edge.syncConfig = {
        ...DEFAULT_SYNC_CONFIG,
        ...(edge.syncConfig ?? {}),
        ...dto.syncConfig,
      };
    }
    if (userId) edge.updatedBy = userId;

    const saved = await this.edgeRepository.save(edge);

    await this.logEvent(
      id,
      tenantId,
      'CONFIG_UPDATED',
      'Configuration updated',
      dto as Record<string, any>,
      'info',
    );

    return saved;
  }

  async remove(id: string, tenantId: string): Promise<void> {
    const edge = await this.findOne(id, tenantId);
    await this.edgeRepository.softRemove(edge);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTIVATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mint agent credentials. The raw secret is returned exactly once — only its
   * SHA-256 is stored, and the column is `select: false` so it never comes back
   * on an ordinary read.
   */
  async activate(
    id: string,
    tenantId: string,
  ): Promise<{
    edgeKey: string;
    edgeSecret: string;
    cloudUrl: string;
    mqttUrl: string;
  }> {
    await this.findOne(id, tenantId);

    const edgeKey = `edge_${randomBytes(16).toString('hex')}`;
    const rawSecret = randomBytes(32).toString('hex');
    const hashedSecret = createHash('sha256').update(rawSecret).digest('hex');

    await this.edgeRepository.update(
      { id },
      {
        edgeKey,
        edgeSecret: hashedSecret,
        // Becomes 'active' on the first heartbeat, not here.
        status: 'inactive',
      },
    );

    await this.logEvent(
      id,
      tenantId,
      'CONFIG_UPDATED',
      'Edge credentials generated',
      {},
      'info',
    );

    return {
      edgeKey,
      edgeSecret: rawSecret,
      cloudUrl: process.env.API_URL || 'https://api.smart-life.sa',
      mqttUrl: process.env.MQTT_URL || 'mqtt://api.smart-life.sa:1883',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DEVICE MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════

  async getDevices(id: string, tenantId: string): Promise<Device[]> {
    await this.findOne(id, tenantId);
    return this.deviceRepository.find({ where: { edgeId: id, tenantId } });
  }

  async assignDevice(
    id: string,
    deviceId: string,
    tenantId: string,
  ): Promise<{ message: string }> {
    await this.findOne(id, tenantId);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');

    const previousEdgeId = device.edgeId;

    device.edgeId = id;
    await this.deviceRepository.save(device);

    await this.syncDeviceCount(id);
    if (previousEdgeId && previousEdgeId !== id) {
      await this.syncDeviceCount(previousEdgeId);
    }

    await this.logEvent(
      id,
      tenantId,
      'DEVICE_CONNECTED',
      `Device ${device.name} assigned`,
      { deviceId },
      'info',
    );

    return { message: `Device ${deviceId} assigned to edge ${id}` };
  }

  async removeDevice(
    id: string,
    deviceId: string,
    tenantId: string,
  ): Promise<{ message: string }> {
    await this.findOne(id, tenantId);

    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, edgeId: id, tenantId },
    });
    if (!device) {
      throw new NotFoundException(
        'Device not found or not assigned to this edge',
      );
    }

    device.edgeId = undefined;
    await this.deviceRepository.save(device);
    await this.syncDeviceCount(id);

    await this.logEvent(
      id,
      tenantId,
      'DEVICE_DISCONNECTED',
      `Device ${device.name} removed`,
      { deviceId },
      'info',
    );

    return { message: `Device ${deviceId} removed from edge ${id}` };
  }

  private async syncDeviceCount(edgeId: string): Promise<void> {
    const count = await this.deviceRepository.count({ where: { edgeId } });
    await this.edgeRepository.update(
      { id: edgeId },
      { connectedDeviceCount: count },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONFIG BUNDLE
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Everything the agent needs to run: its own settings, its devices, and the
   * rule chains and dashboards assigned to it.
   *
   * Rule-chain nodes are loaded from the `nodes` table by `ruleChainId` rather
   * than through a relation — RuleChain declares no `nodes`/`connections`
   * relations (those entity files are empty), so `relations: ['nodes']` would
   * throw at runtime.
   */
  async getConfigBundle(
    id: string,
    tenantId: string,
  ): Promise<{
    edge: Partial<Edge>;
    devices: any[];
    ruleChains: any[];
    dashboards: any[];
    syncedAt: string;
  }> {
    const edge = await this.findOne(id, tenantId);
    const devices = await this.deviceRepository.find({
      where: { edgeId: id, tenantId },
    });

    const wantsRules = edge.syncConfig?.syncRules !== false;
    const wantsDashboards = edge.syncConfig?.syncDashboards !== false;

    let ruleChains: any[] = [];
    const ruleChainIds = edge.assignedRuleChainIds ?? [];
    if (wantsRules && ruleChainIds.length > 0) {
      const chains = await this.ruleChainRepository.find({
        where: { id: In(ruleChainIds), tenantId },
      });

      const nodes = chains.length
        ? await this.nodeRepository.find({
            where: { ruleChainId: In(chains.map((c) => c.id)), tenantId },
          })
        : [];

      ruleChains = chains.map((chain) => {
        const chainNodes = nodes.filter((n) => n.ruleChainId === chain.id);
        return {
          id: chain.id,
          name: chain.name,
          rootNodeId: chain.rootNodeId,
          configuration: chain.configuration,
          nodes: chainNodes.map((n) => ({
            id: n.id,
            name: n.name,
            type: n.type,
            configuration: n.configuration,
            enabled: n.enabled,
          })),
          // Connections live inline on each node rather than in their own table.
          connections: chainNodes.flatMap((n) =>
            (n.connections ?? []).map((c) => ({
              sourceNodeId: n.id,
              targetNodeId: c.targetNodeId,
              connectionType: c.connectionType,
              label: c.label,
            })),
          ),
        };
      });
    }

    let dashboards: any[] = [];
    const dashboardIds = edge.assignedDashboardIds ?? [];
    if (wantsDashboards && dashboardIds.length > 0) {
      const found = await this.dashboardRepository.find({
        where: { id: In(dashboardIds), tenantId },
      });
      dashboards = found.map((d) => ({
        id: d.id,
        name: d.name,
        // Dashboard has no `configuration` column — its layout is these three.
        configuration: {
          widgets: d.widgets,
          layout: d.layout,
          settings: d.settings,
        },
      }));
    }

    return {
      edge: {
        id: edge.id,
        name: edge.name,
        type: edge.type,
        syncConfig: edge.syncConfig,
        edgeKey: edge.edgeKey,
      },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        deviceKey: d.deviceKey,
        protocol: d.protocol,
      })),
      ruleChains,
      dashboards,
      syncedAt: new Date().toISOString(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SYNC
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Queue a configuration sync.
   *
   * `lastSyncStatus` is set to 'partial' — not 'success' — because at this point
   * the command has only been queued. The agent flips it to 'success' when it
   * acknowledges the SYNC_CONFIG command, so a queued-but-never-collected sync
   * is not reported as a completed one.
   */
  async triggerSync(
    id: string,
    tenantId: string,
    userId?: string,
  ): Promise<{ syncId: string; status: string }> {
    await this.findOne(id, tenantId);
    const syncId = randomUUID();

    await this.logEvent(
      id,
      tenantId,
      'SYNC_STARTED',
      'Manual sync triggered',
      { syncId },
      'info',
    );

    await this.sendCommand(
      id,
      tenantId,
      {
        type: 'SYNC_CONFIG',
        payload: { syncId, requestedAt: new Date().toISOString() },
      },
      userId,
    );

    await this.edgeRepository.update(
      { id },
      { lastSyncAt: new Date(), lastSyncStatus: 'partial' },
    );

    return { syncId, status: 'initiated' };
  }

  async getSyncStatus(id: string, tenantId: string) {
    const edge = await this.findOne(id, tenantId);

    const [pendingCommands, assignedDevices] = await Promise.all([
      this.commandRepository.count({
        where: { edgeId: id, status: 'PENDING' },
      }),
      this.deviceRepository.count({ where: { edgeId: id, tenantId } }),
    ]);

    return {
      lastSyncAt: edge.lastSyncAt,
      lastSyncStatus: edge.lastSyncStatus,
      pendingCommands,
      assignedDevices,
      assignedRuleChains: edge.assignedRuleChainIds?.length ?? 0,
      assignedDashboards: edge.assignedDashboardIds?.length ?? 0,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AGENT: HEARTBEAT / REGISTRATION
  // ══════════════════════════════════════════════════════════════════════════

  async handleHeartbeat(
    edgeKey: string,
    data: AgentHeartbeatDto,
  ): Promise<{
    acknowledged: boolean;
    pendingCommands: number;
    configVersion: string;
  }> {
    const edge = await this.edgeRepository.findOne({ where: { edgeKey } });
    if (!edge) throw new UnauthorizedException('Invalid edge key');

    const wasOffline = edge.status !== 'active';

    await this.edgeRepository.update(
      { id: edge.id },
      {
        status: 'active',
        lastSeenAt: new Date(),
        ipAddress: data.ipAddress ?? edge.ipAddress,
        firmwareVersion: data.firmwareVersion ?? edge.firmwareVersion,
        agentVersion: data.agentVersion ?? edge.agentVersion,
        osInfo: data.osInfo ?? edge.osInfo,
        systemMetrics: data.systemMetrics ?? edge.systemMetrics,
        connectedDeviceCount:
          data.connectedDevices ?? edge.connectedDeviceCount,
        messagesPerMinute: data.messagesPerMinute ?? edge.messagesPerMinute,
        totalMessagesProcessed:
          data.totalMessagesProcessed ?? edge.totalMessagesProcessed,
      },
    );

    // Metrics history — one row per heartbeat, so the trend survives even
    // though `systemMetrics` on the edge only holds the latest sample.
    if (data.systemMetrics) {
      const m = data.systemMetrics;
      await this.snapshotRepository
        .save(
          this.snapshotRepository.create({
            edgeId: edge.id,
            tenantId: edge.tenantId,
            cpu: m.cpuUsage ?? 0,
            memory: m.memoryUsage ?? 0,
            storage: m.diskUsage ?? 0,
            uptime: data.uptimeSeconds ?? 0,
            temperature: m.temperature,
            networkIn: m.networkIn,
            networkOut: m.networkOut,
          }),
        )
        .catch((err) =>
          this.logger.warn(`Metrics snapshot failed: ${err.message}`),
        );
    }

    if (wasOffline) {
      await this.logEvent(
        edge.id,
        edge.tenantId,
        'CONNECTED',
        `Edge ${edge.name} came online`,
        { ipAddress: data.ipAddress },
        'success',
      );
      await this.notifyStatusChange(edge, 'active');
    } else {
      await this.logEvent(
        edge.id,
        edge.tenantId,
        'HEARTBEAT',
        null,
        { ipAddress: data.ipAddress },
        'info',
      );
    }

    const pendingCommands = await this.commandRepository.count({
      where: { edgeId: edge.id, status: 'PENDING' },
    });

    return {
      acknowledged: true,
      pendingCommands,
      configVersion: edge.lastSyncAt?.toISOString() ?? 'never',
    };
  }

  /**
   * First-boot handshake. Unlike heartbeat this checks the secret as well as
   * the key, and answers with the full configuration bundle.
   */
  async selfRegister(
    data: AgentRegisterDto,
  ): Promise<{ registered: boolean; edgeId: string; config: any }> {
    const hashedSecret = createHash('sha256')
      .update(data.edgeSecret)
      .digest('hex');

    // edgeSecret is `select: false`, so it must be asked for explicitly.
    const edge = await this.edgeRepository
      .createQueryBuilder('e')
      .addSelect('e.edgeSecret')
      .where('e.edgeKey = :edgeKey', { edgeKey: data.edgeKey })
      .getOne();

    if (!edge || !edge.edgeSecret || edge.edgeSecret !== hashedSecret) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.edgeRepository.update(
      { id: edge.id },
      {
        status: 'active',
        lastSeenAt: new Date(),
        ipAddress: data.ipAddress ?? edge.ipAddress,
        agentVersion: data.agentVersion ?? edge.agentVersion,
        osInfo: data.osInfo ?? edge.osInfo,
      },
    );

    await this.logEvent(
      edge.id,
      edge.tenantId,
      'CONNECTED',
      'Edge agent self-registered',
      { ipAddress: data.ipAddress, agentVersion: data.agentVersion },
      'success',
    );

    const config = await this.getConfigBundle(edge.id, edge.tenantId);
    return { registered: true, edgeId: edge.id, config };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMMANDS
  // ══════════════════════════════════════════════════════════════════════════

  async sendCommand(
    id: string,
    tenantId: string,
    dto: SendCommandDto,
    userId?: string,
  ): Promise<EdgeCommand> {
    await this.findOne(id, tenantId);

    const cmd = await this.commandRepository.save(
      this.commandRepository.create({
        edgeId: id,
        tenantId,
        type: dto.type as EdgeCommandType,
        payload: dto.payload ?? null,
        status: 'PENDING',
        createdByUserId: userId ?? null,
      }),
    );

    await this.logEvent(
      id,
      tenantId,
      'COMMAND_SENT',
      `Command ${dto.type} queued`,
      { commandId: cmd.id, type: dto.type },
      'info',
    );

    return cmd;
  }

  async getCommands(
    id: string,
    tenantId: string,
    status?: string,
  ): Promise<EdgeCommand[]> {
    await this.findOne(id, tenantId);
    const where: Record<string, any> = { edgeId: id, tenantId };
    if (status) where.status = status;

    return this.commandRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /** Agent-facing: collect and mark as sent, in one round trip. */
  async getPendingCommands(edgeKey: string): Promise<EdgeCommand[]> {
    const edge = await this.edgeRepository.findOne({ where: { edgeKey } });
    if (!edge) throw new UnauthorizedException('Invalid edge key');

    const commands = await this.commandRepository.find({
      where: { edgeId: edge.id, status: 'PENDING' },
      order: { createdAt: 'ASC' },
    });

    if (commands.length > 0) {
      const now = new Date();
      await this.commandRepository.update(
        { id: In(commands.map((c) => c.id)) },
        { status: 'SENT', sentAt: now },
      );
      commands.forEach((c) => {
        c.status = 'SENT';
        c.sentAt = now;
      });

      await this.logEvent(
        edge.id,
        edge.tenantId,
        'COMMAND_RECEIVED',
        `${commands.length} command(s) collected by agent`,
        { commandIds: commands.map((c) => c.id) },
        'info',
      );
    }

    return commands;
  }

  async acknowledgeCommand(
    commandId: string,
    edgeKey: string,
    success: boolean,
    error?: string,
  ): Promise<{ acknowledged: boolean }> {
    const edge = await this.edgeRepository.findOne({ where: { edgeKey } });
    if (!edge) throw new UnauthorizedException('Invalid edge key');

    const command = await this.commandRepository.findOne({
      where: { id: commandId, edgeId: edge.id },
    });
    if (!command) throw new NotFoundException('Command not found');

    command.status = success ? 'EXECUTED' : 'FAILED';
    command.executedAt = new Date();
    command.deliveredAt = command.deliveredAt ?? new Date();
    command.error = error ?? null;
    await this.commandRepository.save(command);

    // A completed SYNC_CONFIG is what actually makes a sync successful.
    if (command.type === 'SYNC_CONFIG') {
      await this.edgeRepository.update(
        { id: edge.id },
        { lastSyncStatus: success ? 'success' : 'failed', lastSyncAt: new Date() },
      );
      await this.logEvent(
        edge.id,
        edge.tenantId,
        success ? 'SYNC_COMPLETED' : 'SYNC_FAILED',
        success ? 'Sync completed by agent' : `Sync failed: ${error ?? 'unknown'}`,
        { commandId },
        success ? 'success' : 'error',
      );
    }

    return { acknowledged: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENTS / METRICS
  // ══════════════════════════════════════════════════════════════════════════

  async getEvents(id: string, tenantId: string, query: any) {
    await this.findOne(id, tenantId);
    const page = Number(query?.page) || 1;
    const limit = Number(query?.limit) || 20;

    const where: Record<string, any> = { edgeId: id, tenantId };
    if (query?.type) where.type = query.type;
    if (query?.severity) where.severity = query.severity;

    const [data, total] = await this.eventRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        totalItems: total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async getMetrics(id: string, tenantId: string) {
    const edge = await this.findOne(id, tenantId);

    const [totalEvents, errorEvents, deviceCount] = await Promise.all([
      this.eventRepository.count({ where: { edgeId: id } }),
      this.eventRepository.count({ where: { edgeId: id, severity: 'error' } }),
      this.deviceRepository.count({ where: { edgeId: id, tenantId } }),
    ]);

    const lastSeenMs = edge.lastSeenAt
      ? Date.now() - new Date(edge.lastSeenAt).getTime()
      : null;
    const lastSeenAgo =
      lastSeenMs === null
        ? 'Never'
        : lastSeenMs < 60_000
          ? `${Math.floor(lastSeenMs / 1000)}s ago`
          : lastSeenMs < 3_600_000
            ? `${Math.floor(lastSeenMs / 60_000)}m ago`
            : `${Math.floor(lastSeenMs / 3_600_000)}h ago`;

    return {
      status: edge.status,
      lastSeenAt: edge.lastSeenAt,
      lastSeenAgo,
      connectedDevices: deviceCount,
      messagesPerMinute: edge.messagesPerMinute || 0,
      totalMessagesProcessed: edge.totalMessagesProcessed || 0,
      uptimePercentage: edge.uptimePercentage || 0,
      systemMetrics: edge.systemMetrics || {},
      events: { total: totalEvents, errors: errorEvents },
      sync: {
        lastSyncAt: edge.lastSyncAt,
        lastSyncStatus: edge.lastSyncStatus,
        assignedRuleChains: edge.assignedRuleChainIds?.length ?? 0,
        assignedDashboards: edge.assignedDashboardIds?.length ?? 0,
      },
    };
  }

  /** Time series from the per-heartbeat snapshots. */
  async getMetricsHistory(
    id: string,
    tenantId: string,
    hours = 24,
  ) {
    const edge = await this.findOne(id, tenantId);
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

  // ══════════════════════════════════════════════════════════════════════════
  // RULE CHAIN / DASHBOARD ASSIGNMENT
  // ══════════════════════════════════════════════════════════════════════════

  async assignRuleChain(
    id: string,
    ruleChainId: string,
    tenantId: string,
  ): Promise<{ message: string; assignedRuleChainIds: string[] }> {
    const edge = await this.findOne(id, tenantId);

    const chain = await this.ruleChainRepository.findOne({
      where: { id: ruleChainId, tenantId },
    });
    if (!chain) throw new NotFoundException('Rule chain not found');

    const ids = edge.assignedRuleChainIds ?? [];
    if (!ids.includes(ruleChainId)) {
      const next = [...ids, ruleChainId];
      await this.edgeRepository.update({ id }, { assignedRuleChainIds: next });
      await this.logEvent(
        id,
        tenantId,
        'CONFIG_UPDATED',
        `Rule chain "${chain.name}" assigned`,
        { ruleChainId },
        'info',
      );
      return { message: 'Rule chain assigned', assignedRuleChainIds: next };
    }

    return { message: 'Already assigned', assignedRuleChainIds: ids };
  }

  async removeRuleChain(
    id: string,
    ruleChainId: string,
    tenantId: string,
  ): Promise<{ message: string; assignedRuleChainIds: string[] }> {
    const edge = await this.findOne(id, tenantId);
    const next = (edge.assignedRuleChainIds ?? []).filter(
      (r) => r !== ruleChainId,
    );
    await this.edgeRepository.update({ id }, { assignedRuleChainIds: next });
    await this.logEvent(
      id,
      tenantId,
      'CONFIG_UPDATED',
      'Rule chain unassigned',
      { ruleChainId },
      'info',
    );
    return { message: 'Rule chain removed', assignedRuleChainIds: next };
  }

  async assignDashboard(
    id: string,
    dashboardId: string,
    tenantId: string,
  ): Promise<{ message: string; assignedDashboardIds: string[] }> {
    const edge = await this.findOne(id, tenantId);

    const dashboard = await this.dashboardRepository.findOne({
      where: { id: dashboardId, tenantId },
    });
    if (!dashboard) throw new NotFoundException('Dashboard not found');

    const ids = edge.assignedDashboardIds ?? [];
    if (!ids.includes(dashboardId)) {
      const next = [...ids, dashboardId];
      await this.edgeRepository.update({ id }, { assignedDashboardIds: next });
      await this.logEvent(
        id,
        tenantId,
        'CONFIG_UPDATED',
        `Dashboard "${dashboard.name}" assigned`,
        { dashboardId },
        'info',
      );
      return { message: 'Dashboard assigned', assignedDashboardIds: next };
    }

    return { message: 'Already assigned', assignedDashboardIds: ids };
  }

  async removeDashboard(
    id: string,
    dashboardId: string,
    tenantId: string,
  ): Promise<{ message: string; assignedDashboardIds: string[] }> {
    const edge = await this.findOne(id, tenantId);
    const next = (edge.assignedDashboardIds ?? []).filter(
      (d) => d !== dashboardId,
    );
    await this.edgeRepository.update({ id }, { assignedDashboardIds: next });
    await this.logEvent(
      id,
      tenantId,
      'CONFIG_UPDATED',
      'Dashboard unassigned',
      { dashboardId },
      'info',
    );
    return { message: 'Dashboard removed', assignedDashboardIds: next };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OFFLINE DETECTION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Flip any active edge that has stopped sending heartbeats.
   *
   * Runs every minute rather than every two: the cutoff is two minutes, so a
   * two-minute cron detects an outage between 2 and 4 minutes after it starts.
   * A one-minute cron halves the worst case at negligible cost.
   */
  @Cron('0 * * * * *')
  async detectOfflineEdges(): Promise<void> {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);

    const result = await this.edgeRepository
      .createQueryBuilder()
      .update(Edge)
      .set({ status: 'offline' })
      .where('status = :status', { status: 'active' })
      .andWhere('"lastSeenAt" IS NOT NULL')
      .andWhere('"lastSeenAt" < :cutoff', { cutoff })
      .andWhere('deleted_at IS NULL')
      .returning('*')
      .execute();

    const rows: any[] = result.raw ?? [];
    if (rows.length === 0) return;

    this.logger.log(`Offline detection: ${rows.length} edge(s) went offline`);

    for (const row of rows) {
      await this.logEvent(
        row.id,
        row.tenantId,
        'DISCONNECTED',
        `Edge ${row.name} went offline`,
        { lastSeenAt: row.lastSeenAt },
        'warning',
      );
      await this.notifyStatusChange(
        { id: row.id, tenantId: row.tenantId, userId: row.userId, name: row.name } as Edge,
        'offline',
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  private async logEvent(
    edgeId: string,
    tenantId: string,
    type: EdgeEventType,
    message: string | null,
    data: Record<string, any> | null,
    severity: EdgeEventSeverity,
  ): Promise<void> {
    try {
      await this.eventRepository.save(
        this.eventRepository.create({
          edgeId,
          tenantId,
          type,
          message,
          data,
          severity,
        }),
      );
    } catch (err: any) {
      // The audit trail must never break the operation it is recording.
      this.logger.warn(`Failed to log edge event ${type}: ${err.message}`);
    }
  }

  /**
   * Notify + broadcast a status transition.
   *
   * NotificationsService.create() resolves the recipient from `userId` and
   * throws without one, so an edge with no owner is broadcast over WebSocket
   * only. `type` is SYSTEM because NotificationType has no EDGE member, and
   * `channel` is singular — the entity stores one channel per row.
   */
  private async notifyStatusChange(
    edge: Pick<Edge, 'id' | 'tenantId' | 'name'> & { userId?: string | null },
    status: 'active' | 'offline',
  ): Promise<void> {
    const online = status === 'active';

    try {
      if (edge.userId) {
        await this.notificationsService.create({
          userId: edge.userId,
          title: online ? `Edge Online: ${edge.name}` : `Edge Offline: ${edge.name}`,
          message: online
            ? `Edge device "${edge.name}" is now online`
            : `Edge device "${edge.name}" has gone offline`,
          type: NotificationType.SYSTEM,
          channel: NotificationChannel.IN_APP,
          priority: online ? NotificationPriority.NORMAL : NotificationPriority.HIGH,
          metadata: { edgeId: edge.id, edgeStatus: status },
        } as any);
      }
    } catch (err: any) {
      this.logger.warn(`Edge notification failed: ${err.message}`);
    }

    try {
      this.websocketGateway.server
        ?.to(`tenant:${edge.tenantId}`)
        .emit('edge:status', {
          edgeId: edge.id,
          status,
          name: edge.name,
          timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
      this.logger.warn(`Edge WebSocket broadcast failed: ${err.message}`);
    }
  }
}
