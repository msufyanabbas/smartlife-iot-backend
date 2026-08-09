// src/modules/alarms/services/alarms.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Alarm, Device, User as UserEntity } from '@modules/index.entities';
import { AlarmCondition, AlarmStatus, AlarmSeverity } from '@common/enums/index.enum';
import {
  CreateAlarmDto,
  UpdateAlarmDto,
  AlarmQueryDto,
  AcknowledgeAlarmDto,
  ResolveAlarmDto,
} from './dto/alarm.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
// See the note in alarms.consumer.ts — type-only import is required here for
// the same isolatedModules/emitDecoratorMetadata reason.
import type { Queue } from 'bull';
import { User } from '@modules/users/entities/user.entity';
import { PaginatedResponseDto } from '@common/dto/pagination.dto';
import {
  resolveEscalationRules,
  EscalationRule,
} from './alarm-escalation.policy';

@Injectable()
export class AlarmsService {
  private readonly logger = new Logger(AlarmsService.name);
  constructor(
    @InjectRepository(Alarm)
    private alarmRepository: Repository<Alarm>,
    @InjectRepository(Device)
    private deviceRepository: Repository<Device>,
    // Read-only: validates that an assignee belongs to the alarm's tenant.
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private eventEmitter: EventEmitter2,
    @InjectQueue('alarms')
    private alarmQueue: Queue,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // ESCALATION SCHEDULING
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Deterministic job id, so a job can be cancelled by id instead of scanning
   * the whole queue. Includes triggerCount because Bull treats a repeated
   * jobId as a duplicate and silently drops it — without the counter, an alarm
   * that cleared and re-fired would never get a second round of checks.
   */
  private escalationJobId(alarm: Alarm, level: number): string {
    return `esc:${alarm.id}:${alarm.triggerCount}:${level}`;
  }

  /**
   * Queue the immediate notification plus one delayed check per escalation
   * rung. Called on the ACTIVE edge only — see triggerAlarm().
   *
   * Failures here are logged, never thrown: the alarm has already fired and a
   * Redis hiccup must not turn a successful trigger into an error.
   */
  private async scheduleEscalation(alarm: Alarm): Promise<void> {
    const rules: EscalationRule[] = resolveEscalationRules(alarm);

    try {
      await this.alarmQueue.add(
        'new-alarm',
        { alarmId: alarm.id, tenantId: alarm.tenantId },
        {
          delay: 0,
          jobId: `new:${alarm.id}:${alarm.triggerCount}`,
          removeOnComplete: true,
        },
      );

      for (const rule of rules) {
        await this.alarmQueue.add(
          'check-escalation',
          { alarmId: alarm.id, tenantId: alarm.tenantId },
          {
            delay: rule.afterMinutes * 60 * 1000,
            jobId: this.escalationJobId(alarm, rule.level),
            attempts: 2,
            backoff: { type: 'fixed', delay: 30_000 },
            removeOnComplete: true,
          },
        );
      }

      this.logger.log(
        `Scheduled ${rules.length} escalation check(s) for alarm ${alarm.id} ` +
          `at [${rules.map((r) => `${r.afterMinutes}m`).join(', ')}]`,
      );
    } catch (e) {
      this.logger.warn(
        `Could not schedule escalation for alarm ${alarm.id}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Drop still-pending escalation checks once an alarm is handled.
   *
   * Removal is by deterministic id rather than by scanning
   * getJobs(['delayed','waiting']) — that scan walks every pending job for
   * every tenant on each acknowledge, which is O(queue) work on a hot path.
   *
   * The consumer re-checks status on wake anyway, so a job that slips through
   * is harmless; this just keeps the queue clean.
   */
  private async cancelEscalation(alarm: Alarm): Promise<void> {
    try {
      const rules = resolveEscalationRules(alarm);
      for (const rule of rules) {
        const job = await this.alarmQueue.getJob(
          this.escalationJobId(alarm, rule.level),
        );
        if (job) await job.remove();
      }
    } catch (e) {
      this.logger.warn(
        `Could not remove escalation jobs for alarm ${alarm.id}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Create new alarm rule
   */
  async create(user: User, createDto: CreateAlarmDto): Promise<Alarm> {
    // If deviceId is provided, get customerId from device
    let customerId = user.customerId;
    
    if (createDto.deviceId) {
      const device = await this.deviceRepository.findOne({
        where: { id: createDto.deviceId, tenantId: user.tenantId },
      });
      
      if (!device) {
        throw new NotFoundException(`Device with ID ${createDto.deviceId} not found`);
      }
      
      customerId = device.customerId;
    }

    const alarm = this.alarmRepository.create({
      ...createDto,
      tenantId: user.tenantId,
      customerId,
      createdBy: user.id,
      status: AlarmStatus.INACTIVE,
    });

    const saved = await this.alarmRepository.save(alarm);

    // Emit event for alarm created
    this.eventEmitter.emit('alarm.created', { alarm: saved });

    return saved;
  }

  /**
   * Find all alarms with filters
   */
  async findAll(
    tenantId: string | undefined,
    query: AlarmQueryDto,
    customerId?: string,
  ) {
    const {
      page = 1,
      limit = 20,
      deviceId,
      severity,
      status,
      search,
      tags,
    } = query;

    const queryBuilder = this.alarmRepository
      .createQueryBuilder('alarm')
      .leftJoinAndSelect('alarm.device', 'device')
      .where('alarm.tenantId = :tenantId', { tenantId });

    // Filter by customer if provided
    if (customerId) {
      queryBuilder.andWhere('alarm.customerId = :customerId', { customerId });
    }

    // Filter by device
    if (deviceId) {
      queryBuilder.andWhere('alarm.deviceId = :deviceId', { deviceId });
    }

    // Filter by severity
    if (severity) {
      queryBuilder.andWhere('alarm.severity = :severity', { severity });
    }

    // Filter by status
    if (status) {
      queryBuilder.andWhere('alarm.status = :status', { status });
    }

    // Search by name or description
    if (search) {
      queryBuilder.andWhere(
        '(alarm.name ILIKE :search OR alarm.description ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Filter by tags
    if (tags && tags.length > 0) {
      queryBuilder.andWhere('alarm.tags && :tags', { tags });
    }

    // Pagination
    const skip = (page - 1) * limit;
    queryBuilder.skip(skip).take(limit);

    // Order by severity (critical first), then by triggered date
    queryBuilder
      .addSelect(
        // Values MUST match alarms_severity_enum (lowercase: info/warning/error/critical).
        // Uppercase literals throw "invalid input value for enum alarms_severity_enum".
        `CASE
           WHEN alarm.severity = 'critical' THEN 1
           WHEN alarm.severity = 'error' THEN 2
           WHEN alarm.severity = 'warning' THEN 3
           WHEN alarm.severity = 'info' THEN 4
           ELSE 5
         END`,
        'severity_order',
      )
      .orderBy('severity_order', 'ASC')
      .addOrderBy('alarm.triggeredAt', 'DESC', 'NULLS LAST')
      .addOrderBy('alarm.createdAt', 'DESC');

    const [data, total] = await queryBuilder.getManyAndCount();

    return PaginatedResponseDto.create(data, page, limit, total);
  }

  /**
   * Get alarm by ID
   */
  async findOne(id: string, tenantId: string | undefined): Promise<Alarm> {
    const alarm = await this.alarmRepository.findOne({
      where: { id, tenantId },
      relations: ['device'],
    });

    if (!alarm) {
      throw new NotFoundException(`Alarm with ID ${id} not found`);
    }

    return alarm;
  }

  /**
   * Update alarm rule
   */
  async update(
    id: string,
    tenantId: string | undefined,
    updateDto: UpdateAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);

    Object.assign(alarm, updateDto);
    
    const saved = await this.alarmRepository.save(alarm);
    
    // Emit event
    this.eventEmitter.emit('alarm.updated', { alarm: saved });
    
    return saved;
  }

  /**
   * Delete alarm
   */
  async remove(id: string, tenantId: string | undefined): Promise<void> {
    const alarm = await this.findOne(id, tenantId);
    await this.alarmRepository.softRemove(alarm);
    
    // Emit event
    this.eventEmitter.emit('alarm.deleted', { alarm });
  }

  /**
   * Acknowledge alarm
   */
  async acknowledge(
    id: string,
    tenantId: string | undefined,
    userId: string,
    acknowledgeDto?: AcknowledgeAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);

    // ThingsBoard allows acknowledging a cleared alarm (CLEARED_UNACK →
    // CLEARED_ACK): an operator still needs to confirm they saw an alarm that
    // auto-cleared before they got to it. Only already-acknowledged, resolved
    // and dormant rows are rejected.
    if (
      alarm.status !== AlarmStatus.ACTIVE &&
      alarm.status !== AlarmStatus.CLEARED
    ) {
      throw new BadRequestException(
        `Cannot acknowledge an alarm with status: ${alarm.status}`,
      );
    }

    if (alarm.acknowledgedAt) {
      throw new BadRequestException('Alarm is already acknowledged');
    }

    alarm.acknowledge(userId);

    if (acknowledgeDto?.note) {
      alarm.metadata = {
        ...alarm.metadata,
        acknowledgeNote: acknowledgeDto.note,
      };
    }

    const saved = await this.alarmRepository.save(alarm);

    // Acknowledged — the unacknowledged window is closed, drop pending checks.
    await this.cancelEscalation(saved);

    // Emit event
    this.eventEmitter.emit('alarm.acknowledged', { alarm: saved, userId });

    return saved;
  }

  /**
   * Clear alarm
   */
  async clear(
    id: string,
    tenantId: string | undefined,
    userId?: string,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);

    if (
      alarm.status !== AlarmStatus.ACTIVE &&
      alarm.status !== AlarmStatus.ACKNOWLEDGED
    ) {
      throw new BadRequestException(
        'Only active or acknowledged alarms can be cleared',
      );
    }

    alarm.clear(userId);
    const saved = await this.alarmRepository.save(alarm);

    // Condition resolved — nothing left to escalate.
    await this.cancelEscalation(saved);

    // Emit event
    this.eventEmitter.emit('alarm.cleared', { alarm: saved });

    return saved;
  }

  /**
   * Assign an alarm to a user for handling, or unassign with userId = null.
   *
   * The assignee must belong to the same tenant — an alarm assigned to a user
   * who cannot see it would silently never be actioned.
   */
  async assign(
    id: string,
    tenantId: string | undefined,
    userId: string | null,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);

    if (userId) {
      const assignee = await this.userRepository.findOne({
        where: { id: userId, tenantId },
      });

      if (!assignee) {
        throw new NotFoundException('Assignee not found in this tenant');
      }
    }

    alarm.assign(userId);
    const saved = await this.alarmRepository.save(alarm);

    this.eventEmitter.emit('alarm.assigned', { alarm: saved, userId });

    return saved;
  }

  /**
   * Lean counts for an alarm dashboard.
   *
   * Reported in the ThingsBoard active/cleared × ack/unack shape, derived from
   * the stored status plus acknowledgedAt. One grouped query per axis rather
   * than the 13 sequential counts getStatistics() issues.
   */
  async getCounts(tenantId: string | undefined, customerId?: string) {
    const base = () => {
      const qb = this.alarmRepository
        .createQueryBuilder('alarm')
        .where('alarm.tenantId = :tenantId', { tenantId });
      if (customerId) {
        qb.andWhere('alarm.customerId = :customerId', { customerId });
      }
      return qb;
    };

    // Bucket on the same rule tbStatus uses, in SQL so it is one pass.
    const statusRows: Array<{ bucket: string; count: string }> = await base()
      .select(
        `CASE
           WHEN alarm.status = '${AlarmStatus.INACTIVE}' THEN 'INACTIVE'
           WHEN alarm.status = '${AlarmStatus.RESOLVED}' THEN 'CLEARED_ACK'
           WHEN alarm.status = '${AlarmStatus.CLEARED}'
             THEN CASE WHEN alarm.acknowledgedAt IS NULL
                       THEN 'CLEARED_UNACK' ELSE 'CLEARED_ACK' END
           WHEN alarm.status = '${AlarmStatus.ACKNOWLEDGED}' THEN 'ACTIVE_ACK'
           ELSE CASE WHEN alarm.acknowledgedAt IS NULL
                     THEN 'ACTIVE_UNACK' ELSE 'ACTIVE_ACK' END
         END`,
        'bucket',
      )
      .addSelect('COUNT(*)', 'count')
      .groupBy('bucket')
      .getRawMany();

    const severityRows: Array<{ severity: string; count: string }> = await base()
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .andWhere('alarm.status IN (:...activeStatuses)', {
        activeStatuses: [AlarmStatus.ACTIVE, AlarmStatus.ACKNOWLEDGED],
      })
      .groupBy('alarm.severity')
      .getRawMany();

    const byBucket = (name: string) =>
      parseInt(statusRows.find((r) => r.bucket === name)?.count ?? '0', 10);

    const bySev = (name: string) =>
      parseInt(severityRows.find((r) => r.severity === name)?.count ?? '0', 10);

    const activeUnack = byBucket('ACTIVE_UNACK');
    const activeAck = byBucket('ACTIVE_ACK');
    const clearedUnack = byBucket('CLEARED_UNACK');
    const clearedAck = byBucket('CLEARED_ACK');
    const inactive = byBucket('INACTIVE');

    return {
      total: activeUnack + activeAck + clearedUnack + clearedAck + inactive,
      active: activeUnack + activeAck,
      activeUnack,
      activeAck,
      cleared: clearedUnack + clearedAck,
      clearedUnack,
      clearedAck,
      // Dormant device-profile rules — watched but never fired. Reported
      // separately so they do not inflate the cleared bucket.
      inactive,
      bySeverity: {
        critical: bySev(AlarmSeverity.CRITICAL),
        error: bySev(AlarmSeverity.ERROR),
        warning: bySev(AlarmSeverity.WARNING),
        info: bySev(AlarmSeverity.INFO),
      },
    };
  }

  /**
   * Resolve alarm
   */
  async resolve(
    id: string,
    tenantId: string | undefined,
    userId: string,
    resolveDto: ResolveAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);

    alarm.resolve(userId, resolveDto.note);
    const saved = await this.alarmRepository.save(alarm);

    await this.cancelEscalation(saved);

    // Emit event
    this.eventEmitter.emit('alarm.resolved', { alarm: saved, userId });

    return saved;
  }

  /**
   * Escalation timeline for a single alarm.
   *
   * `escalationRules` reflects what will actually be applied — the alarm's own
   * override when set, otherwise the severity default from the shared policy.
   */
  async getEscalationHistory(id: string, tenantId: string | undefined) {
    const alarm = await this.findOne(id, tenantId);

    return {
      alarmId: alarm.id,
      alarmName: alarm.name,
      severity: alarm.severity,
      status: alarm.status,
      tbStatus: alarm.tbStatus,
      triggeredAt: alarm.triggeredAt,
      acknowledgedAt: alarm.acknowledgedAt,
      escalationLevel: alarm.escalationLevel,
      escalatedAt: alarm.escalatedAt,
      escalationHistory: alarm.escalationHistory ?? [],
      escalationRules: resolveEscalationRules(alarm),
      // False once the alarm leaves ACTIVE or is acknowledged — the same two
      // conditions the consumer checks before escalating.
      escalationActive:
        alarm.status === AlarmStatus.ACTIVE && !alarm.acknowledgedAt,
    };
  }

  /**
   * Enable alarm
   */
  async enable(id: string, tenantId: string | undefined): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);
    alarm.isEnabled = true;
    return await this.alarmRepository.save(alarm);
  }

  /**
   * Disable alarm
   */
  async disable(id: string, tenantId: string | undefined): Promise<Alarm> {
    const alarm = await this.findOne(id, tenantId);
    alarm.isEnabled = false;
    return await this.alarmRepository.save(alarm);
  }

  /**
   * Check telemetry value against alarm rules
   * This is called by the telemetry service when new data arrives
   */
  async checkAlarmConditions(
    deviceId: string,
    telemetryKey: string,
    value: any,
  ): Promise<void> {
    // Get device to get tenantId
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) return;

    // Get all enabled alarms for this device and telemetry key
    const alarms = await this.alarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.deviceId = :deviceId', { deviceId })
      .andWhere('alarm.tenantId = :tenantId', { tenantId: device.tenantId })
      .andWhere('alarm.isEnabled = :enabled', { enabled: true })
      .andWhere("alarm.rule->>'telemetryKey' = :telemetryKey", { telemetryKey })
      .getMany();

    for (const alarm of alarms) {
      const conditionMet = this.evaluateCondition(alarm.rule, value);

      if (conditionMet) {
        // Condition is met - trigger or update alarm
        await this.triggerAlarm(alarm, value);
      } else if (alarm.autoClear && alarm.status === AlarmStatus.ACTIVE) {
        // Condition not met and auto-clear enabled - clear the alarm
        alarm.clear();
        await this.alarmRepository.save(alarm);
        this.eventEmitter.emit('alarm.cleared', { alarm });
      }
    }
  }

  /**
   * Trigger alarm
   */
