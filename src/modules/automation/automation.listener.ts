import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AutomationService } from './automation.service';
import { DeviceStatus } from '@common/enums/index.enum';

/**
 * Bridges the events other modules already emit into the automation engine.
 *
 * Listening here rather than calling AutomationService from AlarmsService /
 * DevicesService keeps those modules unaware of automations and avoids the
 * circular imports that direct injection would create.
 */
@Injectable()
export class AutomationListener {
  private readonly logger = new Logger(AutomationListener.name);

  constructor(private readonly automationService: AutomationService) {}

  // ── Alarm triggers ────────────────────────────────────────────────────────

  /** A rule that just fired. */
  @OnEvent('alarm.triggered', { async: true })
  async onAlarmTriggered(payload: { alarm: any }): Promise<void> {
    await this.dispatchAlarm(payload?.alarm);
  }

  /** A newly defined alarm row (usually INACTIVE until it fires). */
  @OnEvent('alarm.created', { async: true })
  async onAlarmCreated(payload: { alarm: any }): Promise<void> {
    await this.dispatchAlarm(payload?.alarm);
  }

  @OnEvent('alarm.cleared', { async: true })
  async onAlarmCleared(payload: { alarm: any }): Promise<void> {
    await this.dispatchAlarm(payload?.alarm);
  }

  private async dispatchAlarm(alarm: any): Promise<void> {
    if (!alarm?.tenantId) return;
    try {
      await this.automationService.evaluateAlarmTriggers(alarm, alarm.tenantId);
    } catch (err: any) {
      this.logger.error(`Automation alarm trigger failed: ${err.message}`);
    }
  }

  // ── Device status triggers ────────────────────────────────────────────────

  @OnEvent('device.offline', { async: true })
  async onDeviceOffline(payload: { device: any }): Promise<void> {
    await this.dispatchStatus(payload?.device, DeviceStatus.OFFLINE);
  }

  @OnEvent('device.connected', { async: true })
  async onDeviceConnected(payload: { device: any }): Promise<void> {
    // DeviceStatus has no 'online' member - ACTIVE is the reachable state.
    // 'online' is accepted as an alias in the trigger config for readability.
    await this.dispatchStatus(payload?.device, DeviceStatus.ACTIVE);
  }

  private async dispatchStatus(device: any, status: DeviceStatus): Promise<void> {
    if (!device?.id || !device?.tenantId) return;
    try {
      await this.automationService.evaluateDeviceStatusTriggers(
        device.id,
        device.tenantId,
        status,
      );
      // Accept the human-facing spelling too, so a trigger configured with
      // targetStatus: 'online' still matches a device.connected event.
      if (status === DeviceStatus.ACTIVE) {
        await this.automationService.evaluateDeviceStatusTriggers(
          device.id,
          device.tenantId,
          'online',
        );
      }
    } catch (err: any) {
      this.logger.error(`Automation status trigger failed: ${err.message}`);
    }
  }

  // ── Attribute triggers ────────────────────────────────────────────────────

  @OnEvent('attributes.updated', { async: true })
  async onAttributesUpdated(payload: {
    tenantId: string;
    entityType: string;
    entityId: string;
    attributes: Record<string, any>;
  }): Promise<void> {
    if (!payload?.tenantId || !payload?.entityId) return;
    try {
      await this.automationService.evaluateAttributeTriggers(
        payload.entityType,
        payload.entityId,
        payload.tenantId,
        payload.attributes ?? {},
      );
    } catch (err: any) {
      this.logger.error(`Automation attribute trigger failed: ${err.message}`);
    }
  }
}
