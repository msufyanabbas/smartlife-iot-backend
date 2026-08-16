// src/modules/alarms/alarms.consumer.ts
//
// Bull worker for the 'alarms' queue.
//
// Replaces the previous hand-rolled Kafka consumer, which was never registered
// anywhere and could not have run: it had no @Injectable(), took a raw pg.Pool
// (no DI token), queried tables that do not exist (`alarm`, `alarm_history`),
// and gated escalation on a severity value ('MAJOR') that is not in the
// AlarmSeverity enum. Escalation timing is now Redis-backed via Bull, so it
// survives a restart — the old setTimeout() did not.

import { Processor, Process } from '@nestjs/bull';
// `import type`: with isolatedModules + emitDecoratorMetadata, a value import
// used in a decorated signature makes SWC emit a runtime reference for
// design:paramtypes. The DI token comes from @Process/@InjectQueue anyway.
import type { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Alarm, User } from '@modules/index.entities';
import {
  AlarmStatus,
  AlarmSeverity,
  NotificationChannel,
  NotificationType,
  NotificationPriority,
} from '@common/enums/index.enum';
import { NotificationsService } from '../notifications/notifications.service';
import {
  EscalationRule,
  resolveEscalationRules,
  resolveChannel,
  matchesRole,
} from './alarm-escalation.policy';

export interface AlarmJobData {
  alarmId: string;
  tenantId: string;
}

@Injectable()
@Processor('alarms')
export class AlarmConsumer {
  private readonly logger = new Logger(AlarmConsumer.name);

