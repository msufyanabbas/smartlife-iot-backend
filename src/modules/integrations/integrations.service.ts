import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as mqtt from 'mqtt';
import * as crypto from 'crypto';
import { Integration } from './entities/integration.entity';
import { IntegrationStatus, IntegrationType } from '@common/enums/index.enum';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IntegrationActivityDto } from './dto/integration-activity.dto';

type ConnectionTestResult = {
  success: boolean;
  message: string;
  responseTime?: number;
};

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    private readonly httpService: HttpService,
  ) {}

  async create(
    userId: string,
    createIntegrationDto: CreateIntegrationDto,
  ): Promise<Integration> {
    // Check if integration with same name exists
    const existing = await this.integrationRepository.findOne({
      where: { name: createIntegrationDto.name, userId },
    });

    if (existing) {
      throw new ConflictException('Integration with this name already exists');
    }

    const integration = this.integrationRepository.create({
      ...createIntegrationDto,
      userId,
      createdBy: userId,
    });

    return await this.integrationRepository.save(integration);
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

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
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

    return await this.integrationRepository.save(integration);
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

    return await this.integrationRepository.save(integration);
  }

  async testConnection(
    id: string,
    userId: string,
  ): Promise<ConnectionTestResult> {
    const integration = await this.findOne(id, userId);
    const config = integration.configuration ?? {};

    switch (integration.type) {
      // HTTP-based integrations: verify the endpoint is reachable.
      case IntegrationType.WEBHOOK:
      case IntegrationType.API:
        return this.testHttpConnection(config);

      // MQTT: open a real connection to the configured broker.
      case IntegrationType.MQTT:
        return this.testMqttConnection(config);

      // AWS IoT / Azure (CLOUD), NOTIFICATION, DATABASE, etc. — no real probe yet.
      default:
        return {
          success: false,
          message: 'Connection test not yet implemented for this type',
        };
    }
  }

  /**
   * HTTP/Webhook probe — issues a real GET to the configured URL with a 5s
   * timeout. Any HTTP response (even 4xx/5xx) means the endpoint is reachable;
   * only transport-level errors (DNS, refused, timeout) count as a failure.
   */
  private async testHttpConnection(
    config: Integration['configuration'],
  ): Promise<ConnectionTestResult> {
    if (!config?.url) {
      return {
        success: false,
        message: 'No URL configured for this integration',
      };
    }

    const startedAt = Date.now();
    try {
      const response = await firstValueFrom(
        this.httpService.request({
          url: config.url,
          method: 'GET',
          timeout: 5000,
          headers: config.headers,
          // Treat any status code as a received response (reachable endpoint).
          validateStatus: () => true,
        }),
      );

      return {
        success: true,
        message: `Connected to ${config.url} (HTTP ${response.status})`,
        responseTime: Date.now() - startedAt,
      };
    } catch (error: any) {
      const responseTime = Date.now() - startedAt;
      const message =
        error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message ?? '')
          ? 'Connection timed out after 5000ms'
          : `Connection failed: ${error?.message ?? 'unknown error'}`;

      this.logger.warn(
        `HTTP connection test failed for ${config.url}: ${message}`,
      );
      return { success: false, message, responseTime };
    }
  }

  /**
   * MQTT probe — connects to the configured broker with a 3s timeout, then
   * disconnects immediately. Resolves (never rejects) with the outcome.
   */
  private testMqttConnection(
    config: Integration['configuration'],
  ): Promise<ConnectionTestResult> {
    return new Promise<ConnectionTestResult>((resolve) => {
      const brokerUrl = this.buildMqttBrokerUrl(config);
      if (!brokerUrl) {
        resolve({
          success: false,
          message: 'No MQTT broker configured for this integration',
        });
        return;
      }

      const startedAt = Date.now();
      let settled = false;

      const client = mqtt.connect(brokerUrl, {
        username: config?.username,
        password: config?.password,
        connectTimeout: 3000,
        reconnectPeriod: 0, // one-shot: never auto-retry
        clientId:
          config?.clientId ||
          `smartlife-conntest-${crypto.randomBytes(6).toString('hex')}`,
      });

      const finish = (result: ConnectionTestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // force-close the socket so the probe leaves nothing behind
        try {
          client.end(true);
        } catch {
          /* ignore close errors */
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          success: false,
          message: 'MQTT connection timed out after 3000ms',
          responseTime: Date.now() - startedAt,
        });
      }, 3000);

      client.on('connect', () => {
        finish({
          success: true,
          message: `Successfully connected to MQTT broker ${brokerUrl}`,
          responseTime: Date.now() - startedAt,
        });
      });

      client.on('error', (error) => {
        this.logger.warn(
          `MQTT connection test failed for ${brokerUrl}: ${error.message}`,
        );
        finish({
          success: false,
          message: `MQTT connection failed: ${error.message}`,
          responseTime: Date.now() - startedAt,
        });
      });
    });
  }

  /**
   * Normalise the MQTT broker address from config into a connectable URL.
   * Accepts either a full URL (mqtt://host:port) or a bare host + optional port.
   */
  private buildMqttBrokerUrl(
    config: Integration['configuration'],
  ): string | null {
    const broker = config?.broker?.trim();
    if (!broker) return null;

    if (/^mqtts?:\/\//i.test(broker) || /^wss?:\/\//i.test(broker)) {
      return broker;
    }

    const scheme = config?.useTls ? 'mqtts' : 'mqtt';
    return config?.port
      ? `${scheme}://${broker}:${config.port}`
      : `${scheme}://${broker}`;
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

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
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
