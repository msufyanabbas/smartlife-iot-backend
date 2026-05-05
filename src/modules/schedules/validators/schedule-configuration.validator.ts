// src/modules/schedules/validators/schedule-configuration.validator.ts
import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { ScheduleType } from '@common/enums/index.enum';

@ValidatorConstraint({ name: 'ValidateScheduleConfiguration', async: false })
export class ValidateScheduleConfigurationConstraint
  implements ValidatorConstraintInterface
{
  validate(configuration: Record<string, any>, args: ValidationArguments): boolean {
    const object = args.object as any;
    const type: ScheduleType = object.type;

    if (!configuration || typeof configuration !== 'object') return false;

    switch (type) {
      case ScheduleType.REPORT:
        return (
          Array.isArray(configuration.recipients) &&
          configuration.recipients.length > 0 &&
          typeof configuration.reportType === 'string' &&
          configuration.reportType.length > 0
        );

      case ScheduleType.BACKUP:
        // retention (days) is recommended but not strictly required
        return true;

      case ScheduleType.CLEANUP:
        return true;

      case ScheduleType.EXPORT:
        return (
          typeof configuration.format === 'string' &&
          configuration.format.length > 0
        );

      case ScheduleType.DEVICE_COMMAND:
        return (
          typeof configuration.deviceId === 'string' &&
          configuration.deviceId.length > 0 &&
          typeof configuration.command === 'string' &&
          configuration.command.length > 0
        );

      default:
        return true;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    const object = args.object as any;
    const type: ScheduleType = object.type;

    const messages: Record<ScheduleType, string> = {
      [ScheduleType.REPORT]:
        'REPORT configuration must include non-empty "reportType" (string) and "recipients" (array)',
      [ScheduleType.BACKUP]:
        'BACKUP configuration is invalid',
      [ScheduleType.CLEANUP]:
        'CLEANUP configuration is invalid',
      [ScheduleType.EXPORT]:
        'EXPORT configuration must include non-empty "format" (string)',
      [ScheduleType.DEVICE_COMMAND]:
        'DEVICE_COMMAND configuration must include non-empty "deviceId" and "command" (strings)',
    };

    return messages[type] ?? 'Invalid schedule configuration for the given type';
  }
}

export function ValidateScheduleConfiguration(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ValidateScheduleConfigurationConstraint,
    });
  };
}