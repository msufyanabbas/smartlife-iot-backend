import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from './entities/tenant.entity';
import { Subscription } from '../subscriptions/entities/subscription.entity';
import { TenantStatus } from '@/common/enums/index.enum';
import type {
  SubscriptionLimits,
  SubscriptionUsage,
} from '@common/interfaces/index.interface';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { PaginationDto, PaginatedResponseDto } from '@common/dto/pagination.dto';


@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    // Read-only. Registered as a bare repository rather than by importing
    // SubscriptionsModule, which already imports UsersModule → TenantsModule.
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) { }

  async create(userId: string, createDto: CreateTenantDto): Promise<Tenant> {
    const existing = await this.tenantRepository.findOne({
      where: [{ name: createDto.name }, { email: createDto.email }],
    });

    if (existing) {
      throw new ConflictException(
        'Tenant with this name or email already exists',
      );
    }

    const tenant = this.tenantRepository.create({
      ...createDto,
      createdBy: userId,
      configuration: {
        timezone: createDto.configuration?.timezone,
        language: createDto.configuration?.language,
        theme: createDto.configuration?.theme,
      },
    });

    return await this.tenantRepository.save(tenant);
  }

  async findAll(paginationDto: PaginationDto) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.tenantRepository.createQueryBuilder('tenant');

    if (search) {
      queryBuilder.where(
        '(tenant.name ILIKE :search OR tenant.email ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    queryBuilder
      .orderBy(`tenant.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(id: string | undefined): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { id } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async findByName(name: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { name } });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  async update(
    id: string,
    userId: string,
    updateDto: UpdateTenantDto,
  ): Promise<Tenant> {
    const tenant = await this.findOne(id);

    // Check for name/email conflicts
    if (updateDto.name || updateDto.email) {
      const existing = await this.tenantRepository.findOne({
        where: [{ name: updateDto.name }, { email: updateDto.email }],
      });

      if (existing && existing.id !== id) {
        throw new ConflictException(
          'Tenant with this name or email already exists',
        );
      }
    }

    Object.assign(tenant, updateDto);
    tenant.updatedBy = userId;

    return await this.tenantRepository.save(tenant);
  }

  async remove(id: string): Promise<void> {
    const tenant = await this.findOne(id);
    await this.tenantRepository.softRemove(tenant);
  }

  async activate(id: string, userId: string): Promise<Tenant> {
    const tenant = await this.findOne(id);
    tenant.status = TenantStatus.ACTIVE;
    tenant.updatedBy = userId;
    return await this.tenantRepository.save(tenant);
  }

  async suspend(id: string, userId: string): Promise<Tenant> {
    const tenant = await this.findOne(id);
    tenant.status = TenantStatus.SUSPENDED;
    tenant.updatedBy = userId;
    return await this.tenantRepository.save(tenant);
  }

  async getStatistics() {
    const [total, active, inactive, suspended] = await Promise.all([
      this.tenantRepository.count(),
      this.tenantRepository.count({ where: { status: TenantStatus.ACTIVE } }),
      this.tenantRepository.count({ where: { status: TenantStatus.INACTIVE } }),
      this.tenantRepository.count({
        where: { status: TenantStatus.SUSPENDED },
      }),
    ]);

    return {
      total,
      active,
      inactive,
      suspended,
    };
  }

  /**
   * Real usage vs plan limits, read from the denormalised counters on the
   * tenant's subscription.
   *
   * Shape note: `plan` on Subscription is an ENUM COLUMN, not a relation —
   * there is no SubscriptionPlan entity and no `subscription.plan.limits`.
   * The limits jsonb lives directly on the subscription row, so there is
   * nothing to join and `relations: ['plan']` would throw.
   *
   * A tenant with no subscription row returns zeroed metrics rather than 404 —
   * the endpoint describes consumption, and "none, against no plan" is a
   * truthful answer for an unprovisioned tenant.
   */
  async getUsage(id: string) {
    const tenant = await this.findOne(id);

    const subscription = await this.subscriptionRepository.findOne({
      where: { tenantId: tenant.id },
    });

    const usage = (subscription?.usage ?? {}) as Partial<SubscriptionUsage>;
    const limits = (subscription?.limits ?? {}) as SubscriptionLimits;

    const calcPct = (used: number, limit: number) => {
      if (limit === -1) return 0; // unlimited
      if (limit === 0) return 100; // nothing allowed — always "full"
      return Math.min(100, Math.round((used / limit) * 100));
    };

    // Left side = SubscriptionUsage key, right side = SubscriptionLimits key.
    // These are NOT the same name for apiCalls/smsNotifications, which is what
    // USAGE_TO_LIMIT_KEY exists to encode.
    const metrics: Record<string, { used: number; limit: number }> = {
      devices:          { used: usage.devices    ?? 0, limit: limits.devices    ?? 0 },
      dashboards:       { used: usage.dashboards ?? 0, limit: limits.dashboards ?? 0 },
      assets:           { used: usage.assets     ?? 0, limit: limits.assets     ?? 0 },
      users:            { used: usage.users      ?? 0, limit: limits.users      ?? 0 },
      customers:        { used: usage.customers  ?? 0, limit: limits.customers  ?? 0 },
      ruleChains:       { used: usage.ruleChains ?? 0, limit: limits.ruleChains ?? 0 },
      floorPlans:       { used: usage.floorPlans ?? 0, limit: limits.maxFloorPlans ?? limits.floorPlans ?? 0 },
      automations:      { used: usage.automations ?? 0, limit: limits.automations ?? 0 },
      apiCalls:         { used: usage.apiCalls   ?? 0, limit: limits.apiCallsPerMonth ?? 0 },
      storageGB:        { used: usage.storageGB  ?? 0, limit: limits.storageGB  ?? 0 },
      smsNotifications: { used: usage.smsNotifications ?? 0, limit: limits.smsNotificationsPerMonth ?? 0 },
    };

    const result: Record<
      string,
      { used: number; limit: number; percentage: number }
    > = {};
    const alerts: Array<{
      metric: string;
      percentage: number;
      severity: 'warning' | 'critical';
      message: string;
    }> = [];

    for (const [key, data] of Object.entries(metrics)) {
      const percentage = calcPct(data.used, data.limit);
      result[key] = { used: data.used, limit: data.limit, percentage };

      // A limit of 0 means the plan does not include the feature at all —
      // reporting "0% used, critical" on every FREE tenant would be noise, so
      // only genuine consumption against a real ceiling raises an alert.
      if (data.limit === -1 || data.limit === 0) continue;

      if (percentage >= 90) {
        alerts.push({
          metric: key,
          percentage,
          severity: 'critical',
          message: `${key} is at ${percentage}% of limit (${data.used}/${data.limit})`,
        });
      } else if (percentage >= 75) {
        alerts.push({
          metric: key,
          percentage,
          severity: 'warning',
          message: `${key} is at ${percentage}% of limit (${data.used}/${data.limit})`,
        });
      }
    }

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      plan: {
        // `plan` IS the tier — it is the SubscriptionPlan enum value.
        name: subscription?.plan
          ? subscription.plan.charAt(0).toUpperCase() + subscription.plan.slice(1)
          : 'None',
        tier: subscription?.plan ?? null,
        status: subscription?.status ?? null,
        billingPeriod: subscription?.billingPeriod ?? null,
        // The entity has no `expiresAt`; nextBillingDate is the renewal date
        // and trialEndsAt is the trial cutoff.
        nextBillingDate: subscription?.nextBillingDate ?? null,
        trialEndsAt: subscription?.trialEndsAt ?? null,
      },
      usage: result,
      alerts,
    };
  }
}
