import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import axios from 'axios';
import {
  Automation,
  AutomationLog,
  Device,
  Alarm,
  User,
} from '@modules/index.entities';
import type {
  AutomationAction,
  AutomationCondition,
  AutomationTrigger,
} from './entities/automation.entity';
import type {
  AutomationActionResult,
  AutomationConditionResult,
} from './entities/automation-log.entity';
import {
  AutomationStatus,
  AutomationTriggerType,
  AutomationActionType,
  AutomationExecutionStatus,
  AutomationConditionOperator,
  UserRole,
  TriggerType,
  ActionType,
  AttributeScope,
  AlarmStatus,
  AlarmSeverity,
  DeviceStatus,
  NotificationChannel,
  NotificationType,
  NotificationPriority,
} from '@common/enums/index.enum';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { PaginationDto, PaginatedResponseDto } from '@common/dto/pagination.dto';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { DeviceCommandsService } from '@modules/device-commands/device-commands.service';
import { AttributesService } from '@modules/attributes/attributes.service';
import { RuleEngineService } from '@modules/rules/rule-engine.service';

/** Result of one execution, returned by executeManually(). */
export interface AutomationExecutionResult {
  success: boolean;
  executionId: string;
  status: AutomationExecutionStatus;
  durationMs: number;
  conditionResults: AutomationConditionResult[];
  actionResults: AutomationActionResult[];
}

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @InjectRepository(Automation)
    private readonly automationRepo: Repository<Automation>,
    @InjectRepository(AutomationLog)
    private readonly logRepo: Repository<AutomationLog>,
    @InjectRepository(Device)
    private readonly deviceRepo: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepo: Repository<Alarm>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly deviceCommandsService: DeviceCommandsService,
    private readonly attributesService: AttributesService,
    // RulesModule -> NodesModule -> ... can reach back here; forwardRef keeps
    // the cycle resolvable.
    @Inject(forwardRef(() => RuleEngineService))
    private readonly ruleEngineService: InstanceType<typeof RuleEngineService>,
  ) {}

  // ==========================================================================
  // CRUD
  // ==========================================================================

  async create(
    userId: string,
    tenantId: string,
    customerId: string | null,
    dto: CreateAutomationDto,
  ): Promise<Automation> {
    const existing = await this.automationRepo.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new ConflictException('Automation with this name already exists');
    }

    this.assertActionsAreValid(dto.actions as AutomationAction[] | undefined);

    const data: any = {
      ...dto,
      tenantId,
      userId,
      createdBy: userId,
      actions: dto.actions ?? [],
      conditions: dto.conditions ?? [],
      status: dto.enabled === false
        ? AutomationStatus.INACTIVE
        : AutomationStatus.ACTIVE,
    };
    if (customerId) data.customerId = customerId;

    const saved = await this.automationRepo.save(
      this.automationRepo.create(data) as unknown as Automation,
    );
    this.logger.log(`Automation created: ${saved.id} by user ${userId}`);
    return saved;
  }

  async findAll(
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    pagination: PaginationDto,
  ) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = pagination;

    const qb = this.automationRepo
      .createQueryBuilder('automation')
      .where('automation.tenantId = :tenantId', { tenantId });

    if (role === UserRole.CUSTOMER && customerId) {
      qb.andWhere('automation.customerId = :customerId', { customerId });
    }

    if (search) {
      qb.andWhere(
        '(automation.name ILIKE :search OR automation.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Whitelisted so a caller cannot inject arbitrary SQL through sortBy -
    // PaginationDto validates it as a free-form @IsString().
    const sortable = new Set([
      'createdAt', 'updatedAt', 'name', 'enabled', 'status',
      'executionCount', 'successCount', 'failureCount', 'lastExecutedAt',
    ]);
    const orderBy = sortable.has(sortBy) ? sortBy : 'createdAt';

    qb.orderBy(`automation.${orderBy}`, sortOrder as 'ASC' | 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return PaginatedResponseDto.create(data, page, limit, total);
  }

  async findOne(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ): Promise<Automation> {
    const where: any = { id, tenantId };
    if (role === UserRole.CUSTOMER && customerId) where.customerId = customerId;

    const automation = await this.automationRepo.findOne({ where });
    if (!automation) throw new NotFoundException('Automation not found');
    return automation;
  }

  async update(
    id: string,
    userId: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    dto: UpdateAutomationDto,
  ): Promise<Automation> {
    const automation = await this.findOne(id, tenantId, customerId, role);

    if (dto.actions) {
      this.assertActionsAreValid(dto.actions as AutomationAction[]);
    }

    Object.assign(automation, dto);

    if (dto.enabled !== undefined) {
      automation.status = dto.enabled
        ? AutomationStatus.ACTIVE
        : AutomationStatus.INACTIVE;
    }
    automation.updatedBy = userId;

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
    automation.status = automation.enabled
      ? AutomationStatus.ACTIVE
      : AutomationStatus.INACTIVE;
    // Re-enabling is the documented way to clear a wedged ERROR state.
    if (automation.enabled) automation.lastError = null;

    const saved = await this.automationRepo.save(automation);
    this.logger.log(
      `Automation toggled: ${id} -> ${automation.enabled ? 'ON' : 'OFF'}`,
    );
    return saved;
  }

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

  // ==========================================================================
  // STATISTICS / LOGS
  // ==========================================================================

  async getStatistics(
    tenantId: string,
    customerId: string | null,
    role: UserRole,
  ) {
    const where: any = { tenantId };
    if (role === UserRole.CUSTOMER && customerId) where.customerId = customerId;

    const [total, enabled, active, inactive, error] = await Promise.all([
      this.automationRepo.count({ where }),
      this.automationRepo.count({ where: { ...where, enabled: true } }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.ACTIVE } }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.INACTIVE } }),
      this.automationRepo.count({ where: { ...where, status: AutomationStatus.ERROR } }),
    ]);

    const qb = () => {
      const b = this.automationRepo
        .createQueryBuilder('a')
        .where('a.tenantId = :tenantId', { tenantId });
      if (role === UserRole.CUSTOMER && customerId) {
        b.andWhere('a.customerId = :customerId', { customerId });
      }
      return b;
    };

    const totals = await qb()
      .select('SUM(a.executionCount)', 'executions')
      .addSelect('SUM(a.successCount)', 'successes')
      .addSelect('SUM(a.failureCount)', 'failures')
      .getRawOne();

    const byTrigger = await qb()
      .select("a.trigger->>'type'", 'type')
      .addSelect('COUNT(*)', 'count')
      .groupBy("a.trigger->>'type'")
      .getRawMany();

    return {
      total,
      enabled,
      disabled: total - enabled,
      active,
      inactive,
      error,
      totalExecutions: parseInt(totals?.executions ?? '0', 10),
      totalSuccesses: parseInt(totals?.successes ?? '0', 10),
      totalFailures: parseInt(totals?.failures ?? '0', 10),
      byTrigger: byTrigger.reduce((acc: Record<string, number>, row: any) => {
        acc[row.type ?? 'unknown'] = parseInt(row.count, 10);
        return acc;
      }, {}),
    };
  }

  /** Execution history for one automation, newest first. */
  async getLogs(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    pagination: PaginationDto,
  ) {
    await this.findOne(id, tenantId, customerId, role);

    const { page = 1, limit = 20 } = pagination;

    const [data, total] = await this.logRepo.findAndCount({
      where: { automationId: id, tenantId },
      order: { executedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  // ==========================================================================
  // TRIGGER EVALUATION
  //
  // Every evaluate*() entry point is fire-and-forget from the caller's point
  // of view and swallows its own errors: an automation must never be able to
  // fail the telemetry / alarm / device pipeline that invoked it.
  // ==========================================================================

  /**
   * Load enabled automations of one trigger type for a tenant.
   * The type comparison accepts the legacy lowercase spellings so pre-engine
   * rows keep working (threshold/state -> TELEMETRY, schedule -> SCHEDULE).
   */
  private async loadByTriggerType(
    tenantId: string,
    type: AutomationTriggerType,
  ): Promise<Automation[]> {
    const all = await this.automationRepo.find({
      where: { tenantId, enabled: true },
    });
    return all.filter((a) => this.normaliseTriggerType(a.trigger) === type);
  }

  /** Map a v1 trigger.type onto its v2 equivalent. */
  private normaliseTriggerType(
    trigger: AutomationTrigger | undefined,
  ): AutomationTriggerType | undefined {
    const raw = trigger?.type;
    if (!raw) return undefined;

    switch (raw) {
      case TriggerType.THRESHOLD:
      case TriggerType.STATE:
      case TriggerType.EVENT:
        return AutomationTriggerType.TELEMETRY;
      case TriggerType.SCHEDULE:
        return AutomationTriggerType.SCHEDULE;
      default:
        return raw as AutomationTriggerType;
    }
  }

  /**
   * A v1 row carried its comparison on the trigger itself
   * ({operator, value, value2}) with no `conditions` array. Synthesise the
   * equivalent condition so both generations run through one evaluator.
   */
  private effectiveConditions(automation: Automation): AutomationCondition[] {
    if (automation.conditions?.length) return automation.conditions;

    const t = automation.trigger;
    const key = t?.telemetryKey ?? t?.attributeKey;
    if (!key || !t?.operator) return [];

    const legacyOps: Record<string, AutomationConditionOperator> = {
      eq: AutomationConditionOperator.EQ,
      ne: AutomationConditionOperator.NEQ,
      gt: AutomationConditionOperator.GT,
      gte: AutomationConditionOperator.GTE,
      lt: AutomationConditionOperator.LT,
      lte: AutomationConditionOperator.LTE,
      between: AutomationConditionOperator.BETWEEN,
    };

    const operator = legacyOps[t.operator] ?? (t.operator as AutomationConditionOperator);
    return [{ key, operator, value: t.value, value2: t.value2 }];
  }

  /**
   * Hoist the ThingsBoard envelope {ts, values:{...}} so a condition can name
   * the bare key, and flatten nested objects to dot paths. Mirrors what
   * ProfileAlarmService does for device-profile alarm rules.
   */
  private flattenTelemetry(data: Record<string, any>): Record<string, any> {
    if (!data || typeof data !== 'object') return {};

    const source =
      data.values && typeof data.values === 'object' && !Array.isArray(data.values)
        ? { ...data, ...data.values }
        : data;

    const out: Record<string, any> = {};
    const walk = (obj: Record<string, any>, prefix = '') => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          out[path] = v;
          walk(v, path);
        } else {
          out[path] = v;
        }
      }
    };
    walk(source);
    return out;
  }

  /**
   * Called for every stored telemetry frame (Kafka consumer for the MQTT /
   * CoAP path, TelemetryService directly for the HTTP path).
   */
  async evaluateTelemetryTriggers(
    deviceId: string,
    tenantId: string,
    telemetry: Record<string, any>,
  ): Promise<void> {
    try {
      const candidates = await this.loadByTriggerType(
        tenantId,
        AutomationTriggerType.TELEMETRY,
      );
      if (!candidates.length) return;

      const device = await this.deviceRepo.findOne({
        where: { id: deviceId, tenantId },
      });
      if (!device) return;

      const flat = this.flattenTelemetry(telemetry);

      for (const automation of candidates) {
        const t = automation.trigger;

        // Device scope filters. Any that is set must match; unset means "all".
        if (t.deviceId && t.deviceId !== deviceId) continue;
        if (t.assetId && t.assetId !== device.assetId) continue;
        if (t.deviceType && t.deviceType !== (device as any).type) continue;

        // The watched key must be present in this frame, otherwise a device
        // reporting only humidity would re-run a temperature automation
        // against a stale value.
        if (t.telemetryKey && flat[t.telemetryKey] === undefined) continue;

        this.runIfPermitted(automation, {
          telemetry: flat,
          device,
          deviceId,
          triggerType: AutomationTriggerType.TELEMETRY,
        }, deviceId);
      }
    } catch (err: any) {
      this.logger.error(`Failed to evaluate telemetry triggers: ${err.message}`);
    }
  }

  /** Called from the alarm.created / alarm.triggered event listeners. */
  async evaluateAlarmTriggers(alarm: any, tenantId: string): Promise<void> {
    try {
      const candidates = await this.loadByTriggerType(
        tenantId,
        AutomationTriggerType.ALARM,
      );
      if (!candidates.length) return;

      for (const automation of candidates) {
        const t = automation.trigger;
        if (t.alarmSeverity && t.alarmSeverity !== alarm?.severity) continue;
        if (t.alarmStatus && t.alarmStatus !== alarm?.status) continue;
        if (t.deviceId && t.deviceId !== alarm?.deviceId) continue;

        this.runIfPermitted(automation, {
          alarm,
          deviceId: alarm?.deviceId,
          triggerType: AutomationTriggerType.ALARM,
        }, alarm?.deviceId ?? null);
      }
    } catch (err: any) {
      this.logger.error(`Failed to evaluate alarm triggers: ${err.message}`);
    }
  }

  /** Called from the device.connected / device.offline event listeners. */
  async evaluateDeviceStatusTriggers(
    deviceId: string,
    tenantId: string,
    status: string,
  ): Promise<void> {
    try {
      const candidates = await this.loadByTriggerType(
        tenantId,
        AutomationTriggerType.DEVICE_STATUS,
      );
      if (!candidates.length) return;

      const device = await this.deviceRepo.findOne({
        where: { id: deviceId, tenantId },
      });

      for (const automation of candidates) {
        const t = automation.trigger;
        if (t.deviceId && t.deviceId !== deviceId) continue;
        if (t.assetId && device && t.assetId !== device.assetId) continue;
        if (t.targetStatus && t.targetStatus !== status) continue;

        this.runIfPermitted(automation, {
          device,
          deviceId,
          status,
          triggerType: AutomationTriggerType.DEVICE_STATUS,
        }, deviceId);
      }
    } catch (err: any) {
      this.logger.error(`Failed to evaluate device status triggers: ${err.message}`);
    }
  }

  /** Called from the attributes.updated event listener. */
  async evaluateAttributeTriggers(
    entityType: string,
    entityId: string,
    tenantId: string,
    attributes: Record<string, any>,
  ): Promise<void> {
    try {
      if (entityType !== 'DEVICE') return;

      const candidates = await this.loadByTriggerType(
        tenantId,
        AutomationTriggerType.ATTRIBUTE,
      );
      if (!candidates.length) return;

      const device = await this.deviceRepo.findOne({
        where: { id: entityId, tenantId },
      });

      for (const automation of candidates) {
        const t = automation.trigger;
        if (t.deviceId && t.deviceId !== entityId) continue;
        if (t.attributeKey && attributes[t.attributeKey] === undefined) continue;

        this.runIfPermitted(automation, {
          attributes,
          // Conditions of type ATTRIBUTE read from the same bag as TELEMETRY,
          // so expose it under both names.
          telemetry: attributes,
          device,
          deviceId: entityId,
          triggerType: AutomationTriggerType.ATTRIBUTE,
        }, entityId);
      }
    } catch (err: any) {
      this.logger.error(`Failed to evaluate attribute triggers: ${err.message}`);
    }
  }

  /**
   * Gate + condition check + dispatch. Deliberately returns void and handles
   * its own rejection: callers run inside the telemetry/alarm pipeline and
   * must not be slowed down or failed by an automation.
   */
  private runIfPermitted(
    automation: Automation,
    context: Record<string, any>,
    deviceId: string | null,
  ): void {
    void (async () => {
      if (!automation.canExecute()) {
        this.logger.debug(
          `Automation ${automation.id} gated by cooldown / active hours / days`,
        );
        return;
      }

      if (await this.dailyCapReached(automation)) {
        this.logger.debug(
          `Automation ${automation.id} hit maxExecutionsPerDay`,
        );
        return;
      }

      const bag = this.conditionBag(context);
      const { passed, results } = this.evaluateConditions(
        this.effectiveConditions(automation),
        bag,
        context.device,
      );

      if (!passed) return;

      this.logger.log(
        `Automation "${automation.name}" triggered by ${context.triggerType}` +
          (deviceId ? ` (device ${deviceId})` : ''),
      );

      await this.executeAutomation(automation, context, deviceId, results);
    })().catch((err) =>
      this.logger.error(
        `Automation ${automation.id} execution failed: ${err.message}`,
      ),
    );
  }

  /**
   * Where conditions read their actual values from, in priority order:
   * the telemetry frame, then the attribute bag, then the trigger payload
   * itself (so an ALARM automation can test `severity`).
   */
  private conditionBag(context: Record<string, any>): Record<string, any> {
    return {
      ...(context.alarm ?? {}),
      ...(context.attributes ?? {}),
      ...(context.telemetry ?? {}),
      ...(context.status !== undefined ? { status: context.status } : {}),
    };
  }

  /**
   * maxExecutionsPerDay cannot be answered from the denormalised counters,
   * so it is counted from automation_logs since local midnight.
   */
  private async dailyCapReached(automation: Automation): Promise<boolean> {
    const cap = automation.settings?.maxExecutionsPerDay;
    if (!cap || cap <= 0) return false;

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const count = await this.logRepo
      .createQueryBuilder('log')
      .where('log.automationId = :id', { id: automation.id })
      .andWhere('log.executedAt >= :midnight', { midnight })
      .getCount();

    return count >= cap;
  }

  // ==========================================================================
  // CONDITION EVALUATION
  // ==========================================================================

  /**
   * Left-to-right evaluation; each row's `logic` joins it to the NEXT row.
   * There is no operator precedence - `A OR B AND C` reads as `(A OR B) AND C`.
   * An empty list always passes.
   */
  private evaluateConditions(
    conditions: AutomationCondition[],
    bag: Record<string, any>,
    device: any,
  ): { passed: boolean; results: AutomationConditionResult[] } {
    const results: AutomationConditionResult[] = [];
    if (!conditions?.length) return { passed: true, results };

    let accumulated = true;
    let pendingLogic: 'AND' | 'OR' = 'AND';

    for (const condition of conditions) {
      const actualValue = this.resolveConditionValue(condition, bag, device);
      const passed = this.evaluateSingleCondition(condition, actualValue);

      results.push({
        key: condition.key,
        operator: String(condition.operator),
        value: condition.value,
        actualValue,
        passed,
      });

      accumulated =
        pendingLogic === 'OR' ? accumulated || passed : accumulated && passed;

      pendingLogic = condition.logic === 'OR' ? 'OR' : 'AND';
    }

    return { passed: accumulated, results };
  }

  private resolveConditionValue(
    condition: AutomationCondition,
    bag: Record<string, any>,
    device: any,
  ): any {
    if (condition.type === 'DEVICE_FIELD') {
      return device?.[condition.key];
    }
    // Dot paths already exist in the flattened bag; fall back to the device
    // record so a mixed condition set still resolves.
    return bag?.[condition.key] ?? device?.[condition.key];
  }

  private evaluateSingleCondition(
    condition: AutomationCondition,
    actualValue: any,
  ): boolean {
    const op = String(condition.operator).toUpperCase();

    if (actualValue === undefined || actualValue === null) {
      // EXISTS is the only operator with a meaningful answer for a missing
      // value, and that answer is false.
      return false;
    }

    if (op === AutomationConditionOperator.EXISTS) return true;

    const num = Number(actualValue);
    const target = Number(condition.value);
    const comparable = !Number.isNaN(num) && !Number.isNaN(target);

    switch (op) {
      case AutomationConditionOperator.GT:
        return comparable && num > target;
      case AutomationConditionOperator.GTE:
        return comparable && num >= target;
      case AutomationConditionOperator.LT:
        return comparable && num < target;
      case AutomationConditionOperator.LTE:
        return comparable && num <= target;
      case AutomationConditionOperator.BETWEEN:
        return (
          comparable &&
          num >= target &&
          num <= Number(condition.value2)
        );
      case AutomationConditionOperator.EQ:
        // Loose by design: a codec may emit "30" where the rule says 30.
        return String(actualValue) === String(condition.value);
      case AutomationConditionOperator.NEQ:
        return String(actualValue) !== String(condition.value);
      case AutomationConditionOperator.CONTAINS:
        return Array.isArray(actualValue)
          ? actualValue.includes(condition.value)
          : String(actualValue).includes(String(condition.value));
      default:
        this.logger.warn(`Unknown condition operator: ${condition.operator}`);
        return false;
    }
  }

  // ==========================================================================
  // EXECUTION
  // ==========================================================================

  /**
   * Run an automation on demand. Conditions ARE evaluated against whatever
   * context the caller supplies, so a dry-run with realistic values behaves
   * exactly like the live path; pass no context to run actions unconditionally
   * (an empty bag makes every condition fail, so supply the keys you test).
   * Cooldown / active-hours gating is intentionally bypassed - a manual run is
   * an operator decision.
   */
  async executeManually(
    id: string,
    tenantId: string,
    customerId: string | null,
    role: UserRole,
    userId: string,
    context: Record<string, any> = {},
  ): Promise<AutomationExecutionResult> {
    const automation = await this.findOne(id, tenantId, customerId, role);

    if (!automation.enabled) {
      throw new ConflictException('Automation is disabled');
    }

    const deviceId = context.deviceId ?? automation.trigger?.deviceId ?? null;

    let device: Device | null = null;
    if (deviceId) {
      device = await this.deviceRepo.findOne({ where: { id: deviceId, tenantId } });
    }

    const enriched = {
      ...context,
      telemetry: this.flattenTelemetry(context.telemetry ?? {}),
      device: device ?? context.device,
      deviceId,
      triggerType: AutomationTriggerType.MANUAL,
    };

    const { passed, results } = this.evaluateConditions(
      this.effectiveConditions(automation),
      this.conditionBag(enriched),
      device,
    );

    if (!passed) {
      // Not an error: the operator asked for a realistic run and the data did
      // not meet the rule. Report it instead of silently claiming success -
      // the v1 stub always answered "executed successfully".
      throw new BadRequestException({
        message: 'Automation conditions did not pass for the supplied context',
        conditionResults: results,
      });
    }

    return this.executeAutomation(automation, enriched, deviceId, results, userId);
  }

  /**
   * Runs the action list in ascending `order`, sequentially, writes one
   * AutomationLog row and updates the denormalised counters.
   *
   * A failing action does not abort the remaining actions - the run is
   * reported as `partial` unless every action failed.
   */
  private async executeAutomation(
    automation: Automation,
    context: Record<string, any>,
    deviceId: string | null,
    conditionResults: AutomationConditionResult[] = [],
    triggeredBy: string | null = null,
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    const actionResults: AutomationActionResult[] = [];

    const actions = [...(automation.actions ?? [])].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
    );

    for (const action of actions) {
      const actionStart = Date.now();
      let status: AutomationActionResult['status'] = 'success';
      let error: string | undefined;

      try {
        if (action.delay && action.delay > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, action.delay! * 1000),
          );
        }
        await this.executeAction(action, automation, context, deviceId);
      } catch (err: any) {
        status = 'failed';
        error = err?.message ?? String(err);
        this.logger.error(
          `Action ${action.type} of automation ${automation.id} failed: ${error}`,
        );
      }

      actionResults.push({
        type: String(action.type),
        order: action.order,
        status,
        durationMs: Date.now() - actionStart,
        error,
      });
    }

    const failed = actionResults.filter((r) => r.status === 'failed').length;
    const overall: AutomationExecutionStatus =
      failed === 0
        ? AutomationExecutionStatus.SUCCESS
        : failed === actionResults.length
          ? AutomationExecutionStatus.FAILED
          : AutomationExecutionStatus.PARTIAL;

    const durationMs = Date.now() - startedAt;
    const firstError = actionResults.find((r) => r.error)?.error ?? null;

    const log = await this.logRepo.save(
      this.logRepo.create({
        automationId: automation.id,
        tenantId: automation.tenantId,
        status: overall,
        durationMs,
        triggerData: this.serialisableContext(context),
        conditionResults,
        actionResults,
        deviceId,
        triggerType: String(context.triggerType ?? ''),
        triggeredBy,
        error: firstError,
        executedAt: new Date(),
      }),
    );

    // Counters are incremented in SQL so two concurrent runs cannot lose one.
    await this.automationRepo.increment({ id: automation.id }, 'executionCount', 1);
    if (overall === AutomationExecutionStatus.SUCCESS) {
      await this.automationRepo.increment({ id: automation.id }, 'successCount', 1);
    } else if (overall === AutomationExecutionStatus.FAILED) {
      await this.automationRepo.increment({ id: automation.id }, 'failureCount', 1);
    }

    const now = new Date();
    await this.automationRepo.update(
      { id: automation.id },
      {
        lastExecutedAt: now,
        lastTriggered: now,
        lastExecutionStatus: overall,
        lastError: firstError,
        // A failed run is recorded but never disables the automation - the v1
        // engine set status=ERROR here and excluded it from every later query.
      },
    );

    // Keep the in-memory copy consistent for the cooldown check on the next
    // frame in this same batch.
    automation.lastExecutedAt = now;

    return {
      success: overall !== AutomationExecutionStatus.FAILED,
      executionId: log.id,
      status: overall,
      durationMs,
      conditionResults,
      actionResults,
    };
  }

  /** Strip entity instances out of the context before it is stored as jsonb. */
  private serialisableContext(context: Record<string, any>): Record<string, any> {
    const { device, alarm, ...rest } = context;
    return {
      ...rest,
      ...(device ? { device: { id: device.id, name: device.name, deviceKey: device.deviceKey } } : {}),
      ...(alarm ? { alarm: { id: alarm.id, name: alarm.name, severity: alarm.severity, status: alarm.status } } : {}),
    };
  }

  // ==========================================================================
  // ACTION EXECUTORS
  // ==========================================================================

  private async executeAction(
    action: AutomationAction,
    automation: Automation,
    context: Record<string, any>,
    deviceId: string | null,
  ): Promise<void> {
    const cfg = action.config ?? {};
    const targetDeviceId =
      cfg.targetDeviceId ?? deviceId ?? context.deviceId ?? null;

    switch (String(action.type)) {
      case AutomationActionType.SEND_NOTIFICATION:
        return this.actionSendNotification(cfg, automation, context);

      case AutomationActionType.SEND_COMMAND:
        return this.actionSendCommand(cfg, automation, targetDeviceId);

      case AutomationActionType.UPDATE_ATTRIBUTE:
        return this.actionUpdateAttribute(cfg, automation, targetDeviceId);

      case AutomationActionType.CREATE_ALARM:
        return this.actionCreateAlarm(cfg, automation, context, targetDeviceId);

      case AutomationActionType.CLEAR_ALARM:
        return this.actionClearAlarm(cfg, automation, targetDeviceId);

      case AutomationActionType.TRIGGER_RULE_CHAIN:
        return this.actionTriggerRuleChain(cfg, automation, context, targetDeviceId);

      case AutomationActionType.WEBHOOK:
        return this.actionWebhook(cfg, context);

      case AutomationActionType.UPDATE_DEVICE_STATUS:
        return this.actionUpdateDeviceStatus(cfg, automation, targetDeviceId);

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }

  /**
   * One Notification row per (recipient x channel) - NotificationsService
   * takes a single channel per record, not a list.
   * Recipients default to the automation owner.
   */
  private async actionSendNotification(
    cfg: AutomationAction['config'],
    automation: Automation,
    context: Record<string, any>,
  ): Promise<void> {
    const title = this.interpolate(cfg.title ?? automation.name, context);
    const message = this.interpolate(
      cfg.message ?? `Automation "${automation.name}" triggered`,
      context,
    );

    const recipientIds = cfg.recipients?.length
      ? cfg.recipients
      : [automation.userId];

    const users = await this.userRepo.find({
      where: { id: In(recipientIds), tenantId: automation.tenantId },
    });

    if (!users.length) {
      throw new Error(
        `No recipient resolved for notification (ids: ${recipientIds.join(', ')})`,
      );
    }

    const channels = (cfg.channels?.length ? cfg.channels : ['in_app'])
      .map((c) => String(c).toLowerCase() as NotificationChannel)
      .filter((c) => Object.values(NotificationChannel).includes(c));

    if (!channels.length) {
      throw new Error(`No valid channel in ${JSON.stringify(cfg.channels)}`);
    }

    for (const user of users) {
      for (const channel of channels) {
        await this.notificationsService.create(
          {
            userId: user.id,
            type: NotificationType.AUTOMATION,
            channel,
            priority: NotificationPriority.NORMAL,
            title,
            message,
            relatedEntityType: 'automation',
            relatedEntityId: automation.id,
            recipientEmail: user.email,
            metadata: {
              automationId: automation.id,
              automationName: automation.name,
              triggerType: context.triggerType,
              deviceId: context.deviceId ?? null,
            },
          },
          user,
        );
      }
    }
  }

  private async actionSendCommand(
    cfg: AutomationAction['config'],
    automation: Automation,
    targetDeviceId: string | null,
  ): Promise<void> {
    if (!targetDeviceId) throw new Error('No target device for SEND_COMMAND');

    // command may be given either as {method, params} or flat {commandType,...}
    const commandType =
      cfg.commandType ?? cfg.command?.method ?? cfg.command?.commandType;
    if (!commandType) {
      throw new Error('SEND_COMMAND needs config.commandType or config.command.method');
    }

    await this.deviceCommandsService.createCommand(
      {
        deviceId: targetDeviceId,
        commandType,
        params: cfg.command?.params ?? cfg.command ?? {},
      },
      automation.userId,
      automation.tenantId,
    );
  }

  private async actionUpdateAttribute(
    cfg: AutomationAction['config'],
    automation: Automation,
    targetDeviceId: string | null,
  ): Promise<void> {
    if (!targetDeviceId) throw new Error('No target device for UPDATE_ATTRIBUTE');
    if (!cfg.attributes?.length) {
      throw new Error('UPDATE_ATTRIBUTE needs config.attributes');
    }

    const actor = await this.actingUser(automation);

    const scope = (String(cfg.scope ?? AttributeScope.SHARED)
      .toLowerCase()
      .replace('_scope', '') as AttributeScope);

    // Entries without a key are dropped rather than written as an attribute
    // literally named "undefined". Throwing on an empty result keeps a
    // misconfigured action from reporting success while writing nothing.
    const payload = cfg.attributes.reduce(
      (acc: Record<string, any>, a) => {
        if (a && typeof a.key === 'string' && a.key.length > 0) {
          acc[a.key] = a.value;
        }
        return acc;
      },
      {},
    );

    if (Object.keys(payload).length === 0) {
      throw new Error(
        'UPDATE_ATTRIBUTE: config.attributes contained no usable {key, value} entries',
      );
    }

    await this.attributesService.saveAttributes(
      actor,
      'DEVICE',
      targetDeviceId,
      Object.values(AttributeScope).includes(scope) ? scope : AttributeScope.SHARED,
      payload,
    );
  }

  /**
   * Idempotent: an automation firing on every frame above a threshold must not
   * create a new alarm row each time. An existing ACTIVE/ACKNOWLEDGED alarm
   * with the same name on the same device is re-triggered instead.
   */
  private async actionCreateAlarm(
    cfg: AutomationAction['config'],
    automation: Automation,
    context: Record<string, any>,
    targetDeviceId: string | null,
  ): Promise<void> {
    const name = cfg.alarmName ?? automation.name;
    const severity = (String(cfg.severity ?? AlarmSeverity.WARNING).toLowerCase() as AlarmSeverity);

    const existing = await this.alarmRepo.findOne({
      where: {
        tenantId: automation.tenantId,
        deviceId: targetDeviceId ?? undefined,
        name,
        status: In([AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED]),
      },
    });

    if (existing) {
      existing.triggerCount += 1;
      existing.lastTriggeredAt = new Date();
      await this.alarmRepo.save(existing);
      return;
    }

    let customerId: string | undefined;
    if (targetDeviceId) {
      const device = await this.deviceRepo.findOne({
        where: { id: targetDeviceId, tenantId: automation.tenantId },
      });
      customerId = device?.customerId;
    }

    await this.alarmRepo.save(
      this.alarmRepo.create({
        tenantId: automation.tenantId,
        customerId: customerId ?? automation.customerId,
        deviceId: targetDeviceId ?? undefined,
        name,
        severity: Object.values(AlarmSeverity).includes(severity)
          ? severity
          : AlarmSeverity.WARNING,
        status: AlarmStatus.ACTIVE,
        // alarms.rule is NOT NULL, but this alarm is owned by the automation
        // engine, not by the standalone alarm engine.
        //
        // The sentinel telemetryKey keeps it out of
        // AlarmsService.checkAlarmConditionsBatch(), whose query is
        // `rule->>'telemetryKey' = ANY(keys)`. With the real key here, the next
        // telemetry frame selected this row, failed to evaluate the unknown
        // 'AUTOMATION' condition, and auto-cleared the alarm the automation had
        // just raised. autoClear is disabled for the same reason: only the
        // automation's own CLEAR_ALARM action should clear it.
        rule: {
          telemetryKey: '__automation__',
          condition: 'AUTOMATION' as any,
          threshold: 0,
          automationId: automation.id,
          watchedKey: automation.trigger?.telemetryKey ?? null,
        } as any,
        autoClear: false,
        message: `Created by automation: ${automation.name}`,
        description: automation.description ?? undefined,
        triggeredAt: new Date(),
        lastTriggeredAt: new Date(),
        triggerCount: 1,
        currentValue:
          typeof context.telemetry?.[automation.trigger?.telemetryKey ?? ''] === 'number'
            ? context.telemetry[automation.trigger!.telemetryKey!]
            : undefined,
        createdBy: automation.userId,
      }),
    );
  }

  private async actionClearAlarm(
    cfg: AutomationAction['config'],
    automation: Automation,
    targetDeviceId: string | null,
  ): Promise<void> {
    const where: any = {
      tenantId: automation.tenantId,
      status: In([AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED]),
    };
    if (cfg.alarmName) where.name = cfg.alarmName;
    if (targetDeviceId) where.deviceId = targetDeviceId;

    await this.alarmRepo.update(where, {
      status: AlarmStatus.CLEARED,
      clearedAt: new Date(),
      clearedBy: automation.userId,
    });
  }

  /**
   * Executes the chain in-process via RuleEngineService rather than posting to
   * Kafka: the caller gets a real success/failure for the log instead of a
   * fire-and-forget enqueue.
   */
  private async actionTriggerRuleChain(
    cfg: AutomationAction['config'],
    automation: Automation,
    context: Record<string, any>,
    targetDeviceId: string | null,
  ): Promise<void> {
    if (!cfg.ruleChainId) throw new Error('No ruleChainId for TRIGGER_RULE_CHAIN');

    const result = await this.ruleEngineService.executeChainById(
      automation.tenantId,
      cfg.ruleChainId,
      {
        type: 'AUTOMATION',
        originator: {
          id: targetDeviceId ?? automation.id,
          type: targetDeviceId ? 'DEVICE' : 'AUTOMATION',
        },
        data: context.telemetry ?? context.attributes ?? {},
        metadata: {
          tenantId: automation.tenantId,
          automationId: automation.id,
          automationName: automation.name,
          deviceKey: context.device?.deviceKey,
        },
        timestamp: Date.now(),
      },
    );

    if (!result.success) {
      throw new Error(
        `Rule chain ${cfg.ruleChainId} failed: ${result.error ?? 'unknown error'}`,
      );
    }
  }

  private async actionWebhook(
    cfg: AutomationAction['config'],
    context: Record<string, any>,
  ): Promise<void> {
    if (!cfg.url) throw new Error('No URL for WEBHOOK action');

    const body = cfg.body
      ? this.interpolateObject(cfg.body, context)
      : this.serialisableContext(context);

    const response = await axios({
      method: (cfg.method ?? 'POST') as any,
      url: cfg.url,
      headers: { 'Content-Type': 'application/json', ...(cfg.headers ?? {}) },
      data: body,
      timeout: 10000,
      // Let any status through so a 4xx/5xx becomes a clear error message
      // rather than an axios stack trace.
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      throw new Error(`Webhook responded ${response.status}`);
    }
  }

  private async actionUpdateDeviceStatus(
    cfg: AutomationAction['config'],
    automation: Automation,
    targetDeviceId: string | null,
  ): Promise<void> {
    if (!targetDeviceId) throw new Error('No target device for UPDATE_DEVICE_STATUS');

    const status = String(cfg.status ?? DeviceStatus.OFFLINE).toLowerCase() as DeviceStatus;
    if (!Object.values(DeviceStatus).includes(status)) {
      throw new Error(`Invalid device status: ${cfg.status}`);
    }

    const result = await this.deviceRepo.update(
      { id: targetDeviceId, tenantId: automation.tenantId },
      { status },
    );

    if (!result.affected) {
      throw new Error(`Device ${targetDeviceId} not found in tenant`);
    }
  }

  // ==========================================================================
  // SCHEDULED AUTOMATIONS
  // ==========================================================================

  /**
   * Called once a minute by AutomationScheduler. Runs every SCHEDULE
   * automation whose cron expression matches the current minute.
   *
   * Cron matching is done here rather than by registering a dynamic
   * @Cron per row so that enabling/editing an automation takes effect
   * immediately without re-registering anything.
   */
  async runDueScheduledAutomations(now: Date = new Date()): Promise<number> {
    const automations = await this.automationRepo
      .createQueryBuilder('a')
      .where("a.trigger->>'type' IN (:...types)", {
        types: [AutomationTriggerType.SCHEDULE, TriggerType.SCHEDULE],
      })
      .andWhere('a.enabled = :enabled', { enabled: true })
      .getMany();

    let fired = 0;

    for (const automation of automations) {
      const expression =
        automation.trigger?.cronExpression ?? automation.trigger?.schedule;
      if (!expression) continue;

      if (!this.cronMatches(expression, now)) continue;
      if (!automation.canExecute(now)) continue;
      if (await this.dailyCapReached(automation)) continue;

      fired++;
      this.runIfPermitted(
        automation,
        { triggerType: AutomationTriggerType.SCHEDULE, scheduledAt: now.toISOString() },
        automation.trigger?.deviceId ?? null,
      );
    }

    return fired;
  }

  /**
   * Minimal 5-field cron matcher: `minute hour dayOfMonth month dayOfWeek`.
   * Supports *, lists (1,2), ranges (1-5) and steps (STAR/5, 0-30/10).
   * Deliberately not a dependency - the scheduler ticks once a minute and only
   * needs a match/no-match answer.
   */
  private cronMatches(expression: string, now: Date): boolean {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      this.logger.warn(`Unsupported cron expression (need 5 fields): ${expression}`);
      return false;
    }

    const fields: Array<[string, number]> = [
      [parts[0], now.getMinutes()],
      [parts[1], now.getHours()],
      [parts[2], now.getDate()],
      [parts[3], now.getMonth() + 1],
      [parts[4], now.getDay()],
    ];

    return fields.every(([field, actual]) => this.cronFieldMatches(field, actual));
  }

  private cronFieldMatches(field: string, actual: number): boolean {
    for (const term of field.split(',')) {
      const [range, stepRaw] = term.split('/');
      const step = stepRaw ? parseInt(stepRaw, 10) : 1;
      if (Number.isNaN(step) || step < 1) continue;

      if (range === '*') {
        if (actual % step === 0) return true;
        continue;
      }

      if (range.includes('-')) {
        const [lo, hi] = range.split('-').map((n) => parseInt(n, 10));
        if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
        if (actual >= lo && actual <= hi && (actual - lo) % step === 0) return true;
        continue;
      }

      const exact = parseInt(range, 10);
      // Cron allows both 0 and 7 for Sunday.
      if (exact === actual) return true;
      if (exact === 7 && actual === 0) return true;
    }
    return false;
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * The User that stands behind actions needing an actor (attribute writes).
   * Falls back to a synthetic tenant-admin so a deleted owner does not make
   * every action of the automation fail.
   */
  private async actingUser(automation: Automation): Promise<User> {
    const owner = await this.userRepo.findOne({
      where: { id: automation.userId, tenantId: automation.tenantId },
    });
    if (owner) return owner;

    return {
      id: automation.userId,
      tenantId: automation.tenantId,
      customerId: automation.customerId,
      role: UserRole.TENANT_ADMIN,
    } as User;
  }

  /** Replace {{a.b.c}} with the value at that path in the context. */
  private interpolate(template: string, context: Record<string, any>): string {
    if (typeof template !== 'string') return template;

    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
      let value: any = context;
      for (const key of path.split('.')) {
        value = value?.[key];
        if (value === undefined || value === null) return match;
      }
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
  }

  /**
   * Interpolates every string inside an object. Walks the structure rather
   * than round-tripping through JSON so a replaced value containing a quote
   * cannot corrupt the document.
   */
  private interpolateObject(value: any, context: Record<string, any>): any {
    if (typeof value === 'string') return this.interpolate(value, context);
    if (Array.isArray(value)) {
      return value.map((v) => this.interpolateObject(v, context));
    }
    if (value && typeof value === 'object') {
      return Object.entries(value).reduce((acc: Record<string, any>, [k, v]) => {
        acc[k] = this.interpolateObject(v, context);
        return acc;
      }, {});
    }
    return value;
  }

  /** Reject an action list the engine could never execute. */
  private assertActionsAreValid(actions?: AutomationAction[]): void {
    if (!actions?.length) return;

    const known = new Set<string>(Object.values(AutomationActionType));
    for (const action of actions) {
      if (!known.has(String(action.type))) {
        throw new BadRequestException(
          `Unknown action type "${action.type}". Valid types: ${[...known].join(', ')}`,
        );
      }
      if (
        String(action.type) === AutomationActionType.WEBHOOK &&
        !action.config?.url
      ) {
        throw new BadRequestException('WEBHOOK action requires config.url');
      }
      if (
        String(action.type) === AutomationActionType.TRIGGER_RULE_CHAIN &&
        !action.config?.ruleChainId
      ) {
        throw new BadRequestException(
          'TRIGGER_RULE_CHAIN action requires config.ruleChainId',
        );
      }
    }
  }
}