  constructor(
    @InjectRepository(Alarm)
    private readonly alarmRepository: Repository<Alarm>,
    // Read-only: resolves escalation recipients by role within the tenant.
    // Registered as a repository rather than by importing UsersModule, which
    // would pull DevicesModule back in through its forwardRef chain — the same
    // reasoning as the existing User registration in AlarmsModule.
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // JOB: new-alarm
  // ══════════════════════════════════════════════════════════════════════════

  @Process('new-alarm')
  async handleNewAlarm(job: Job<AlarmJobData>): Promise<void> {
    const { alarmId, tenantId } = job.data;

    try {
      const alarm = await this.alarmRepository.findOne({
        where: { id: alarmId, tenantId },
      });
      if (!alarm) {
        this.logger.warn(`Alarm ${alarmId} not found for new-alarm job`);
        return;
      }

      // Only the two loud severities get an unsolicited notification; warning
      // and info are visible in the UI and over the websocket already.
      if (
        alarm.severity !== AlarmSeverity.CRITICAL &&
        alarm.severity !== AlarmSeverity.ERROR
      ) {
        return;
      }

      const recipients = await this.resolveRecipients(tenantId, ['TENANT_ADMIN'], alarm);

      await this.dispatch(alarm, recipients, [NotificationChannel.IN_APP], {
        title: `🚨 ${alarm.severity.toUpperCase()} Alarm: ${alarm.name}`,
        message:
          alarm.message ??
          `A ${alarm.severity} alarm has been triggered${alarm.deviceId ? ' for a device' : ''}.`,
        priority:
          alarm.severity === AlarmSeverity.CRITICAL
            ? NotificationPriority.URGENT
            : NotificationPriority.HIGH,
        metadata: {
          alarmId: alarm.id,
          alarmName: alarm.name,
          severity: alarm.severity,
          deviceId: alarm.deviceId,
        },
      });

      this.logger.log(`Processed new alarm: ${alarm.name} (${alarm.severity})`);
    } catch (err) {
      this.logger.error(
        `Failed to process new alarm ${alarmId}: ${(err as Error).message}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // JOB: check-escalation
  // ══════════════════════════════════════════════════════════════════════════

  @Process('check-escalation')
  async handleEscalationCheck(job: Job<AlarmJobData>): Promise<void> {
    const { alarmId, tenantId } = job.data;

    try {
      const alarm = await this.alarmRepository.findOne({
        where: { id: alarmId, tenantId },
      });
      if (!alarm) {
        this.logger.warn(`Alarm ${alarmId} not found for escalation check`);
        return;
      }

      // ── Stop conditions ──────────────────────────────────────────────────
      // Checked against the STORED AlarmStatus enum (active/inactive/
      // acknowledged/cleared/resolved), NOT the derived tbStatus strings
      // ('ACTIVE_ACK', 'CLEARED_UNACK', …). tbStatus is computed in @AfterLoad
      // and is not a column; comparing alarm.status to it never matches, which
      // would have escalated every acknowledged alarm.
      if (alarm.status !== AlarmStatus.ACTIVE) {
        this.logger.debug(
          `Alarm ${alarmId} is ${alarm.status}, skipping escalation`,
        );
        return;
      }

      // Belt and braces: an alarm can carry acknowledgedAt while still ACTIVE
      // in the CLEARED_UNACK → CLEARED_ACK style transitions the entity allows.
      if (alarm.acknowledgedAt) {
        this.logger.debug(`Alarm ${alarmId} already acknowledged, skipping`);
        return;
      }

      if (!alarm.isEnabled) return;

      // triggeredAt is nullable, and a rule that has never fired has none.
      // new Date(null).getTime() is NaN, and every comparison against NaN is
      // false, so this would silently never escalate rather than error.
      if (!alarm.triggeredAt) {
        this.logger.debug(`Alarm ${alarmId} has never triggered, skipping`);
        return;
      }

      const rules = resolveEscalationRules(alarm);
      if (rules.length === 0) return;

      const minutesSinceTriggered =
        (Date.now() - new Date(alarm.triggeredAt).getTime()) / 60_000;

      // Highest rung whose time has come and that we have not already served.
      // Iterating descending means a worker that was down through several rungs
      // jumps straight to the current one instead of replaying the whole ladder.
      const due = [...rules]
        .sort((a, b) => b.level - a.level)
        .find(
          (r) =>
            minutesSinceTriggered >= r.afterMinutes &&
            alarm.escalationLevel < r.level,
        );

      if (!due) return;

      await this.escalateAlarm(alarm, due);
    } catch (err) {
      this.logger.error(
        `Escalation check failed for alarm ${alarmId}: ${(err as Error).message}`,
      );
      throw err; // let Bull apply the configured retry/backoff
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ESCALATION
  // ══════════════════════════════════════════════════════════════════════════

  private async escalateAlarm(alarm: Alarm, rule: EscalationRule): Promise<void> {
    this.logger.log(`Escalating alarm ${alarm.name} to level ${rule.level}`);

    const message =
      rule.message ??
      `⚠️ ESCALATION Level ${rule.level}: Alarm "${alarm.name}" has been ` +
        `unacknowledged for ${rule.afterMinutes} minutes. ` +
        `Severity: ${alarm.severity.toUpperCase()}`;

    // ── Claim the level before dispatching ────────────────────────────────
    // A conditional UPDATE on escalationLevel is the concurrency guard: with
    // more than one worker (or a Bull retry racing the original) two jobs can
    // read the same alarm and both decide level N is due. Only the one whose
    // UPDATE matches a row proceeds, so recipients are never double-notified.
    const claim = await this.alarmRepository
      .createQueryBuilder()
      .update(Alarm)
      .set({ escalationLevel: rule.level, escalatedAt: () => 'NOW()' })
      .where('id = :id', { id: alarm.id })
      .andWhere('"escalationLevel" < :level', { level: rule.level })
      .andWhere('status = :status', { status: AlarmStatus.ACTIVE })
      .andWhere('"acknowledgedAt" IS NULL')
      .execute();

    if (!claim.affected) {
      this.logger.debug(
        `Alarm ${alarm.id} level ${rule.level} already claimed or no longer eligible`,
      );
      return;
    }

    const channels = rule.channels
      .map((c) => {
        const resolved = resolveChannel(c);
        if (!resolved) {
          this.logger.warn(`Unknown escalation channel "${c}" on alarm ${alarm.id}`);
        }
        return resolved;
      })
      .filter((c): c is NotificationChannel => c !== null);

    const recipients = await this.resolveRecipients(
      alarm.tenantId,
      rule.notifyRoles,
      alarm,
    );

    if (recipients.length === 0) {
      this.logger.warn(
        `No recipients matched roles [${rule.notifyRoles.join(',')}] for alarm ${alarm.id}`,
      );
    }

    const sent = await this.dispatch(alarm, recipients, channels, {
      title: `Alarm Escalation L${rule.level}: ${alarm.name}`,
      message,
      priority: NotificationPriority.URGENT,
      metadata: {
        alarmId: alarm.id,
        escalationLevel: rule.level,
        severity: alarm.severity,
        deviceId: alarm.deviceId,
        minutesUnacknowledged: rule.afterMinutes,
      },
    });

    // History is appended after dispatch so it records what was actually sent
    // rather than what was intended. Re-read to avoid clobbering the claim.
    const fresh = await this.alarmRepository.findOne({ where: { id: alarm.id } });
    if (fresh) {
      fresh.escalationHistory = [
        ...(fresh.escalationHistory ?? []),
        {
          level: rule.level,
          escalatedAt: new Date().toISOString(),
          channel: channels.join(','),
          recipient: recipients.map((r) => r.email).join(',') || rule.notifyRoles.join(','),
          message,
        },
      ];
      await this.alarmRepository.save(fresh);

      // Drives the websocket broadcast — AlarmsGateway listens for this.
      this.eventEmitter.emit('alarm.escalated', {
        alarm: fresh,
        level: rule.level,
        rule,
      });
    }

    this.logger.log(
      `Alarm ${alarm.name} escalated to level ${rule.level} — ` +
        `${sent} notification(s) via ${channels.join(',') || 'no valid channel'}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Users in the tenant whose role appears in notifyRoles.
   *
   * Falls back to the alarm's explicit recipients.userIds, then to its creator,
   * so an escalation is never silently dropped because a tenant happens to have
   * no user in the configured role.
   */
  private async resolveRecipients(
    tenantId: string,
    notifyRoles: string[],
    alarm: Alarm,
  ): Promise<User[]> {
    const tenantUsers = await this.userRepository.find({ where: { tenantId } });

    const byRole = tenantUsers.filter((u) => matchesRole(u.role, notifyRoles));
    if (byRole.length > 0) return byRole;

    const explicitIds = alarm.recipients?.userIds ?? [];
    const explicit = tenantUsers.filter((u) => explicitIds.includes(u.id));
    if (explicit.length > 0) return explicit;

    const creator = tenantUsers.find((u) => u.id === alarm.createdBy);
    return creator ? [creator] : [];
  }

  /**
   * One notification per (recipient × channel).
   *
   * NotificationsService.create() takes (CreateNotificationDto, user?) and
   * requires a concrete userId plus a SINGULAR `channel` — it has no
   * `tenantId`/`channels[]` input and throws 'User context required' when it
   * cannot resolve a user. tenantId/customerId are derived from the user
   * argument, which is why the User row is passed through rather than an id.
   *
   * Returns the number of notifications successfully created.
   */
  private async dispatch(
    alarm: Alarm,
    recipients: User[],
    channels: NotificationChannel[],
    content: {
      title: string;
      message: string;
      priority: NotificationPriority;
      metadata: Record<string, any>;
    },
  ): Promise<number> {
    let sent = 0;

    for (const recipient of recipients) {
      for (const channel of channels) {
        // Skip channels the recipient has no address for — EmailChannel throws
        // 'Recipient email is required', which would mark the notification
        // FAILED and burn a retry for a permanent condition.
        if (channel === NotificationChannel.EMAIL && !recipient.email) continue;
        if (channel === NotificationChannel.SMS && !recipient.phone) continue;
        if (channel === NotificationChannel.WHATSAPP && !recipient.phone)
          continue;

        try {
          await this.notificationsService.create(
            {
              userId: recipient.id,
              // There is no ALARM_ESCALATION member on NotificationType; the
              // escalation level is carried in metadata instead.
              type: NotificationType.ALARM,
              channel,
              priority: content.priority,
              title: content.title,
              message: content.message,
              relatedEntityType: 'alarm',
              relatedEntityId: alarm.id,
              recipientEmail:
                channel === NotificationChannel.EMAIL ? recipient.email : undefined,
              recipientPhone:
                channel === NotificationChannel.SMS ||
                channel === NotificationChannel.WHATSAPP
                  ? recipient.phone
                  : undefined,
              action: {
                label: 'View Alarm',
                url: `/alarms/${alarm.id}`,
                type: 'button',
              },
              metadata: content.metadata,
            },
            recipient,
          );
          sent++;
        } catch (e) {
          this.logger.error(
            `Failed to send ${channel} notification for alarm ${alarm.id} ` +
              `to ${recipient.id}: ${(e as Error).message}`,
          );
        }
      }
    }

    return sent;
  }
}
