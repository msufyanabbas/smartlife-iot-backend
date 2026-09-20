import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutomationService } from './automation.service';

/**
 * Ticks once a minute and runs every SCHEDULE automation whose cron
 * expression matches. Matching happens per tick rather than by registering a
 * dynamic job per row, so creating, editing, enabling or disabling an
 * automation takes effect on the next minute with nothing to re-register.
 */
@Injectable()
export class AutomationScheduler {
  private readonly logger = new Logger(AutomationScheduler.name);

  constructor(private readonly automationService: AutomationService) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'automation-schedule-tick' })
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
