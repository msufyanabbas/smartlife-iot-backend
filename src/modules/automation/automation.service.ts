// src/modules/automations/automation.service.ts
import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Automation } from '@modules/index.entities';
import { AutomationStatus, UserRole } from '@common/enums/index.enum';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { PaginationDto } from '@common/dto/pagination.dto';

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @InjectRepository(Automation)
    private readonly automationRepo: Repository<Automation>,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE
  // ══════════════════════════════════════════════════════════════════════════

  async create(
    userId: string,
    tenantId: string,
    customerId: string | null,
    dto: CreateAutomationDto,
  ): Promise<Automation> {
    // Check for duplicate name in tenant
    const existing = await this.automationRepo.findOne({
      where: { tenantId, name: dto.name },
    });

    if (existing) {
      throw new ConflictException('Automation with this name already exists');
    }

    // Build the automation object, only include customerId if it's not null
    const automationData: any = {
      ...dto,
      tenantId,
      userId,
      status: dto.enabled ? AutomationStatus.ACTIVE : AutomationStatus.INACTIVE,
    };

    // Only add customerId if it's not null
    if (customerId) {
      automationData.customerId = customerId;
    }

    const automation = this.automationRepo.create(automationData);

    const saved: any = await this.automationRepo.save(automation);
    this.logger.log(`Automation created: ${saved.id} by user ${userId}`);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // READ
  // ══════════════════════════════════════════════════════════════════════════

  async findAll(
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    pagination: PaginationDto,
  ) {
    const { page = 1, limit = 10, search, sortBy = 'createdAt', sortOrder = 'DESC' } = pagination;
    const skip = (page - 1) * limit;

    const qb = this.automationRepo
      .createQueryBuilder('automation')
      .where('automation.tenantId = :tenantId', { tenantId });

    // Customer isolation
    if (role === UserRole.CUSTOMER && customerId) {
      qb.andWhere('automation.customerId = :customerId', { customerId });
    }

    if (search) {
      qb.andWhere(
        '(automation.name ILIKE :search OR automation.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy(`automation.${sortBy}`, sortOrder as 'ASC' | 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();

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
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ): Promise<Automation> {
    const where: any = { id, tenantId };
    
    if (role === UserRole.CUSTOMER && customerId) {
      where.customerId = customerId;
    }

    const automation = await this.automationRepo.findOne({ where });

    if (!automation) {
      throw new NotFoundException('Automation not found');
    }

    return automation;
  }

  async getStatistics(
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ) {
    const where: any = { tenantId };
    
    if (role === UserRole.CUSTOMER && customerId) {
      where.customerId = customerId;
    }

    const [total, active, inactive, error] = await Promise.all([
      this.automationRepo.count({ where }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.ACTIVE } }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.INACTIVE } }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.ERROR } }),
    ]);

    // Total executions
    const execResult = await this.automationRepo
      .createQueryBuilder('a')
      .select('SUM(a.executionCount)', 'total')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere(customerId ? 'a.customerId = :customerId' : '1=1', { customerId })
      .getRawOne();

    // By trigger type
    const byTrigger = await this.automationRepo
      .createQueryBuilder('a')
      .select("a.trigger->>'type'", 'type')
      .addSelect('COUNT(*)', 'count')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere(customerId ? 'a.customerId = :customerId' : '1=1', { customerId })
      .groupBy("a.trigger->>'type'")
      .getRawMany();

    return {
      total,
      active,
      inactive,
      error,
      totalExecutions: parseInt(execResult?.total || '0'),
      byTrigger: byTrigger.reduce((acc, item) => {
        acc[item.type] = parseInt(item.count);
        return acc;
      }, {}),
    };
  }

  async getExecutionLogs(id: string, tenantId: string, limit: number = 10) {
    const automation = await this.automationRepo.findOne({
      where: { id, tenantId },
    });

    if (!automation) {
      throw new NotFoundException('Automation not found');
    }

    // TODO: Query AutomationLog entity when created
    return {
      automationId: automation.id,
      automationName: automation.name,
      totalExecutions: automation.executionCount,
      lastTriggered: automation.lastTriggered,
      logs: [], // Will be populated from AutomationLog table
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ══════════════════════════════════════════════════════════════════════════

  async update(
    id: string,
    userId: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    dto: UpdateAutomationDto,
  ): Promise<Automation> {
    const automation = await this.findOne(id, tenantId, customerId, role);

    Object.assign(automation, dto);

    if (dto.enabled !== undefined) {
      automation.status = dto.enabled ? AutomationStatus.ACTIVE : AutomationStatus.INACTIVE;
    }

    const saved = await this.automationRepo.save(automation);
    this.logger.log(`Automation updated: ${id} by user ${userId}`);
    return saved;
  }

  async toggle(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ): Promise<Automation> {
    const automation = await this.findOne(id, tenantId, customerId, role);

    automation.enabled = !automation.enabled;
    automation.status = automation.enabled ? AutomationStatus.ACTIVE : AutomationStatus.INACTIVE;

    const saved = await this.automationRepo.save(automation);
    this.logger.log(`Automation toggled: ${id} → ${automation.enabled ? 'ON' : 'OFF'}`);
    return saved;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ══════════════════════════════════════════════════════════════════════════

  async remove(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ): Promise<void> {
    const automation = await this.findOne(id, tenantId, customerId, role);
    await this.automationRepo.softRemove(automation);
    this.logger.log(`Automation deleted: ${id}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MANUAL EXECUTION (For Testing)
  // ══════════════════════════════════════════════════════════════════════════

  async executeManually(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ): Promise<{ success: boolean; message: string }> {
    const automation = await this.findOne(id, tenantId, customerId, role);

    if (!automation.enabled) {
      throw new ConflictException('Automation is disabled');
    }

    // TODO: Call AutomationProcessor.executeAction(automation)
    // For now, just update tracking
    automation.executionCount++;
    automation.lastTriggered = new Date();
    automation.lastExecuted = new Date();
    await this.automationRepo.save(automation);

    this.logger.log(`Automation manually executed: ${id}`);

    return {
      success: true,
      message: `Automation "${automation.name}" executed successfully`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL METHODS (Used by AutomationProcessor)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Find all active automations watching a specific device
   * Called by AutomationProcessor when telemetry arrives
   */
  async findActiveByDevice(deviceId: string): Promise<Automation[]> {
    return this.automationRepo
      .createQueryBuilder('a')
      .where("a.trigger->>'deviceId' = :deviceId", { deviceId })
      .andWhere('a.enabled = :enabled', { enabled: true })
      .andWhere('a.status != :error', { error: AutomationStatus.ERROR })
      .getMany();
  }
}