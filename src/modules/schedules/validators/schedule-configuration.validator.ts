// src/modules/schedules/validators/schedule-configuration.validator.ts
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import {
  AttributeScope,
  NotificationChannel,
  ScheduleActionType,
  ScheduleMaintenanceTask,
  ScheduleReportType,
  ScheduleTargetType,
  ScheduleTriggerType,
} from '@common/enums/index.enum';

// ─────────────────────────────────────────────────────────────────────────────
// Scope normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ThingsBoard spells attribute scopes `SHARED_SCOPE` / `SERVER_SCOPE`; this
 * platform's `AttributeScope` enum uses `shared` / `server`. Both are accepted
 * on input and normalised to the enum before the value reaches the database,
 * because `AttributesService.saveAttributes()` matches on the enum value and a
 * mis-cased scope silently creates a *second* attribute row rather than
 * updating the existing one.
 */
const SCOPE_ALIASES: Record<string, AttributeScope> = {
  SHARED_SCOPE: AttributeScope.SHARED,
  SERVER_SCOPE: AttributeScope.SERVER,
  CLIENT_SCOPE: AttributeScope.CLIENT,
  SHARED: AttributeScope.SHARED,
  SERVER: AttributeScope.SERVER,
  CLIENT: AttributeScope.CLIENT,
};

