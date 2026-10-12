import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { DeviceProfile } from '@modules/profiles/entities/device-profile.entity';
import { DefaultRuleChain } from './entities/default-rule-chain.entity';
import {
  CreateDefaultRuleChainDto,
  DefaultRuleChainQueryDto,
  SetDefaultRuleChainDto,
  UpdateDefaultRuleChainDto,
} from './dto/default-rule-chain.dto';
import {
  DEFAULT_RULE_CHAIN_ANY,
  DEFAULT_RULE_CHAIN_MESSAGE_TYPES,
  DefaultRuleChainOriginatorType,
} from './default-rule-chain.enum';
import { DefaultRuleChainResolverService } from './default-rule-chain-resolver.service';

@Injectable()
export class DefaultRuleChainsService {
  private readonly logger = new Logger(DefaultRuleChainsService.name);

  constructor(
    @InjectRepository(DefaultRuleChain)
    private readonly mappingRepo: Repository<DefaultRuleChain>,
    // Repositories rather than RulesModule / ProfilesModule: RulesModule
    // imports THIS module (the consumer needs the resolver), so importing it
    // back would close a cycle.
    @InjectRepository(RuleChain)
    private readonly ruleChainRepo: Repository<RuleChain>,
    @InjectRepository(DeviceProfile)
    private readonly deviceProfileRepo: Repository<DeviceProfile>,
    private readonly resolver: DefaultRuleChainResolverService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    tenantId: string,
    userId: string,
    dto: CreateDefaultRuleChainDto,
  ): Promise<DefaultRuleChain> {
    const originatorType =
      dto.originatorType ?? dto.type ?? DefaultRuleChainOriginatorType.DEVICE;
    const messageType = this.normaliseMessageType(dto.messageType);

    await this.assertTargetsExist(tenantId, dto.ruleChainId, dto.deviceProfileId);
    await this.assertNoClash(tenantId, originatorType, messageType, dto.deviceProfileId ?? null);

    const row = this.mappingRepo.create({
      tenantId,
      userId,
      createdBy: userId,
      name: dto.name,
      description: dto.description,
      originatorType,
      messageType,
      deviceProfileId: dto.deviceProfileId ?? null,
      ruleChainId: dto.ruleChainId,
      priority: dto.priority ?? 0,
      enabled: dto.enabled ?? true,
      additionalInfo: dto.additionalInfo,
    });

    const saved = await this.mappingRepo.save(row);
    this.resolver.invalidate(tenantId);
    this.logger.log(
      `Default rule chain mapping "${saved.name}" (${saved.id}) created — ` +
        `${saved.originatorType}/${saved.messageType ?? '*'}` +
        `${saved.deviceProfileId ? `/profile:${saved.deviceProfileId}` : ''} → chain ${saved.ruleChainId}`,
    );
    return saved;
  }

  async findAll(
    tenantId: string,
    query: DefaultRuleChainQueryDto,
  ): Promise<PaginatedResponseDto<DefaultRuleChain>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;

    const qb = this.mappingRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.ruleChain', 'ruleChain')
      .where('m.tenantId = :tenantId', { tenantId });

    const originatorType = query.originatorType ?? query.type;
    if (originatorType) {
      qb.andWhere('m.originatorType = :originatorType', { originatorType });
    }
    if (query.messageType) {
      qb.andWhere('m.messageType = :messageType', {
        messageType: query.messageType,
      });
    }
    if (query.enabled !== undefined) {
      qb.andWhere('m.enabled = :enabled', { enabled: query.enabled });
    }
    if (query.search) {
      qb.andWhere('(m.name ILIKE :search OR m.description ILIKE :search)', {
        search: `%${query.search}%`,
      });
    }

    const sortable = new Set(['name', 'priority', 'createdAt', 'updatedAt']);
    const sortBy = sortable.has(query.sortBy ?? '') ? query.sortBy! : 'priority';

