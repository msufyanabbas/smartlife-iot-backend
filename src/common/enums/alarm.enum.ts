export enum AlarmSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

export enum AlarmStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ACKNOWLEDGED = 'acknowledged',
  CLEARED = 'cleared',
  RESOLVED = 'resolved',
}

export enum AlarmCondition {
  GREATER_THAN          = 'GREATER_THAN',
  LESS_THAN             = 'LESS_THAN',
  EQUAL                 = 'EQUAL',
  NOT_EQUAL             = 'NOT_EQUAL',
  GREATER_THAN_OR_EQUAL = 'GREATER_THAN_OR_EQUAL',
  LESS_THAN_OR_EQUAL    = 'LESS_THAN_OR_EQUAL',
  BETWEEN               = 'BETWEEN',
  OUTSIDE               = 'OUTSIDE',
  CONTAINS              = 'CONTAINS',      // ← add
  NOT_CONTAINS          = 'NOT_CONTAINS',  // ← add
  EXISTS                = 'EXISTS',        // ← add
}