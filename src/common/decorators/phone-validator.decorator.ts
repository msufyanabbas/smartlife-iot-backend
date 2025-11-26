import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { parsePhoneNumber } from 'libphonenumber-js';

export function IsValidPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidPhone',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          if (!value) return true; // Allow empty if optional

          try {
            const phoneNumber = parsePhoneNumber(value);
            return phoneNumber ? phoneNumber.isValid() : false;
          } catch {
            return false;
          }
        },
        defaultMessage() {
          return 'Phone number must be in international format (e.g., +971501234567, +966501234567)';
        },
      },
    });
  };
}