    const [rows, total] = await qb
      .orderBy(`m.${sortBy}`, query.sortOrder ?? 'DESC', 'NULLS LAST')
      .addOrderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return PaginatedResponseDto.create(rows, page, limit, total);
  }

  async findOne(tenantId: string, id: string): Promise<DefaultRuleChain> {
    const row = await this.mappingRepo.findOne({
      where: { id, tenantId },
      relations: ['ruleChain'],
    });
    if (!row) {
      throw new NotFoundException(`Default rule chain mapping ${id} not found`);
    }
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    userId: string,
    dto: UpdateDefaultRuleChainDto,
  ): Promise<DefaultRuleChain> {
    const row = await this.findOne(tenantId, id);

    const originatorType =
      dto.originatorType ?? dto.type ?? row.originatorType;
    const messageType =
      dto.messageType !== undefined
        ? this.normaliseMessageType(dto.messageType)
        : (row.messageType ?? null);
    const deviceProfileId =
      dto.deviceProfileId !== undefined
        ? (dto.deviceProfileId ?? null)
        : (row.deviceProfileId ?? null);
    const ruleChainId = dto.ruleChainId ?? row.ruleChainId;

    await this.assertTargetsExist(tenantId, ruleChainId, deviceProfileId);

    const keyChanged =
      originatorType !== row.originatorType ||
      messageType !== (row.messageType ?? null) ||
      deviceProfileId !== (row.deviceProfileId ?? null);
    if (keyChanged) {
      await this.assertNoClash(
        tenantId,
        originatorType,
        messageType,
        deviceProfileId,
        id,
      );
    }

    row.name = dto.name ?? row.name;
    if (dto.description !== undefined) row.description = dto.description;
    row.originatorType = originatorType;
    row.messageType = messageType;
    row.deviceProfileId = deviceProfileId;
    row.ruleChainId = ruleChainId;
    if (dto.priority !== undefined) row.priority = dto.priority;
    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.additionalInfo !== undefined) row.additionalInfo = dto.additionalInfo;
    row.updatedBy = userId;

    const saved = await this.mappingRepo.save(row);
    this.resolver.invalidate(tenantId);
    return saved;
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    const row = await this.findOne(tenantId, id);
    await this.mappingRepo.softRemove(row);
    this.resolver.invalidate(tenantId);
    return { message: `Default rule chain mapping "${row.name}" deleted` };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE SHIPPED FRONTEND'S SHORTCUTS: /type/:type
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * The catch-all mapping for an originator type — the row with no messageType
   * and no deviceProfileId. That is what "the default rule chain for devices"
   * means, and it is the row `default-rule-chains.api.ts`'s `getByType` and
   * `setDefault` operate on.
   */
  async findByOriginatorType(
    tenantId: string,
    originatorType: string,
  ): Promise<DefaultRuleChain> {
    const row = await this.mappingRepo.findOne({
      where: {
        tenantId,
        originatorType,
        messageType: IsNull(),
        deviceProfileId: IsNull(),
      },
      relations: ['ruleChain'],
    });
    if (!row) {
      throw new NotFoundException(
        `No catch-all default rule chain is configured for originator type "${originatorType}"`,
      );
    }
    return row;
  }

  /** Create or repoint the catch-all mapping for an originator type. */
  async setForOriginatorType(
    tenantId: string,
    userId: string,
    originatorType: string,
    dto: SetDefaultRuleChainDto,
  ): Promise<DefaultRuleChain> {
    await this.assertTargetsExist(tenantId, dto.ruleChainId, null);

    const existing = await this.mappingRepo.findOne({
      where: {
        tenantId,
        originatorType,
        messageType: IsNull(),
        deviceProfileId: IsNull(),
      },
    });

    if (existing) {
      existing.ruleChainId = dto.ruleChainId;
      existing.enabled = true;
      if (dto.name) existing.name = dto.name;
      existing.updatedBy = userId;
      const saved = await this.mappingRepo.save(existing);
      this.resolver.invalidate(tenantId);
      return saved;
    }

    const row = this.mappingRepo.create({
      tenantId,
      userId,
      createdBy: userId,
      name: dto.name ?? `Default chain for ${originatorType}`,
      originatorType,
      messageType: null,
      deviceProfileId: null,
      ruleChainId: dto.ruleChainId,
      priority: 0,
      enabled: true,
    });
    const saved = await this.mappingRepo.save(row);
    this.resolver.invalidate(tenantId);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ-ONLY SURFACES
  // ══════════════════════════════════════════════════════════════════════════

  getMessageTypes() {
    return {
      suggested: [...DEFAULT_RULE_CHAIN_MESSAGE_TYPES],
      originatorTypes: Object.values(DefaultRuleChainOriginatorType),
      any: DEFAULT_RULE_CHAIN_ANY,
      note:
        'messageType is free text — the rule-engine consumer forwards ' +
        'payload.eventType verbatim, so these are suggestions rather than the ' +
        'allowed set. Only DEVICE originators reach rules.input today.',
    };
  }

  async getStatistics(tenantId: string) {
    const rows = await this.mappingRepo.find({
      where: { tenantId },
      relations: ['ruleChain'],
    });

    return {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled).length,
      byOriginatorType: rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.originatorType] = (acc[r.originatorType] ?? 0) + 1;
        return acc;
      }, {}),
      mappings: rows.map((r) => ({
        id: r.id,
        name: r.name,
        originatorType: r.originatorType,
        messageType: r.messageType ?? DEFAULT_RULE_CHAIN_ANY,
        deviceProfileId: r.deviceProfileId ?? null,
        ruleChainId: r.ruleChainId,
        ruleChainName: r.ruleChain?.name ?? null,
        enabled: r.enabled,
        priority: r.priority,
        specificity: r.specificity(),
        // bigint comes back from the driver as a string.
        matchCount: Number(r.matchCount ?? 0),
        lastMatchedAt: r.lastMatchedAt ?? null,
      })),
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ══════════════════════════════════════════════════════════════════════════

  /** `'*'` and `''` both mean "any", which is stored as NULL. */
  private normaliseMessageType(messageType?: string | null): string | null {
    if (messageType === undefined || messageType === null) return null;
    const trimmed = messageType.trim();
    if (!trimmed || trimmed === DEFAULT_RULE_CHAIN_ANY) return null;
    return trimmed.toUpperCase();
  }

  /**
   * Both ids are validated against the CALLER'S TENANT, not merely for
   * existence. An unchecked id here is the cross-tenant hole: a crafted
   * `ruleChainId` would otherwise route this tenant's telemetry into another
   * tenant's chain, running their nodes — and therefore their alarms, scripts
   * and outbound HTTP calls — with this tenant's data.
   */
  private async assertTargetsExist(
    tenantId: string,
    ruleChainId: string,
    deviceProfileId: string | null | undefined,
  ): Promise<void> {
    const errors: string[] = [];

    const chain = await this.ruleChainRepo.findOne({
      where: { id: ruleChainId, tenantId },
    });
    if (!chain) {
      errors.push(
        `ruleChainId ${ruleChainId} does not exist in this tenant`,
      );
    }

    if (deviceProfileId) {
      const profile = await this.deviceProfileRepo.findOne({
        where: { id: deviceProfileId, tenantId },
      });
      if (!profile) {
        errors.push(
          `deviceProfileId ${deviceProfileId} does not exist in this tenant`,
        );
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: 'Default rule chain mapping references rows this tenant does not own',
        errors,
      });
    }
  }

  /**
   * The logical key is (tenantId, originatorType, messageType, deviceProfileId)
   * but PostgreSQL treats NULLs as distinct, so a plain UNIQUE constraint does
   * not stop two "any message type" rows for the same originator. The migration
   * builds the index over COALESCE expressions; this check exists so the user
   * sees a 409 naming the existing rule rather than a driver error.
   */
  private async assertNoClash(
    tenantId: string,
    originatorType: string,
    messageType: string | null,
    deviceProfileId: string | null,
    exceptId?: string,
  ): Promise<void> {
    const where: Record<string, any> = {
      tenantId,
      originatorType,
      messageType: messageType === null ? IsNull() : messageType,
      deviceProfileId:
        deviceProfileId === null ? IsNull() : deviceProfileId,
    };
    if (exceptId) where.id = Not(exceptId);

    const clash = await this.mappingRepo.findOne({ where: where as any });
    if (clash) {
      throw new ConflictException(
        `A mapping for ${originatorType}/${messageType ?? DEFAULT_RULE_CHAIN_ANY}` +
          `${deviceProfileId ? `/profile:${deviceProfileId}` : ''} already exists ` +
          `("${clash.name}", ${clash.id}). Update it instead, or narrow this one ` +
          'with a messageType or deviceProfileId.',
      );
    }
  }
}
