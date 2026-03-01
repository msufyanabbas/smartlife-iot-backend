export enum TriggerType {
  THRESHOLD = 'threshold',
  STATE = 'state',
  SCHEDULE = 'schedule',
  EVENT = 'event',
}

export enum ActionType {
  CONTROL = 'control',
  SET_VALUE = 'setValue',
  NOTIFICATION = 'notification',
  WEBHOOK = 'webhook',
}

export enum AutomationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}