public async triggerAlarm(alarm: Alarm, value: number): Promise<void> {
  const wasAlreadyActive = alarm.status === AlarmStatus.ACTIVE && alarm.triggerCount > 0;

  this.logger.log(`triggerAlarm — status: ${alarm.status}, triggerCount: ${alarm.triggerCount}, wasAlreadyActive: ${wasAlreadyActive}`);

  alarm.trigger(value);
  const saved = await this.alarmRepository.save(alarm);

  if (!wasAlreadyActive) {
    this.logger.log(`Emitting alarm.triggered for alarm: ${saved.id}`);
    this.eventEmitter.emit('alarm.triggered', { alarm: saved });

    // Escalation is scheduled HERE, not in create(). create() persists a
    // dormant alarm *rule* with status INACTIVE and no triggeredAt — queueing
    // there would start an escalation ladder for a rule that has never fired,
    // and the consumer's elapsed-time maths would run against a null
    // triggeredAt. This is the ACTIVE edge, so it is the real start of the
    // unacknowledged window.
    await this.scheduleEscalation(saved);
  } else {
    this.logger.log(`Skipping emit — alarm was already active`);
  }
}

  /**
   * Evaluate if condition is met
   */
private evaluateCondition(rule: any, value: any): boolean {
  switch (rule.condition) {
    case AlarmCondition.GREATER_THAN:
      return value > rule.value;
    case AlarmCondition.LESS_THAN:
      return value < rule.value;
    case AlarmCondition.EQUAL:
      return String(value) === String(rule.value); // ← String compare for non-numeric
    case AlarmCondition.NOT_EQUAL:
      return String(value) !== String(rule.value);
    case AlarmCondition.GREATER_THAN_OR_EQUAL:
      return value >= rule.value;
    case AlarmCondition.LESS_THAN_OR_EQUAL:
      return value <= rule.value;
    case AlarmCondition.BETWEEN:
      return value >= rule.value && value <= rule.value2;
    case AlarmCondition.OUTSIDE:
      return value < rule.value || value > rule.value2;
    case AlarmCondition.CONTAINS:
      return String(value).toLowerCase().includes(String(rule.value).toLowerCase());
    case AlarmCondition.NOT_CONTAINS:
      return !String(value).toLowerCase().includes(String(rule.value).toLowerCase());
    case AlarmCondition.EXISTS:
      return value !== undefined && value !== null;
    default:
      return false;
  }
}

  /**
   * Get active alarms
   */
  async getActive(tenantId: string | undefined, customerId?: string): Promise<Alarm[]> {
    const whereCondition: any = {
      tenantId,
      status: AlarmStatus.ACTIVE,
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.alarmRepository.find({
      where: whereCondition,
      relations: ['device'],
      order: {
        // Postgres orders an enum by its declared position, and
        // alarms_severity_enum is declared info(1) → warning → error →
        // critical(4). ASC therefore returned INFO first, the opposite of what
        // the comment claimed. DESC is what puts CRITICAL at the top.
        severity: 'DESC',
        triggeredAt: 'DESC',
      },
    });
  }

  /**
   * Get critical unacknowledged alarms
   */
  async getCritical(tenantId: string | undefined, customerId?: string): Promise<Alarm[]> {
    const whereCondition: any = {
      tenantId,
      status: AlarmStatus.ACTIVE,
      severity: AlarmSeverity.CRITICAL,
    };

    if (customerId) {
      whereCondition.customerId = customerId;
    }

    return await this.alarmRepository.find({
      where: whereCondition,
      relations: ['device'],
      order: { triggeredAt: 'DESC' },
    });
  }

  /**
   * Get alarms for a specific device
   */
  async getDeviceAlarms(tenantId: string | undefined, deviceId: string): Promise<Alarm[]> {
    return await this.alarmRepository.find({
      where: { tenantId, deviceId },
      order: {
        // alarms_status_enum is declared active(1) first, so ASC is correct
        // here; alarms_severity_enum is declared critical LAST, so severity
        // needs DESC to surface critical first.
        status: 'ASC',
        severity: 'DESC',
        triggeredAt: 'DESC',
      },
    });
  }

  /**
   * Get alarm statistics
   */
  async getStatistics(tenantId: string | undefined, customerId?: string) {
    const whereCondition: any = { tenantId };
    
    if (customerId) {
      whereCondition.customerId = customerId;
    }

    const total = await this.alarmRepository.count({ where: whereCondition });

    const active = await this.alarmRepository.count({
      where: { ...whereCondition, status: AlarmStatus.ACTIVE },
    });

    const acknowledged = await this.alarmRepository.count({
      where: { ...whereCondition, status: AlarmStatus.ACKNOWLEDGED },
    });

    const cleared = await this.alarmRepository.count({
      where: { ...whereCondition, status: AlarmStatus.CLEARED },
    });

    const resolved = await this.alarmRepository.count({
      where: { ...whereCondition, status: AlarmStatus.RESOLVED },
    });

    // Count by severity (active only)
    const critical = await this.alarmRepository.count({
      where: {
        ...whereCondition,
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.ACTIVE,
      },
    });

    const error = await this.alarmRepository.count({
      where: {
        ...whereCondition,
        severity: AlarmSeverity.ERROR,
        status: AlarmStatus.ACTIVE,
      },
    });

    const warning = await this.alarmRepository.count({
      where: {
        ...whereCondition,
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACTIVE,
      },
    });

    const info = await this.alarmRepository.count({
      where: {
        ...whereCondition,
        severity: AlarmSeverity.INFO,
        status: AlarmStatus.ACTIVE,
      },
    });

    // Get most triggered alarms
    const mostTriggered = await this.alarmRepository.find({
      where: whereCondition,
      relations: ['device'],
      order: { triggerCount: 'DESC' },
      take: 5,
    });

    // Get recent alarms
    const recent = await this.alarmRepository.find({
      where: whereCondition,
      relations: ['device'],
      order: { triggeredAt: 'DESC' },
      take: 10,
    });

    return {
      total,
      byStatus: {
        active,
        acknowledged,
        cleared,
        resolved,
      },
      bySeverity: {
        critical,
        error,
        warning,
        info,
      },
      mostTriggered,
      recent,
    };
  }

  /**
   * Get alarm history for a device
   */
  async getDeviceHistory(
    tenantId: string | undefined,
    deviceId: string,
    days: number = 7,
  ): Promise<Alarm[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await this.alarmRepository.find({
      where: {
        tenantId,
        deviceId,
        triggeredAt: Between(startDate, new Date()),
      },
      order: { triggeredAt: 'DESC' },
      take: 100,
    });
  }

  /**
   * Bulk acknowledge alarms
   */
  async bulkAcknowledge(
    tenantId: string | undefined,
    userId: string,
    alarmIds: string[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of alarmIds) {
      try {
        await this.acknowledge(id, tenantId, userId);
        success++;
      } catch (error) {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Bulk clear alarms
   */
  async bulkClear(
    tenantId: string | undefined,
    alarmIds: string[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of alarmIds) {
      try {
        await this.clear(id, tenantId);
        success++;
      } catch (error) {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Bulk resolve alarms
   */
  async bulkResolve(
    tenantId: string | undefined,
    userId: string,
    alarmIds: string[],
    note: string,
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of alarmIds) {
      try {
        await this.resolve(id, tenantId, userId, { note });
        success++;
      } catch (error) {
        failed++;
      }
    }

    return { success, failed };
  }

  async checkAlarmConditionsBatch(
  deviceId: string,
  flatData: Record<string, any>,
  keys: string[],
): Promise<void> {
  const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
  if (!device) return;

  // Single query — get all enabled alarms for this device matching any of the keys
  const alarms = await this.alarmRepository
    .createQueryBuilder('alarm')
    .where('alarm.deviceId = :deviceId', { deviceId })
    .andWhere('alarm.tenantId = :tenantId', { tenantId: device.tenantId })
    .andWhere('alarm.isEnabled = :enabled', { enabled: true })
    .andWhere("alarm.rule->>'telemetryKey' = ANY(:keys)", { keys })
    .getMany();

  if (alarms.length === 0) return;

  for (const alarm of alarms) {
    const telemetryKey = alarm.rule.telemetryKey as string;
    const value = flatData[telemetryKey];

    if (value === undefined) continue;

    const conditionMet = this.evaluateCondition(alarm.rule, value);

    if (conditionMet) {
      await this.triggerAlarm(alarm, value);
    } else if (alarm.autoClear && alarm.status === AlarmStatus.ACTIVE) {
      alarm.clear();
      await this.alarmRepository.save(alarm);
      this.eventEmitter.emit('alarm.cleared', { alarm });
    }
  }
}

  /**
   * Test alarm rule (simulate trigger)
   */
  async testAlarm(
    id: string,
    tenantId: string | undefined,
    testValue: number,
  ): Promise<any> {
    const alarm = await this.findOne(id, tenantId);

    const conditionMet = this.evaluateCondition(alarm.rule, testValue);

    return {
      alarmId: alarm.id,
      alarmName: alarm.name,
      rule: alarm.rule,
      testValue,
      conditionMet,
      message: conditionMet
        ? `Alarm would trigger: ${alarm.rule.telemetryKey} ${testValue} meets condition`
        : `Alarm would not trigger: condition not met`,
    };
  }
}