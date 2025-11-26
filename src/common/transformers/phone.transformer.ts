import { parsePhoneNumber } from 'libphonenumber-js';

export function transformPhoneNumber(phone: string): string {
  if (!phone) return phone;

  try {
    const phoneNumber = parsePhoneNumber(phone);
    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.format('E.164'); // Returns format like +971501234567
    }
    return phone;
  } catch {
    return phone;
  }
}
