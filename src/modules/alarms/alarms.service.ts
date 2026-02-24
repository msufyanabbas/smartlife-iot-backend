import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Between } from 'typeorm';
import { Alarm } from '@modules/index.entities'
import { AlarmCondition, AlarmStatus, AlarmSeverity} from '@common/enums/index.enum';
import {
  CreateAlarmDto,
  UpdateAlarmDto,
  AlarmQueryDto,
  AcknowledgeAlarmDto,
  ResolveAlarmDto,
} from './dto/alarm.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class AlarmsService {
  constructor(
    @InjectRepository(Alarm)
    private alarmRepository: Repository<Alarm>,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create new alarm rule
   */
  async create(userId: string, createDto: CreateAlarmDto): Promise<Alarm> {
    const alarm = this.alarmRepository.create({
      ...createDto,
      userId,
      status: AlarmStatus.ACTIVE,
    });

    const saved = await this.alarmRepository.save(alarm);

    // Emit event for alarm created
    this.eventEmitter.emit('alarm.created', { alarm: saved });

    return saved;
  }

  /**
   * Find all alarms with filters
   */
  async findAll(userId: string, query: AlarmQueryDto) {
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
      .where('alarm.userId = :userId', { userId });

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

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get alarm by ID
   */
  async findOne(id: string, userId: string): Promise<Alarm> {
    const alarm = await this.alarmRepository.findOne({
      where: { id, userId },
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
    userId: string,
    updateDto: UpdateAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);

    Object.assign(alarm, updateDto);
    return await this.alarmRepository.save(alarm);
  }

  /**
   * Delete alarm
   */
  async remove(id: string, userId: string): Promise<void> {
    const alarm = await this.findOne(id, userId);
    await this.alarmRepository.softRemove(alarm);
  }

  /**
   * Acknowledge alarm
   */
  async acknowledge(
    id: string,
    userId: string,
    acknowledgeDto?: AcknowledgeAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);

    if (alarm.status !== AlarmStatus.ACTIVE) {
      throw new BadRequestException('Only active alarms can be acknowledged');
    }

    alarm.acknowledge(userId);

    if (acknowledgeDto?.note) {
      alarm.metadata = {
        ...alarm.metadata,
        acknowledgeNote: acknowledgeDto.note,
      };
    }

    const saved = await this.alarmRepository.save(alarm);

    // Emit event
    this.eventEmitter.emit('alarm.acknowledged', { alarm: saved, userId });

    return saved;
  }

  /**
   * Clear alarm
   */
  async clear(id: string, userId: string): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);

    if (
      alarm.status !== AlarmStatus.ACTIVE &&
      alarm.status !== AlarmStatus.ACKNOWLEDGED
    ) {
      throw new BadRequestException(
        'Only active or acknowledged alarms can be cleared',
      );
    }

    alarm.clear();
    const saved = await this.alarmRepository.save(alarm);

    // Emit event
    this.eventEmitter.emit('alarm.cleared', { alarm: saved });

    return saved;
  }

  /**
   * Resolve alarm
   */
  async resolve(
    id: string,
    userId: string,
    resolveDto: ResolveAlarmDto,
  ): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);

    alarm.resolve(userId, resolveDto.note);
    const saved = await this.alarmRepository.save(alarm);

    // Emit event
    this.eventEmitter.emit('alarm.resolved', { alarm: saved, userId });

    return saved;
  }

  /**
   * Enable alarm
   */
  async enable(id: string, userId: string): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);
    alarm.isEnabled = true;
    return await this.alarmRepository.save(alarm);
  }

  /**
   * Disable alarm
   */
  async disable(id: string, userId: string): Promise<Alarm> {
    const alarm = await this.findOne(id, userId);
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
    value: number,
  ): Promise<void> {
    // Get all enabled alarms for this device and telemetry key
    const alarms = await this.alarmRepository.find({
      where: {
        deviceId,
        isEnabled: true,
      },
    });

    for (const alarm of alarms) {
      // Check if this alarm monitors this telemetry key
      if (alarm.rule.telemetryKey !== telemetryKey) {
        continue;
      }

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
  private async triggerAlarm(alarm: Alarm, value: number): Promise<void> {
    const wasAlreadyActive = alarm.status === AlarmStatus.ACTIVE;

    alarm.trigger(value);
    const saved = await this.alarmRepository.save(alarm);

    // Only emit notification event if this is a new trigger
    if (!wasAlreadyActive) {
      this.eventEmitter.emit('alarm.triggered', { alarm: saved });
    }
  }

  /**
   * Evaluate if condition is met
   */
  private evaluateCondition(rule: any, value: number): boolean {
    switch (rule.condition) {
      case AlarmCondition.GREATER_THAN:
        return value > rule.value;

      case AlarmCondition.LESS_THAN:
        return value < rule.value;

      case AlarmCondition.EQUAL:
        return value === rule.value;

      case AlarmCondition.NOT_EQUAL:
        return value !== rule.value;

      case AlarmCondition.GREATER_THAN_OR_EQUAL:
        return value >= rule.value;

      case AlarmCondition.LESS_THAN_OR_EQUAL:
        return value <= rule.value;

      case AlarmCondition.BETWEEN:
        return value >= rule.value && value <= rule.value2;

      case AlarmCondition.OUTSIDE:
        return value < rule.value || value > rule.value2;

      default:
        return false;
    }
  }

  /**
   * Get active alarms
   */
  async getActive(userId: string): Promise<Alarm[]> {
    return await this.alarmRepository.find({
      where: { userId, status: AlarmStatus.ACTIVE },
      relations: ['device'],
      order: {
        severity: 'ASC', // Critical first
        triggeredAt: 'DESC',
      },
    });
  }

  /**
   * Get alarm statistics
   */
  async getStatistics(userId: string) {
    const total = await this.alarmRepository.count({ where: { userId } });

    const active = await this.alarmRepository.count({
      where: { userId, status: AlarmStatus.ACTIVE },
    });

    const acknowledged = await this.alarmRepository.count({
      where: { userId, status: AlarmStatus.ACKNOWLEDGED },
    });

    const cleared = await this.alarmRepository.count({
      where: { userId, status: AlarmStatus.CLEARED },
    });

    const resolved = await this.alarmRepository.count({
      where: { userId, status: AlarmStatus.RESOLVED },
    });

    // Count by severity
    const critical = await this.alarmRepository.count({
      where: {
        userId,
        severity: AlarmSeverity.CRITICAL,
        status: AlarmStatus.ACTIVE,
      },
    });

    const error = await this.alarmRepository.count({
      where: {
        userId,
        severity: AlarmSeverity.ERROR,
        status: AlarmStatus.ACTIVE,
      },
    });

    const warning = await this.alarmRepository.count({
      where: {
        userId,
        severity: AlarmSeverity.WARNING,
        status: AlarmStatus.ACTIVE,
      },
    });

    // Get most triggered alarms
    const mostTriggered = await this.alarmRepository.find({
      where: { userId },
      order: { triggerCount: 'DESC' },
      take: 5,
    });

    // Get recent alarms
    const recent = await this.alarmRepository.find({
      where: { userId },
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
      },
      mostTriggered,
      recent,
    };
  }

  /**
   * Get alarm history for a device
   */
  async getDeviceHistory(
    userId: string,
    deviceId: string,
    days: number = 7,
  ): Promise<Alarm[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await this.alarmRepository.find({
      where: {
        userId,
        deviceId,
        triggeredAt: Between(startDate, new Date()),
      },
      order: { triggeredAt: 'DESC' },
    });
  }

  /**
   * Bulk acknowledge alarms
   */
  async bulkAcknowledge(
    userId: string,
    alarmIds: string[],
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of alarmIds) {
      try {
        await this.acknowledge(id, userId);
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
    userId: string,
    alarmIds: string[],
    note: string,
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const id of alarmIds) {
      try {
        await this.resolve(id, userId, { note });
        success++;
      } catch (error) {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Test alarm rule (simulate trigger)
   */
  async testAlarm(id: string, userId: string, testValue: number): Promise<any> {
    const alarm = await this.findOne(id, userId);

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
