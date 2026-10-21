import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import { DistributedCron } from '@/lib/cluster/distributed-cron.decorator';
import { AutomationService } from './automation.service';

/**
 * Ticks once a minute and runs every SCHEDULE automation whose cron
 * expression matches. Matching happens per tick rather than by registering a
 * dynamic job per row, so creating, editing, enabling or disabling an
 * automation takes effect on the next minute with nothing to re-register.
 *
 * ── Why this tick is locked ────────────────────────────────────────────────
 * This is the most damaging unlocked cron in the platform. A SCHEDULE
 * automation's actions include `device_command`, so on three replicas a
 * scheduled "open the valve" fired three times, a minute's worth of
 * notifications was sent three times, and `automation_logs` recorded three
 * runs of one logical event. `runDueScheduledAutomations()` has no
 * per-row claim of its own — it selects by cron match, not by a nextRunAt
 * column it then advances — so nothing downstream de-duplicates it either.
 */
@Injectable()
export class AutomationScheduler {
  private readonly logger = new Logger(AutomationScheduler.name);

  constructor(private readonly automationService: AutomationService) {}

  @DistributedCron(CronExpression.EVERY_MINUTE, {
    name: 'automation-schedule-tick',
    // Actions fan out to HTTP calls, MQTT publishes and emails; 120s comfortably
    // covers a normal minute's worth and the holder renews beyond that.
    lockTtl: 120,
  })
  async tick(): Promise<void> {
    try {
      const fired = await this.automationService.runDueScheduledAutomations();
      if (fired > 0) {
        this.logger.log(`Dispatched ${fired} scheduled automation(s)`);
      }
    } catch (err: any) {
      this.logger.error(`Scheduled automation tick failed: ${err.message}`);
    }
  }
}
