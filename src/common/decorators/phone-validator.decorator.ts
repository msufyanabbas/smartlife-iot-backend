import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { parsePhoneNumber } from 'libphonenumber-js';

/**
 * Validator constraint for phone number validation
 */
@ValidatorConstraint({ name: 'isValidPhone', async: false })
export class IsValidPhoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    // Allow empty if optional (handled by @IsOptional())
    if (!value) return true;

    // Must be a string
    if (typeof value !== 'string') return false;

    try {
      const phoneNumber = parsePhoneNumber(value);
      return phoneNumber ? phoneNumber.isValid() : false;
    } catch {
      return false;
    }
  }

  defaultMessage(args: ValidationArguments): string {
    return 'Phone number must be in international format (e.g., +971501234567, +966501234567)';
  }
}

/**
 * Custom validation decorator for phone numbers
 * Validates phone numbers using libphonenumber-js
 * 
 * @param validationOptions - Optional validation options
 * @returns PropertyDecorator
 * 
 * @example
 * class CreateUserDto {
 *   @IsValidPhone()
 *   phoneNumber: string;
 * }
 */
export function IsValidPhone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidPhone',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidPhoneConstraint,
    });
  };
}