// src/common/enums/email.enum.ts 
export enum EmailTemplateType {
  VERIFICATION = 'verification',
  WELCOME = 'welcome',
  PASSWORD_RESET = 'password_reset',
  PASSWORD_CHANGED = 'password_changed',
  ACCOUNT_LOCKED = 'account_locked',
  TWO_FACTOR_CODE = 'two_factor_code',
  ALERT_NOTIFICATION = 'alert_notification',
  DEVICE_OFFLINE = 'device_offline',
  SUBSCRIPTION_EXPIRING = 'subscription_expiring',
  INVITATION = 'invitation',
  CUSTOM = 'custom',
}