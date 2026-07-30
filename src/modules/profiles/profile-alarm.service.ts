// src/modules/profiles/profile-alarm.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Alarm, Device } from '@modules/index.entities';
import {
  AlarmCondition,
  AlarmConditionSpecType,
  AlarmPredicateOperation,
  AlarmSeverity,
  AlarmStatus,
} from '@common/enums/index.enum';
import type {
  AlarmConditionFilter,
  AlarmRule,
  DeviceProfileAlarmRule,
} from '@common/interfaces/index.interface';

/**
 * Evaluates the alarm rule templates declared on a DeviceProfile.
 *
 * Where AlarmsService handles per-device alarms (one Alarm row configured by
 * hand, matched on `rule.telemetryKey`), this service handles alarms declared
 * once on the *profile* and applied to every device using it.
 *
 * Lifecycle of a profile alarm:
 *   1. Device is created with a deviceProfileId → materialiseProfileAlarms()
 *      writes one INACTIVE Alarm row per enabled rule, so the device's alarm
 *      list shows what is being watched before anything fires.
 *   2. Telemetry arrives → evaluateProfileAlarmRules() tests each rule.
 *      A match triggers the row (status ACTIVE, triggerCount++).
 *   3. A matching `clearRule` returns the row to CLEARED.
 *
 * Rows are keyed on (deviceId, name) so a rule never produces duplicates.
 */
