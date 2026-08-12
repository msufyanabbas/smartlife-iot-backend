import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Integration } from './entities/integration.entity';
import { User } from '../users/entities/user.entity';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { TuyaSyncService, TuyaSyncResult } from './tuya-sync.service';
import { TuyaAdapter } from './adapters/tuya.adapter';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { PaginationDto, PaginatedResponseDto } from '../../common/dto/pagination.dto';
import { IntegrationActivityDto } from './dto/integration-activity.dto';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    private readonly dispatchService: IntegrationDispatchService,
    private readonly tuyaSyncService: TuyaSyncService,
  ) {}

  /** Shared by the Tuya endpoints — stateless, so one instance is enough. */
  private readonly tuyaAdapter = new TuyaAdapter();

  /**
   * Takes the whole User rather than just the id because `integrations.tenantId`
   * is NOT NULL and the dispatcher selects by tenant — creating a row without
   * one previously failed at the DB with a not-null violation, so nothing but
   * the seeder could ever create an integration.
   */
  async create(
    user: User,
    createIntegrationDto: CreateIntegrationDto,
  ): Promise<Integration> {
    if (!user.tenantId) {
      throw new BadRequestException(
        'An integration must belong to a tenant; this user has none',
      );
    }

    // Check if integration with same name exists
    const existing = await this.integrationRepository.findOne({
      where: { name: createIntegrationDto.name, userId: user.id },
    });

    if (existing) {
      throw new ConflictException('Integration with this name already exists');
    }

    const integration = this.integrationRepository.create({
      ...createIntegrationDto,
      protocol:
        createIntegrationDto.protocol ??
        IntegrationsService.defaultProtocolFor(createIntegrationDto.type),
      tenantId: user.tenantId,
      customerId: user.customerId,
      userId: user.id,
      createdBy: user.id,
    });

    const saved = await this.integrationRepository.save(integration);

    this.autoSyncIfTuya(saved);

    return saved;
  }

  /**
   * Import a Tuya project's devices as soon as the integration is live.
   *
   * Fire-and-forget on purpose: the device list is a round trip to Tuya's
   * cloud, and a slow or unreachable project must not make creating or
   * enabling an integration hang — or fail.
   */
  private autoSyncIfTuya(integration: Integration): void {
    if (!TuyaSyncService.isTuyaIntegration(integration)) return;

    // Deliberately not Integration.isActive(): `enabled` defaults to true in
    // the DB, so on a freshly saved entity where the client omitted it the
    // in-memory value is undefined and isActive() would answer false for a row
    // that is, in fact, active.
    const active =
      integration.status === IntegrationStatus.ACTIVE &&
      integration.enabled !== false;

    if (!active) return;

    this.tuyaSyncService.scheduleSync(integration);
  }

  /**
   * `integrations.protocol` is NOT NULL and has no DB default, so a request that
   * omits it would fail with a not-null violation. The transport is implied by
   * the type in every case, so derive it rather than forcing clients to repeat it.
   */
  private static defaultProtocolFor(type: IntegrationType): string {
    switch (type) {
      case IntegrationType.MQTT:
        return 'MQTT';
      case IntegrationType.AWS_IOT:
        return 'MQTTS';
      case IntegrationType.DATABASE:
        return 'SQL';
      default:
        // webhook, api, tuya, cloud, notification — all HTTP-based adapters.
        return 'HTTPS';
    }
  }

  async findAll(userId: string, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.integrationRepository
      .createQueryBuilder('integration')
      .where('integration.userId = :userId', { userId });

    if (search) {
      queryBuilder.andWhere(
        '(integration.name ILIKE :search OR integration.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`integration.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, userId: string): Promise<Integration> {
    const integration = await this.integrationRepository.findOne({
      where: { id, userId },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    return integration;
  }

  async update(
    id: string,
    userId: string,
    updateIntegrationDto: UpdateIntegrationDto,
  ): Promise<Integration> {
    const integration = await this.findOne(id, userId);

    Object.assign(integration, updateIntegrationDto);
    integration.updatedBy = userId;

    const saved = await this.integrationRepository.save(integration);

    this.autoSyncIfTuya(saved);

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const integration = await this.findOne(id, userId);
    await this.integrationRepository.softRemove(integration);
  }

  async toggleStatus(id: string, userId: string): Promise<Integration> {
    const integration = await this.findOne(id, userId);

    integration.enabled = !integration.enabled;
    integration.status = integration.enabled
      ? IntegrationStatus.ACTIVE
      : IntegrationStatus.INACTIVE;
    integration.updatedBy = userId;

    const saved = await this.integrationRepository.save(integration);

    // Enabling a Tuya integration is the other way it becomes live, so it
    // imports devices just like create/update does.
    this.autoSyncIfTuya(saved);

    return saved;
  }

  /**
   * Probe the integration through the same adapter dispatch uses, so a passing
   * test means real traffic will work — not merely that the host resolves.
   *
   * Delegated to IntegrationDispatchService. The previous in-service probes
   * (HTTP GET / MQTT connect) are gone; the adapters now own that logic.
   *
   * BREAKING: the response shape changed from
   *   `{ success, message, responseTime? }` to
   *   `{ connected, message, latencyMs, ...adapterExtras }`.
   */
  async testConnection(id: string, userId: string) {
    return this.dispatchService.testConnection(id, userId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TUYA
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Tuya endpoints accept either the explicit TUYA type or a legacy CLOUD row
   * whose configuration carries Tuya credentials — the same routing rule
   * IntegrationDispatchService.resolveAdapter() applies.
   */
  private async findTuyaIntegration(
    id: string,
    userId: string,
  ): Promise<Integration> {
    const integration = await this.findOne(id, userId);

    if (!TuyaSyncService.isTuyaIntegration(integration)) {
      throw new BadRequestException(
        `Integration '${integration.name}' is not a Tuya integration`,
      );
    }

    return integration;
  }

  async getTuyaDevices(id: string, userId: string): Promise<any[]> {
    const integration = await this.findTuyaIntegration(id, userId);

    // getDevices() throws on an API/auth/signing failure rather than returning
    // an empty list, so the caller sees the reason instead of "0 devices".
    try {
      return await this.tuyaAdapter.getDevices(integration.configuration);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  async sendTuyaCommand(
    id: string,
    userId: string,
    body: { tuyaDeviceId: string; commands: any[] },
  ) {
    const integration = await this.findTuyaIntegration(id, userId);

    const result = await this.tuyaAdapter.dispatch(integration.configuration, {
      tuyaDeviceId: body.tuyaDeviceId,
      commands: body.commands,
    });

    if (!result.success) {
      throw new BadRequestException(result.error ?? 'Tuya command failed');
    }
    return result;
  }

  /**
   * Import every device bound to this Tuya project into the platform.
   *
   * Scoped by userId, not tenantId, to match the rest of this service: the
   * integration CRUD surface is per-owner. The tenant the devices are created
   * in comes from the integration row itself — never from the request — so a
   * caller cannot import devices into a tenant they do not own an integration
   * in.
   */
  async syncTuyaDevices(id: string, userId: string): Promise<TuyaSyncResult> {
    const integration = await this.findTuyaIntegration(id, userId);

    try {
      return await this.tuyaSyncService.syncIntegration(integration);
    } catch (err: any) {
      // getDevices() throws on auth/signing/subscription failures — surface the
      // reason as a 400 rather than a 500 with a stack trace.
      throw new BadRequestException(err.message);
    }
  }

  /**
   * Tuya message-service receiver. Public route — see TuyaSyncService for the
   * authentication trade-off and the always-200 contract.
   */
  async handleTuyaWebhook(
    body: any,
    clientId?: string,
    webhookSecret?: string,
  ): Promise<{ success: boolean }> {
    return this.tuyaSyncService.handleWebhook(body, clientId, webhookSecret);
  }

  async getTuyaDeviceStatus(
    id: string,
    userId: string,
    tuyaDeviceId: string,
  ): Promise<any> {
    const integration = await this.findTuyaIntegration(id, userId);

    try {
      return await this.tuyaAdapter.getDeviceStatus(
        integration.configuration,
        tuyaDeviceId,
      );
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }


  async getStatistics(userId: string) {
    const [total, active, errors] = await Promise.all([
      this.integrationRepository.count({ where: { userId } }),
      this.integrationRepository.count({
        where: { userId, status: IntegrationStatus.ACTIVE },
      }),
      this.integrationRepository.count({
        where: { userId, status: IntegrationStatus.ERROR },
      }),
    ]);

    const byTypeResult = await this.integrationRepository
      .createQueryBuilder('integration')
      .select('integration.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('integration.userId = :userId', { userId })
      .groupBy('integration.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const totalMessagesResult = await this.integrationRepository
      .createQueryBuilder('integration')
      .select('SUM(integration.messagesProcessed)', 'total')
      .where('integration.userId = :userId', { userId })
      .getRawOne();

    return {
      total,
      active,
      errors,
      inactive: total - active - errors,
      byType,
      totalMessages: parseInt(totalMessagesResult?.total || '0'),
    };
  }

  /**
   * Recent activity feed, DERIVED from integration entity state.
   *
   * There is no dedicated integration activity/event log table, so each entry
   * is synthesized from an integration's most recent relevant timestamp
   * (lastActivity/lastFailure/lastSuccess/updatedAt/createdAt) and its current
   * status. This reflects current entity state, not a true append-only event
   * stream — see IntegrationActivityDto.
   */
  async getRecentActivity(
    userId: string,
    opts: { limit?: string | number; page?: string | number; type?: string },
  ) {
    // Clamp limit to [1, 50] (default 10) and page to >= 1 (default 1).
    const limit = Math.min(
      Math.max(parseInt(String(opts.limit ?? 10), 10) || 10, 1),
      50,
    );
    const page = Math.max(parseInt(String(opts.page ?? 1), 10) || 1, 1);
    const skip = (page - 1) * limit;

    // Only apply the type filter when it is a valid IntegrationType.
    const type =
      opts.type &&
      (Object.values(IntegrationType) as string[]).includes(opts.type)
        ? opts.type
        : undefined;

    const qb = this.integrationRepository
      .createQueryBuilder('integration')
      .where('integration.userId = :userId', { userId });

    if (type) {
      qb.andWhere('integration.type = :type', { type });
    }

    // Order by the most recent relevant timestamp. GREATEST ignores NULLs, and
    // created_at/updated_at are always present so a value is always produced.
    qb.orderBy(
      'GREATEST(integration."lastActivity", integration."lastFailure", integration."lastSuccess", integration.updated_at, integration.created_at)',
      'DESC',
    )
      .skip(skip)
      .take(limit);

    const [integrations, total] = await qb.getManyAndCount();

    const data = integrations.map((i) => this.toActivity(i));

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /**
   * Map an Integration entity to a single derived activity entry.
   */
  private toActivity(integration: Integration): IntegrationActivityDto {
    const timestamps = [
      integration.lastActivity,
      integration.lastFailure,
      integration.lastSuccess,
      integration.updatedAt,
      integration.createdAt,
    ]
      .filter((d): d is Date => !!d)
      .map((d) => new Date(d).getTime());
    const mostRecent = timestamps.length ? Math.max(...timestamps) : Date.now();

    let activityType: string;
    let message: string;

    if (integration.status === IntegrationStatus.ERROR) {
      activityType = 'Error';
      message = integration.lastError ?? 'Integration is in an error state';
    } else if (
      !integration.enabled ||
      integration.status === IntegrationStatus.INACTIVE
    ) {
      activityType = 'Disabled';
      message = 'Integration is disabled';
    } else {
      activityType = 'Connected';
      message = integration.lastSuccess
        ? `Active — ${integration.messagesSucceeded}/${integration.messagesProcessed} messages succeeded`
        : 'Integration is active';
    }

    return {
      integrationId: integration.id,
      integrationName: integration.name,
      type: integration.type,
      activityType,
      status: integration.status,
      message,
      timestamp: new Date(mostRecent).toISOString(),
    };
  }

  async incrementMessageCount(id: string, userId: string): Promise<void> {
    await this.integrationRepository.increment(
      { id, userId },
      'messagesProcessed',
      1,
    );

    await this.integrationRepository.update(
      { id, userId },
      { lastActivity: new Date() },
    );
  }
}
