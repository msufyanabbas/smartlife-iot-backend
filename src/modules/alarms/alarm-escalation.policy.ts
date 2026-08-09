// src/modules/alarms/alarm-escalation.policy.ts
import { AlarmSeverity, NotificationChannel, UserRole } from '@common/enums/index.enum';

/**
 * One rung of an escalation ladder.
 *
 * `channels` and `notifyRoles` are plain strings rather than enums because the
 * same shape is stored in the Alarm.escalationRules jsonb column, which is
 * caller-supplied and cannot be trusted to hold valid enum members. They are
 * normalised at dispatch time — see resolveChannel()/matchesRole().
 */
export interface EscalationRule {
  level: number;
  /** Escalate once the alarm has been unacknowledged this many minutes. */
  afterMinutes: number;
  channels: string[];
  notifyRoles: string[];
  /** Optional override for the generated escalation message. */
  message?: string;
}

/**
 * Default ladders by severity.
 *
 * SINGLE SOURCE OF TRUTH — both the queue scheduler (AlarmsService, which needs
 * the delays) and the worker (AlarmConsumer, which needs the channels/roles)
 * read from here. Keeping two copies in sync by hand was how the original
 * design drifted; the delays are derived from the rules below rather than
 * written out a second time.
 */
export const DEFAULT_ESCALATION_RULES: Record<AlarmSeverity, EscalationRule[]> = {
  [AlarmSeverity.CRITICAL]: [
    { level: 1, afterMinutes: 5,  channels: ['IN_APP'],            notifyRoles: ['TENANT_ADMIN'] },
    { level: 2, afterMinutes: 15, channels: ['IN_APP', 'EMAIL'],   notifyRoles: ['TENANT_ADMIN'] },
    { level: 3, afterMinutes: 30, channels: ['IN_APP', 'EMAIL'],   notifyRoles: ['TENANT_ADMIN'] },
  ],
  [AlarmSeverity.ERROR]: [
    { level: 1, afterMinutes: 15, channels: ['IN_APP'],            notifyRoles: ['TENANT_ADMIN'] },
    { level: 2, afterMinutes: 60, channels: ['IN_APP', 'EMAIL'],   notifyRoles: ['TENANT_ADMIN'] },
  ],
  [AlarmSeverity.WARNING]: [
    { level: 1, afterMinutes: 60,  channels: ['IN_APP'],           notifyRoles: ['TENANT_ADMIN'] },
    { level: 2, afterMinutes: 240, channels: ['IN_APP', 'EMAIL'],  notifyRoles: ['TENANT_ADMIN'] },
  ],
  [AlarmSeverity.INFO]: [
    { level: 1, afterMinutes: 120, channels: ['IN_APP'],           notifyRoles: ['TENANT_ADMIN'] },
  ],
};

/**
 * The ladder for an alarm: its own override when present and non-empty,
 * otherwise the severity default. An explicitly empty array means "never
 * escalate this alarm" and is respected as-is.
 */
export function resolveEscalationRules(alarm: {
  severity: AlarmSeverity;
  escalationRules?: EscalationRule[] | null;
}): EscalationRule[] {
  if (alarm.escalationRules) return [...alarm.escalationRules].sort((a, b) => a.level - b.level);
  return DEFAULT_ESCALATION_RULES[alarm.severity] ?? DEFAULT_ESCALATION_RULES[AlarmSeverity.INFO];
}

/** The minute offsets at which a check should be queued for this alarm. */
export function escalationDelays(alarm: {
  severity: AlarmSeverity;
  escalationRules?: EscalationRule[] | null;
}): number[] {
  return resolveEscalationRules(alarm).map((r) => r.afterMinutes);
}

/**
 * Map a stored channel string onto the NotificationChannel enum.
 *
 * The jsonb stores UPPERCASE names ('IN_APP') while the enum values are
 * lowercase ('in_app'), so a direct cast would silently produce an invalid
 * channel that falls through NotificationsService's switch to
 * `Unsupported channel`. Returns null for anything unrecognised so the caller
 * can skip and log rather than throw mid-ladder.
 */
export function resolveChannel(raw: string): NotificationChannel | null {
  const key = String(raw).trim().toUpperCase();
  const match = (Object.entries(NotificationChannel) as Array<[string, NotificationChannel]>)
    .find(([name, value]) => name === key || value.toUpperCase() === key);
  return match ? match[1] : null;
}

/**
 * Whether a user's role satisfies one of the rule's notifyRoles.
 * Compared case-insensitively: rules are written 'TENANT_ADMIN' while
 * UserRole.TENANT_ADMIN is 'tenant_admin'.
 */
export function matchesRole(userRole: UserRole | string, notifyRoles: string[]): boolean {
  const role = String(userRole).trim().toUpperCase();
  return notifyRoles.some((r) => String(r).trim().toUpperCase() === role);
}