@Injectable()
export class ProfileAlarmService {
  private readonly logger = new Logger(ProfileAlarmService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY POINTS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate every enabled alarm rule on the device's profile against a
   * telemetry payload. Called from TelemetryConsumer after persistence.
   *
   * Never throws — a bad rule must not stop telemetry ingestion.
   */
  async evaluateProfileAlarmRules(
    deviceId: string,
    rawTelemetry: Record<string, any>,
  ): Promise<void> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
      relations: ['deviceProfile'],
    });

    const rules = device?.deviceProfile?.alarmRules;
    if (!device || !rules?.length) return;

    const telemetry = this.normaliseTelemetry(rawTelemetry);

    for (const rule of rules) {
      if (!rule?.enabled) continue;

      try {
        const filters = rule.condition?.condition ?? [];
        if (filters.length === 0) continue;

        if (this.matches(filters, telemetry)) {
          await this.triggerProfileAlarm(device, rule, telemetry);
          continue;
        }

        // Only an explicit clearRule clears a profile alarm. Absent one, the
        // alarm stays active until a user acknowledges/resolves it.
        const clearFilters = rule.clearRule?.condition ?? [];
        if (clearFilters.length > 0 && this.matches(clearFilters, telemetry)) {
          await this.clearProfileAlarm(device, rule);
        }
      } catch (err) {
        this.logger.error(
          `Alarm rule "${rule.alarmType}" (${rule.id}) failed for device ${deviceId}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  /**
   * Create the dormant Alarm rows for a device that has just been linked to a
   * profile carrying alarm rules. Idempotent — existing rows are left alone.
   *
   * Returns the number of rows created.
   */
  async materialiseProfileAlarms(device: Device): Promise<number> {
    const rules = device.deviceProfile?.alarmRules;
    if (!rules?.length) return 0;

    let created = 0;

    for (const rule of rules) {
      if (!rule?.enabled) continue;

      const existing = await this.findProfileAlarm(device.id, rule);
      if (existing) continue;

      await this.alarmRepository.save(
        this.buildAlarm(device, rule, AlarmStatus.INACTIVE),
      );
      created++;
    }

    if (created > 0) {
      this.logger.log(
        `Materialised ${created} profile alarm(s) for device ${device.deviceKey}`,
      );
    }

    return created;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: CONDITION EVALUATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Flatten a telemetry payload into the key space alarm rules are written in.
   *
   * Rules name a bare key ("temperature"), but payloads reach the consumer in
   * the ThingsBoard envelope `{ ts, values: { temperature: 45 } }` — and codec
   * output can nest further. This produces every addressable form:
   *
   *   { ts: …, temperature: 45, humidity: 50,
   *     'values.temperature': 45, 'values.humidity': 50 }
   *
   * Envelope-hoisted keys are written first so a genuine top-level key of the
   * same name wins over the `values` copy.
   */
  private normaliseTelemetry(data: Record<string, any>): Record<string, any> {
    if (!data || typeof data !== 'object') return {};

    const out: Record<string, any> = {};

    // 1. Hoist the `values` envelope, if present.
    const values = (data as any).values;
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      Object.assign(out, this.flatten(values));
    }

    // 2. Overlay the payload itself (dotted paths included).
    Object.assign(out, this.flatten(data));

    return out;
  }

  /** Depth-first flatten producing dotted paths for nested objects. */
  private flatten(
    obj: Record<string, any>,
    prefix = '',
  ): Record<string, any> {
    const out: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(out, this.flatten(value, path));
      } else {
        out[path] = value;
      }
    }

    return out;
  }

  /** ALL filters must match (AND semantics), mirroring ThingsBoard. */
  private matches(
    filters: AlarmConditionFilter[],
    telemetry: Record<string, any>,
  ): boolean {
    return filters.every((filter) => {
      const value = telemetry?.[filter.key];
      if (value === undefined || value === null) return false;
      return this.evaluatePredicate(filter, value);
    });
  }

  private evaluatePredicate(
    filter: AlarmConditionFilter,
    value: any,
  ): boolean {
    const predicate = filter?.predicate;
    if (!predicate) return false;

    const threshold = predicate.value?.defaultValue;
    if (threshold === undefined || threshold === null) return false;

    // dynamicValue resolves the threshold from another entity's attribute.
    // Not yet supported — treat as non-matching rather than comparing against
    // a stale literal, which would fire alarms on the wrong bound.
    if (predicate.value?.dynamicValue) {
      this.logger.warn(
        `Alarm filter on "${filter.key}" uses dynamicValue, which is not yet ` +
          `supported — rule skipped.`,
      );
      return false;
    }

    switch (predicate.operation) {
      case AlarmPredicateOperation.GREATER:
        return Number(value) > Number(threshold);
      case AlarmPredicateOperation.LESS:
        return Number(value) < Number(threshold);
      case AlarmPredicateOperation.EQUAL:
        return String(value) === String(threshold);
      case AlarmPredicateOperation.NOT_EQUAL:
        return String(value) !== String(threshold);
      case AlarmPredicateOperation.GREATER_OR_EQUAL:
        return Number(value) >= Number(threshold);
      case AlarmPredicateOperation.LESS_OR_EQUAL:
        return Number(value) <= Number(threshold);
      case AlarmPredicateOperation.BETWEEN: {
        const upper = predicate.value2?.defaultValue ?? threshold;
        return Number(value) >= Number(threshold) && Number(value) <= Number(upper);
      }
      default:
        return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: ALARM LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════

  private async triggerProfileAlarm(
    device: Device,
    rule: DeviceProfileAlarmRule,
    telemetry: Record<string, any>,
  ): Promise<void> {
    // DURATION / REPEATING need trigger-history state this service does not
    // keep yet; they are evaluated as SIMPLE so the alarm still fires rather
    // than being silently dropped.
    const specType = rule.condition?.spec?.type;
    if (specType && specType !== AlarmConditionSpecType.SIMPLE) {
      this.logger.warn(
        `Alarm rule "${rule.alarmType}" uses spec type ${specType}; evaluated ` +
          `as SIMPLE (sustained-condition tracking is not implemented).`,
      );
    }

    // Keyed on rule identity, not status — a dormant row materialised at
    // device creation must be reused, not duplicated.
    let alarm = await this.findProfileAlarm(device.id, rule);

    if (!alarm) {
      alarm = this.buildAlarm(device, rule, AlarmStatus.INACTIVE);
    }

    // Already firing — nothing to announce, but keep the rule definition and
    // the observed value fresh.
    const wasActive = alarm.status === AlarmStatus.ACTIVE;

    alarm.rule = this.toAlarmRule(rule);
    alarm.severity = this.toSeverity(rule.severity);
    alarm.metadata = this.buildMetadata(rule, telemetry);

    const observed = this.firstObservedValue(rule, telemetry);
    alarm.trigger(observed as number, rule.alarmDetails);

    const saved = await this.alarmRepository.save(alarm);

    if (!wasActive) {
      this.eventEmitter.emit('alarm.triggered', { alarm: saved });
      this.logger.log(
        `Profile alarm "${rule.alarmType}" triggered for device ${device.deviceKey}`,
      );
    }
  }

  private async clearProfileAlarm(
    device: Device,
    rule: DeviceProfileAlarmRule,
  ): Promise<void> {
    const alarm = await this.findProfileAlarm(device.id, rule);

    if (!alarm || alarm.status !== AlarmStatus.ACTIVE) return;

    alarm.clear();
    const saved = await this.alarmRepository.save(alarm);

    this.eventEmitter.emit('alarm.cleared', { alarm: saved });
    this.logger.log(
      `Profile alarm "${rule.alarmType}" cleared for device ${device.deviceKey}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIVATE: MAPPING PROFILE RULE → ALARM ENTITY
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Locate the Alarm row belonging to a specific profile rule.
   *
   * Matched on `metadata.profileRuleId`, NOT on name: other producers (the
   * rule engine's action node, hand-created alarms) can and do create rows
   * with the same `name` on the same device, and matching by name would let
   * this service hijack or duplicate them.
   */
  private async findProfileAlarm(
    deviceId: string,
    rule: DeviceProfileAlarmRule,
  ): Promise<Alarm | null> {
    return this.alarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.deviceId = :deviceId', { deviceId })
      .andWhere("alarm.metadata->>'source' = :source", {
        source: 'DEVICE_PROFILE',
      })
      .andWhere("alarm.metadata->>'profileRuleId' = :ruleId", {
        ruleId: rule.id,
      })
      .getOne();
  }

  private buildAlarm(
    device: Device,
    rule: DeviceProfileAlarmRule,
    status: AlarmStatus,
  ): Alarm {
    return this.alarmRepository.create({
      tenantId: device.tenantId,
      // Denormalised from the device so customer-scoped alarm queries work.
      customerId: device.customerId ?? undefined,
      deviceId: device.id,
      name: rule.alarmType,
      description: rule.alarmDetails,
      severity: this.toSeverity(rule.severity),
      status,
      // `rule` is NOT NULL on the alarms table and drives Alarm.generateMessage()
      rule: this.toAlarmRule(rule),
      isEnabled: true,
      // Cleared only by an explicit clearRule — see evaluateProfileAlarmRules.
      autoClear: false,
      triggerCount: 0,
      metadata: this.buildMetadata(rule),
    });
  }

  /**
   * Collapse the profile rule's first filter into the flat AlarmRule shape the
   * alarms table stores. Multi-filter rules keep their full definition in
   * `metadata.profileRule`; the flat copy exists so Alarm.generateMessage()
   * and the existing alarm UI render something meaningful.
   */
  private toAlarmRule(rule: DeviceProfileAlarmRule): AlarmRule {
    const filter = rule.condition?.condition?.[0];
    const predicate = filter?.predicate;

    return {
      telemetryKey: filter?.key ?? 'unknown',
      condition: this.toAlarmCondition(predicate?.operation),
      value: Number(predicate?.value?.defaultValue ?? 0),
      value2:
        predicate?.value2?.defaultValue !== undefined
          ? Number(predicate.value2.defaultValue)
          : undefined,
    };
  }

  private buildMetadata(
    rule: DeviceProfileAlarmRule,
    telemetry?: Record<string, any>,
  ): Record<string, any> {
    return {
      source: 'DEVICE_PROFILE',
      profileRuleId: rule.id,
      // Propagation flags are recorded but not yet acted on — no propagation
      // engine exists. See CLAUDE.md "Known TODOs".
      propagate: rule.propagate ?? false,
      propagateToOwner: rule.propagateToOwner ?? false,
      propagateToTenant: rule.propagateToTenant ?? false,
      dashboardId: rule.dashboardId,
      profileRule: rule.condition,
      ...(telemetry ? { lastTelemetry: telemetry } : {}),
    };
  }

  /** The value that tripped the rule, used as Alarm.currentValue. */
  private firstObservedValue(
    rule: DeviceProfileAlarmRule,
    telemetry: Record<string, any>,
  ): unknown {
    const key = rule.condition?.condition?.[0]?.key;
    return key ? telemetry?.[key] : undefined;
  }

  private toAlarmCondition(
    operation?: AlarmPredicateOperation,
  ): AlarmCondition {
    switch (operation) {
      case AlarmPredicateOperation.GREATER:
        return AlarmCondition.GREATER_THAN;
      case AlarmPredicateOperation.LESS:
        return AlarmCondition.LESS_THAN;
      case AlarmPredicateOperation.NOT_EQUAL:
        return AlarmCondition.NOT_EQUAL;
      case AlarmPredicateOperation.GREATER_OR_EQUAL:
        return AlarmCondition.GREATER_THAN_OR_EQUAL;
      case AlarmPredicateOperation.LESS_OR_EQUAL:
        return AlarmCondition.LESS_THAN_OR_EQUAL;
      case AlarmPredicateOperation.BETWEEN:
        return AlarmCondition.BETWEEN;
      case AlarmPredicateOperation.EQUAL:
      default:
        return AlarmCondition.EQUAL;
    }
  }

  /** Profile rule severities are already the AlarmSeverity vocabulary. */
  private toSeverity(severity?: string): AlarmSeverity {
    const normalised = String(severity ?? '').toLowerCase();
    const match = Object.values(AlarmSeverity).find((s) => s === normalised);
    return (match as AlarmSeverity) ?? AlarmSeverity.WARNING;
  }
}