export function normaliseAttributeScope(value: unknown): AttributeScope | null {
  if (typeof value !== 'string') return null;
  return SCOPE_ALIASES[value.toUpperCase()] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isEnumValue = <T extends object>(e: T, v: unknown): boolean =>
  Object.values(e).includes(v as any);

/**
 * Validates the device-selection half of an action config. Each target type
 * requires a different id, and a missing id would otherwise widen the blast
 * radius: an ASSET target with no `assetId` matches every device whose
 * `assetId` is undefined.
 */
function validateTarget(cfg: Record<string, any>): string | null {
  if (!isEnumValue(ScheduleTargetType, cfg.targetType)) {
    return `targetType must be one of: ${Object.values(ScheduleTargetType).join(', ')}`;
  }
  switch (cfg.targetType) {
    case ScheduleTargetType.DEVICE:
      return isNonEmptyString(cfg.deviceId)
        ? null
        : 'targetType DEVICE requires a non-empty "deviceId"';
    case ScheduleTargetType.DEVICE_TYPE:
      return isNonEmptyString(cfg.deviceType)
        ? null
        : 'targetType DEVICE_TYPE requires a non-empty "deviceType"';
    case ScheduleTargetType.ASSET:
      return isNonEmptyString(cfg.assetId)
        ? null
        : 'targetType ASSET requires a non-empty "assetId"';
    default:
      return null; // ALL needs no id
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// actionConfig ↔ actionType
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns null when valid, otherwise the reason. Exported so
 * `ScheduleExecutorService` can re-check at execution time — `actionType` may
 * be changed by a PATCH that leaves a now-mismatched `actionConfig` in place.
 */
export function validateActionConfig(
  actionType: ScheduleActionType,
  config: Record<string, any> | undefined | null,
): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'actionConfig must be an object';
  }

  switch (actionType) {
    case ScheduleActionType.DEVICE_COMMAND: {
      const cfg = config.deviceCommand;
      if (!cfg)
        return 'actionConfig.deviceCommand is required for DEVICE_COMMAND';
      const targetError = validateTarget(cfg);
      if (targetError) return `actionConfig.deviceCommand: ${targetError}`;
      if (!cfg.command || typeof cfg.command !== 'object') {
        return 'actionConfig.deviceCommand.command must be an object';
      }
      if (!isNonEmptyString(cfg.command.method)) {
        return 'actionConfig.deviceCommand.command.method must be a non-empty string';
      }
      if (
        cfg.command.params !== undefined &&
        typeof cfg.command.params !== 'object'
      ) {
        return 'actionConfig.deviceCommand.command.params must be an object';
      }
      if (
        cfg.timeout !== undefined &&
        (!Number.isFinite(cfg.timeout) || cfg.timeout <= 0)
      ) {
        return 'actionConfig.deviceCommand.timeout must be a positive number of milliseconds';
      }
      return null;
    }

    case ScheduleActionType.ATTRIBUTE_UPDATE: {
      const cfg = config.attributeUpdate;
      if (!cfg)
        return 'actionConfig.attributeUpdate is required for ATTRIBUTE_UPDATE';
      // ALL is deliberately not offered here: writing attributes to every
      // device in a tenant is a far heavier and less reversible action than
      // broadcasting a command, and nothing in the product asks for it.
      if (cfg.targetType === ScheduleTargetType.ALL) {
        return 'actionConfig.attributeUpdate does not support targetType ALL';
      }
      const targetError = validateTarget(cfg);
      if (targetError) return `actionConfig.attributeUpdate: ${targetError}`;
      if (!normaliseAttributeScope(cfg.scope)) {
        return 'actionConfig.attributeUpdate.scope must be one of: SHARED_SCOPE, SERVER_SCOPE, CLIENT_SCOPE (or shared/server/client)';
      }
      if (!Array.isArray(cfg.attributes) || cfg.attributes.length === 0) {
        return 'actionConfig.attributeUpdate.attributes must be a non-empty array';
      }
      for (const attr of cfg.attributes) {
        if (!attr || !isNonEmptyString(attr.key)) {
          return 'every entry in actionConfig.attributeUpdate.attributes needs a non-empty "key"';
        }
        if (attr.value === undefined) {
          return `actionConfig.attributeUpdate.attributes["${attr.key}"] is missing "value"`;
        }
      }
      return null;
    }

    case ScheduleActionType.RULE_CHAIN_TRIGGER: {
      const cfg = config.ruleChainTrigger;
      if (!cfg)
        return 'actionConfig.ruleChainTrigger is required for RULE_CHAIN_TRIGGER';
      if (!isNonEmptyString(cfg.ruleChainId)) {
        return 'actionConfig.ruleChainTrigger.ruleChainId must be a non-empty string';
      }
      if (cfg.payload !== undefined && typeof cfg.payload !== 'object') {
        return 'actionConfig.ruleChainTrigger.payload must be an object';
      }
      return null;
    }

    case ScheduleActionType.SEND_NOTIFICATION: {
      const cfg = config.notification;
      if (!cfg)
        return 'actionConfig.notification is required for SEND_NOTIFICATION';
      const targets = ['TENANT_ADMIN', 'ALL_USERS', 'SPECIFIC_USER'];
      if (!targets.includes(cfg.targetType)) {
        return `actionConfig.notification.targetType must be one of: ${targets.join(', ')}`;
      }
      if (cfg.targetType === 'SPECIFIC_USER' && !isNonEmptyString(cfg.userId)) {
        return 'actionConfig.notification.targetType SPECIFIC_USER requires "userId"';
      }
      if (!isNonEmptyString(cfg.title)) {
        return 'actionConfig.notification.title must be a non-empty string';
      }
      if (!isNonEmptyString(cfg.message)) {
        return 'actionConfig.notification.message must be a non-empty string';
      }
      if (!Array.isArray(cfg.channels) || cfg.channels.length === 0) {
        return 'actionConfig.notification.channels must be a non-empty array';
      }
      const allowed = [
        NotificationChannel.IN_APP,
        NotificationChannel.EMAIL,
        NotificationChannel.PUSH,
      ];
      for (const channel of cfg.channels) {
        if (!allowed.includes(channel)) {
          return `actionConfig.notification.channels: "${channel}" is not one of ${allowed.join(', ')}`;
        }
      }
      return null;
    }

    case ScheduleActionType.DATA_MAINTENANCE: {
      const cfg = config.maintenance;
      if (!cfg)
        return 'actionConfig.maintenance is required for DATA_MAINTENANCE';
      if (!isEnumValue(ScheduleMaintenanceTask, cfg.taskType)) {
        return `actionConfig.maintenance.taskType must be one of: ${Object.values(ScheduleMaintenanceTask).join(', ')}`;
      }
      if (
        cfg.olderThanDays !== undefined &&
        (!Number.isInteger(cfg.olderThanDays) || cfg.olderThanDays < 1)
      ) {
        return 'actionConfig.maintenance.olderThanDays must be an integer >= 1';
      }
      return null;
    }

    case ScheduleActionType.GENERATE_REPORT: {
      const cfg = config.report;
      if (!cfg) return 'actionConfig.report is required for GENERATE_REPORT';
      if (!isEnumValue(ScheduleReportType, cfg.reportType)) {
        return `actionConfig.report.reportType must be one of: ${Object.values(ScheduleReportType).join(', ')}`;
      }
      if (!['24h', '7d', '30d'].includes(cfg.timeRange)) {
        return 'actionConfig.report.timeRange must be one of: 24h, 7d, 30d';
      }
      if (
        !Array.isArray(cfg.deliveryChannels) ||
        cfg.deliveryChannels.length === 0
      ) {
        return 'actionConfig.report.deliveryChannels must be a non-empty array of EMAIL / IN_APP';
      }
      for (const channel of cfg.deliveryChannels) {
        if (!['EMAIL', 'IN_APP'].includes(channel)) {
          return `actionConfig.report.deliveryChannels: "${channel}" is not EMAIL or IN_APP`;
        }
      }
      if (
        cfg.deliveryChannels.includes('EMAIL') &&
        !isNonEmptyString(cfg.recipientEmail)
      ) {
        return 'actionConfig.report.recipientEmail is required when EMAIL is a delivery channel';
      }
      return null;
    }

    default:
      return `Unknown actionType: ${actionType}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// class-validator decorators
// ─────────────────────────────────────────────────────────────────────────────

@ValidatorConstraint({ name: 'ValidateScheduleActionConfig', async: false })
export class ValidateScheduleActionConfigConstraint
  implements ValidatorConstraintInterface
{
  validate(config: Record<string, any>, args: ValidationArguments): boolean {
    const { actionType } = args.object as { actionType: ScheduleActionType };
    // PATCH bodies may set actionConfig without actionType (and vice versa);
    // the service re-validates the merged entity, so a partial payload is not
    // rejected here.
    if (!actionType) return true;
    return validateActionConfig(actionType, config) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const { actionType } = args.object as { actionType: ScheduleActionType };
    return (
      validateActionConfig(actionType, args.value) ??
      'Invalid actionConfig for the given actionType'
    );
  }
}

export function ValidateScheduleActionConfig(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidateScheduleActionConfigConstraint,
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing validation
// ─────────────────────────────────────────────────────────────────────────────

/** Returns null when the timing fields are coherent, otherwise the reason. */
export function validateTiming(schedule: {
  type: ScheduleTriggerType;
  cronExpression?: string | null;
  intervalMs?: number | null;
  startTime?: Date | null;
  endTime?: Date | null;
}): string | null {
  switch (schedule.type) {
    case ScheduleTriggerType.CRON:
      if (!isNonEmptyString(schedule.cronExpression)) {
        return 'type CRON requires a non-empty "cronExpression"';
      }
      break;
    case ScheduleTriggerType.INTERVAL:
      if (!schedule.intervalMs || schedule.intervalMs < 1000) {
        return 'type INTERVAL requires "intervalMs" of at least 1000 (1 second)';
      }
      break;
    case ScheduleTriggerType.ONE_TIME:
      if (!schedule.startTime) {
        return 'type ONE_TIME requires a "startTime"';
      }
      break;
    default:
      return `type must be one of: ${Object.values(ScheduleTriggerType).join(', ')}`;
  }

  if (
    schedule.startTime &&
    schedule.endTime &&
    schedule.endTime <= schedule.startTime
  ) {
    return '"endTime" must be after "startTime"';
  }

  return null;
}

@ValidatorConstraint({ name: 'ValidateScheduleTiming', async: false })
export class ValidateScheduleTimingConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = args.object as any;
    if (!obj.type) return true; // partial update — service re-validates
    return validateTiming(obj) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return (
      validateTiming(args.object as any) ??
      'Invalid schedule timing configuration'
    );
  }
}

export function ValidateScheduleTiming(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidateScheduleTimingConstraint,
    });
  };
}
