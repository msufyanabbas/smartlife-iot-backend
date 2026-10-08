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
import {
  IntegrationStatus,
  IntegrationType,
  UserRole,
} from '@common/enums/index.enum';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { PaginationDto, PaginatedResponseDto } from '../../common/dto/pagination.dto';
import { IntegrationActivityDto } from './dto/integration-activity.dto';
import {
  INTEGRATION_CATALOGUE,
  listCatalogue,
  validateIntegrationConfig,
} from './integration-catalogue';
import { IntegrationEventsService } from './integration-events.service';
import { IntegrationMqttInboundService } from './integration-mqtt-inbound.service';
import { IntegrationEventDirection, IntegrationEventType } from './entities/integration-event.entity';

/**
 * The caller, reduced to what scoping needs.
 *
 * Integrations used to be scoped by `userId` alone, which made them private to
 * whoever created them — two admins of the same tenant could not see each
 * other's integrations, and neither could fix one left behind by someone who
 * had since been removed. Meanwhile IntegrationDispatchService selects by
 * TENANT, so a row nobody could see was still forwarding telemetry. Scoping is
 * now per tenant, with `userId` kept as a record of who created the row.
 */
type CallerScope = Pick<User, 'id' | 'tenantId' | 'role'>;

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    private readonly dispatchService: IntegrationDispatchService,
    private readonly tuyaSyncService: TuyaSyncService,
    private readonly eventsService: IntegrationEventsService,
    private readonly mqttInbound: IntegrationMqttInboundService,
  ) {}

  /**
   * SUPER_ADMIN has no tenantId and is expected to see everything, so it gets
   * an empty filter rather than a filter on `tenantId: undefined` — which
   * TypeORM would silently drop, producing the same result by accident.
   */
  private scope(user: CallerScope): { tenantId?: string } {
    if (user.role === UserRole.SUPER_ADMIN) return {};
    if (!user.tenantId) {
      throw new BadRequestException('This user does not belong to a tenant');
    }
    return { tenantId: user.tenantId };
  }

  /**
   * 400 with every problem at once, rather than one per round trip.
   *
   * Only the declared fields of the type's manifest are checked; extra keys
   * pass through, because `configuration` is a free jsonb column and existing
   * rows carry keys the catalogue never declared.
   */
  private assertValidConfig(
    type: IntegrationType,
    configuration: Record<string, any> | undefined | null,
  ): void {
    const errors = validateIntegrationConfig(type, configuration);
    if (errors.length) {
      throw new BadRequestException({
        message: 'Integration configuration is incomplete',
        errors,
      });
    }
  }

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

    this.assertValidConfig(
      createIntegrationDto.type,
      createIntegrationDto.configuration,
    );

    // Uniqueness is per tenant, matching the new scoping: two admins of one
    // tenant creating "Site webhook" would otherwise end up with two rows of
    // the same name, both dispatching.
    const existing = await this.integrationRepository.findOne({
      where: { name: createIntegrationDto.name, tenantId: user.tenantId },
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
    this.refreshInbound(saved);

    this.eventsService.record({
      integrationId: saved.id,
      tenantId: saved.tenantId,
      direction: IntegrationEventDirection.LIFECYCLE,
      eventType: IntegrationEventType.CREATED,
      message: `Created by ${user.email ?? user.id}`,
    });

    return saved;
  }

  /**
   * Re-reconcile the inbound MQTT subscriptions after a change.
   *
   * Fire-and-forget, and only for MQTT: connecting to a third-party broker is
   * a network round trip, and a broker that is down must not make saving the
   * integration hang. The one-minute cron is the backstop if this call is lost.
   */
  private refreshInbound(integration: Integration): void {
    if (integration.type !== IntegrationType.MQTT) return;
    setImmediate(() => {
      void this.mqttInbound.refresh().catch((error) => {
        this.logger.warn(
          `Could not refresh inbound MQTT subscriptions: ${error.message}`,
        );
      });
    });
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
    // The catalogue carries a defaultProtocol per type, so the switch that used
    // to live here is gone — it covered six types and silently answered HTTPS
    // for the ten added since. 'HTTPS' remains the fallback for a type the
    // catalogue somehow does not know.
    return INTEGRATION_CATALOGUE[type]?.defaultProtocol ?? 'HTTPS';
  }

  /** The type gallery the create wizard renders. Static — no tenant data. */
  getCatalogue() {
    return listCatalogue();
  }

  async findAll(user: CallerScope, paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    // Column allowlist: `sortBy` lands in an ORDER BY clause that QueryBuilder
    // does not parameterise, so an arbitrary string here is an injection point.
    const SORTABLE = [
      'createdAt',
      'updatedAt',
      'name',
      'type',
      'status',
      'lastActivity',
      'messagesProcessed',
    ];
    const orderColumn = SORTABLE.includes(sortBy) ? sortBy : 'createdAt';
    const direction = sortOrder === 'ASC' ? 'ASC' : 'DESC';

    const queryBuilder = this.integrationRepository.createQueryBuilder(
      'integration',
    );

    const scope = this.scope(user);
    if (scope.tenantId) {
      queryBuilder.where('integration.tenantId = :tenantId', {
        tenantId: scope.tenantId,
      });
    } else {
      queryBuilder.where('1 = 1');
    }

    if (search) {
      queryBuilder.andWhere(
        '(integration.name ILIKE :search OR integration.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`integration.${orderColumn}`, direction)
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string, user: CallerScope): Promise<Integration> {
    const integration = await this.integrationRepository.findOne({
      where: { id, ...this.scope(user) },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    return integration;
  }

  /** The detail page's health panel: counts over a window, from the event feed. */
  async getSummary(id: string, user: CallerScope, hours = 24) {
    const integration = await this.findOne(id, user);
    return this.eventsService.summarise(
      integration.id,
      integration.tenantId,
      hours,
    );
  }

  /** Paginated event feed for one integration. */
  async getEvents(
    id: string,
    user: CallerScope,
    options: { page?: number; limit?: number; direction?: string; success?: boolean },
  ) {
    const integration = await this.findOne(id, user);
    return this.eventsService.findForIntegration(
      integration.id,
      integration.tenantId,
      options,
    );
  }

  async update(
    id: string,
    user: CallerScope,
    updateIntegrationDto: UpdateIntegrationDto,
  ): Promise<Integration> {
    const integration = await this.findOne(id, user);

    // Validated against the MERGED configuration, not the patch: a PATCH that
    // sends only the changed keys would otherwise fail every required-field
    // check for the keys it left alone.
    const mergedConfig = updateIntegrationDto.configuration
      ? { ...(integration.configuration ?? {}), ...updateIntegrationDto.configuration }
      : integration.configuration;
    this.assertValidConfig(
      (updateIntegrationDto.type ?? integration.type) as IntegrationType,
      mergedConfig,
    );

    Object.assign(integration, updateIntegrationDto);
    if (updateIntegrationDto.configuration) {
      integration.configuration = mergedConfig as Record<string, any>;
    }
    integration.updatedBy = user.id;

    // Editing a quarantined integration is how an operator says "I fixed it",
    // so the failure streak is cleared. Without this, an integration that the
    // dispatcher disabled after 10 failures stays disabled no matter what the
    // operator corrects.
    if (updateIntegrationDto.configuration) {
      integration.consecutiveFailures = 0;
      integration.lastError = null as any;
    }

    const saved = await this.integrationRepository.save(integration);

    this.autoSyncIfTuya(saved);
    this.refreshInbound(saved);

    this.eventsService.record({
      integrationId: saved.id,
      tenantId: saved.tenantId,
      direction: IntegrationEventDirection.LIFECYCLE,
      eventType: IntegrationEventType.UPDATED,
      message: `Configuration updated by ${user.id}`,
    });

    return saved;
  }

  async remove(id: string, user: CallerScope): Promise<void> {
    const integration = await this.findOne(id, user);
    await this.integrationRepository.softRemove(integration);
    // Drops the broker connection; otherwise a deleted MQTT integration keeps
    // ingesting until the process restarts.
    this.refreshInbound(integration);
  }

  async toggleStatus(id: string, user: CallerScope): Promise<Integration> {
    const integration = await this.findOne(id, user);

    integration.enabled = !integration.enabled;
    integration.status = integration.enabled
      ? IntegrationStatus.ACTIVE
      : IntegrationStatus.INACTIVE;
    integration.updatedBy = user.id;

    // Re-enabling is the operator saying the problem is fixed. The dispatcher
    // disables an integration after 10 consecutive failures; leaving the streak
    // at 10 would re-quarantine it on the very next failure.
    if (integration.enabled) {
      integration.consecutiveFailures = 0;
    }

    const saved = await this.integrationRepository.save(integration);

    // Enabling a Tuya integration is the other way it becomes live, so it
    // imports devices just like create/update does.
    this.autoSyncIfTuya(saved);
    this.refreshInbound(saved);

    this.eventsService.record({
      integrationId: saved.id,
      tenantId: saved.tenantId,
      direction: IntegrationEventDirection.LIFECYCLE,
      eventType: saved.enabled
        ? IntegrationEventType.ENABLED
        : IntegrationEventType.DISABLED,
      message: saved.enabled ? 'Enabled' : 'Disabled',
    });

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
  async testConnection(id: string, user: CallerScope) {
    // findOne first, so the tenant check happens here and the dispatcher is
    // handed an id it is allowed to probe.
    const integration = await this.findOne(id, user);
    const result = await this.dispatchService.testConnection(integration.id);

    this.eventsService.record({
      integrationId: integration.id,
      tenantId: integration.tenantId,
      direction: IntegrationEventDirection.LIFECYCLE,
      eventType: IntegrationEventType.TEST,
      success: result.connected,
      message: result.message,
      durationMs: result.latencyMs,
    });

    return result;
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
    user: CallerScope,
  ): Promise<Integration> {
    const integration = await this.findOne(id, user);

    if (!TuyaSyncService.isTuyaIntegration(integration)) {
      throw new BadRequestException(
        `Integration '${integration.name}' is not a Tuya integration`,
      );
    }

    return integration;
  }

  async getTuyaDevices(id: string, user: CallerScope): Promise<any[]> {
    const integration = await this.findTuyaIntegration(id, user);

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
    user: CallerScope,
    body: { tuyaDeviceId: string; commands: any[] },
  ) {
    const integration = await this.findTuyaIntegration(id, user);

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
   * The tenant the devices are created in comes from the integration row
   * itself — never from the request — so a caller cannot import devices into a
   * tenant they have no integration in.
   */
  async syncTuyaDevices(id: string, user: CallerScope): Promise<TuyaSyncResult> {
    const integration = await this.findTuyaIntegration(id, user);

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
    user: CallerScope,
    tuyaDeviceId: string,
  ): Promise<any> {
    const integration = await this.findTuyaIntegration(id, user);

    try {
      return await this.tuyaAdapter.getDeviceStatus(
        integration.configuration,
        tuyaDeviceId,
      );
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }


  async getStatistics(user: CallerScope) {
    const where = this.scope(user);

    const [total, active, errors] = await Promise.all([
      this.integrationRepository.count({ where }),
      this.integrationRepository.count({
        where: { ...where, status: IntegrationStatus.ACTIVE },
      }),
      this.integrationRepository.count({
        where: { ...where, status: IntegrationStatus.ERROR },
      }),
    ]);

    const scoped = <T extends { andWhere: Function; where: Function }>(qb: T): T => {
      if (where.tenantId) {
        qb.where('integration.tenantId = :tenantId', { tenantId: where.tenantId });
      } else {
        qb.where('1 = 1');
      }
      return qb;
    };

    const byTypeResult = await scoped(
      this.integrationRepository
        .createQueryBuilder('integration')
        .select('integration.type', 'type')
        .addSelect('COUNT(*)', 'count'),
    )
      .groupBy('integration.type')
      .getRawMany();

    const byType = byTypeResult.reduce(
      (acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      },
      {} as Record<string, number>,
    );

    const totalMessagesResult = await scoped(
      this.integrationRepository
        .createQueryBuilder('integration')
        .select('SUM(integration.messagesProcessed)', 'total'),
    ).getRawOne();

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
    user: CallerScope,
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

    const scope = this.scope(user);
    const qb = this.integrationRepository.createQueryBuilder('integration');
    if (scope.tenantId) {
      qb.where('integration.tenantId = :tenantId', { tenantId: scope.tenantId });
    } else {
      qb.where('1 = 1');
    }

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

  /**
   * The tenant-wide event feed — a real append-only one, unlike
   * `getRecentActivity()` above, which synthesises one entry per integration
   * from its current column values and so cannot distinguish two failures an
   * hour apart from one.
   *
   * `recent-activity` is kept as it was because the dashboard tile consumes its
   * shape; new callers should use this.
   */
  async getTenantEvents(
    user: CallerScope,
    options: { page?: number; limit?: number; direction?: string; success?: boolean },
  ) {
    const scope = this.scope(user);
    if (!scope.tenantId) {
      // SUPER_ADMIN has no tenant of its own, so there is no feed to show. A
      // cross-tenant feed would need its own route and its own access rules.
      throw new BadRequestException(
        'The event feed is per tenant; sign in as a tenant user to read it',
      );
    }
    return this.eventsService.findForTenant(scope.tenantId, options);
  }

  /** Which MQTT integrations currently hold a live inbound subscription. */
  getInboundStatus(user: CallerScope) {
    const scope = this.scope(user);
    return this.mqttInbound.getStatus(scope.tenantId);
  }

  /**
   * Counter bump, by id alone.
   *
   * Not scoped: the only callers are internal bookkeeping paths that already
   * resolved the row, and an unscoped UPDATE on a primary key cannot leak
   * anything — it returns no data.
   */
  async incrementMessageCount(id: string): Promise<void> {
    await this.integrationRepository.increment({ id }, 'messagesProcessed', 1);
    await this.integrationRepository.update({ id }, { lastActivity: new Date() });
  }
}
