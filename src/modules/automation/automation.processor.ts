// src/modules/automations/automation.processor.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Automation, Telemetry, Device } from '@modules/index.entities';
import { AutomationStatus, ActionType } from '@common/enums/index.enum';
import { AutomationService } from './automation.service';
import axios from 'axios';

@Injectable()
export class AutomationProcessor {
  private readonly logger = new Logger(AutomationProcessor.name);

  constructor(
    @InjectRepository(Automation)
    private automationRepo: Repository<Automation>,
    @InjectRepository(Device)
    private deviceRepo: Repository<Device>,
    private automationService: AutomationService,
    // TODO: Inject DeviceCommandService when you create it
    // @Inject('DEVICE_COMMAND_SERVICE')
    // private deviceCommandService: DeviceCommandService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // PROCESS TELEMETRY (Called when device sends data)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Called by TelemetryConsumer when new telemetry arrives
   */
  async processTelemetry(telemetry: Telemetry): Promise<void> {
    this.logger.debug(`Processing telemetry for device: ${telemetry.deviceId}`);

    // Find all active automations watching this device
    const automations = await this.automationService.findActiveByDevice(telemetry.deviceId);

    if (automations.length === 0) {
      this.logger.debug(`No automations found for device: ${telemetry.deviceId}`);
      return;
    }

    this.logger.log(`Found ${automations.length} automations for device: ${telemetry.deviceId}`);

    // Check each automation
    for (const automation of automations) {
      try {
        // Skip if automation can't execute right now
        if (!automation.canExecute()) {
          this.logger.debug(`Automation ${automation.id} cannot execute (cooldown/schedule)`);
          continue;
        }

        // Evaluate trigger
        const isTriggered = this.evaluateTrigger(automation.trigger, telemetry);

        if (isTriggered) {
          this.logger.log(`Automation triggered: ${automation.name} (${automation.id})`);
          await this.executeAction(automation);
        }
      } catch (error: any) {
        this.logger.error(`Error processing automation ${automation.id}:`, error.message);
        automation.recordError(error.message);
        await this.automationRepo.save(automation);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVALUATE TRIGGER (Check if condition is met)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Check if trigger condition matches telemetry data
   */
  private evaluateTrigger(trigger: any, telemetry: Telemetry): boolean {
    // Get value from telemetry
    let value: any;
    
    if (trigger.telemetryKey) {
      // Check telemetry data (temperature, humidity, etc.)
      value = telemetry.data[trigger.telemetryKey];
      
      // Also check denormalized fields
      if (value === undefined) {
        value = telemetry[trigger.telemetryKey];
      }
    }

    if (value === undefined) {
      this.logger.debug(`Telemetry key "${trigger.telemetryKey}" not found in data`);
      return false;
    }

    // Evaluate operator
    switch (trigger.operator) {
      case 'eq':
        return value === trigger.value;
      
      case 'ne':
        return value !== trigger.value;
      
      case 'gt':
        return value > trigger.value;
      
      case 'gte':
        return value >= trigger.value;
      
      case 'lt':
        return value < trigger.value;
      
      case 'lte':
        return value <= trigger.value;
      
      case 'between':
        return value >= trigger.value && value <= trigger.value2;
      
      default:
        this.logger.warn(`Unknown operator: ${trigger.operator}`);
        return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EXECUTE ACTION (Do the thing!)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Execute automation action
   */
  async executeAction(automation: Automation): Promise<void> {
    const { action } = automation;

    try {
      switch (action.type) {
        case ActionType.CONTROL:
        case ActionType.SET_VALUE:
          await this.executeDeviceCommand(action);
          break;

        case ActionType.NOTIFICATION:
          await this.executeNotification(action);
          break;

        case ActionType.WEBHOOK:
          await this.executeWebhook(action);
          break;

        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }

      // Record successful execution
      automation.recordExecution();
      await this.automationRepo.save(automation);

      this.logger.log(`✅ Action executed: ${action.type} for automation ${automation.id}`);
    } catch (error: any) {
      this.logger.error(`❌ Action failed: ${error.message}`);
      automation.recordError(error.message);
      await this.automationRepo.save(automation);
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION EXECUTORS
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send command to device (e.g., turn on motor)
   */
  private async executeDeviceCommand(action: any): Promise<void> {
    const { deviceId, command, value } = action;

    if (!deviceId) {
      throw new Error('Device ID is required for CONTROL action');
    }

    // Get device
    const device = await this.deviceRepo.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    this.logger.log(`Sending command to device ${deviceId}: ${command} = ${value}`);

    // TODO: Replace with actual DeviceCommandService call
    // await this.deviceCommandService.sendCommand(deviceId, command, value);

    // For now, publish to MQTT
    await this.publishMQTTCommand(device, command, value);
  }

  /**
   * Publish command to MQTT (temporary solution)
   */
  private async publishMQTTCommand(device: Device, command: string, value: any): Promise<void> {
    // TODO: Inject MQTTService and publish
    // const topic = `devices/${device.deviceKey}/commands/${command}`;
    // await this.mqttService.publish(topic, JSON.stringify({ value }));
    
    this.logger.log(`[MOCK] Would publish to MQTT: devices/${device.deviceKey}/commands/${command}`);
    this.logger.log(`[MOCK] Payload: ${JSON.stringify({ value })}`);
  }

  /**
   * Send notification to users
   */
  private async executeNotification(action: any): Promise<void> {
    const { message, recipients } = action;

    if (!recipients || recipients.length === 0) {
      throw new Error('Recipients are required for NOTIFICATION action');
    }

    this.logger.log(`Sending notification to ${recipients.length} recipients`);

    // TODO: Inject NotificationService
    // await this.notificationService.send({
    //   recipients,
    //   message,
    //   type: 'automation',
    // });

    this.logger.log(`[MOCK] Would send notification: "${message}"`);
    this.logger.log(`[MOCK] Recipients: ${recipients.join(', ')}`);
  }

  /**
   * Call external webhook
   */
  private async executeWebhook(action: any): Promise<void> {
    const { webhookUrl, webhookMethod = 'POST', webhookHeaders, webhookBody } = action;

    if (!webhookUrl) {
      throw new Error('Webhook URL is required for WEBHOOK action');
    }

    this.logger.log(`Calling webhook: ${webhookMethod} ${webhookUrl}`);

    const response = await axios({
      method: webhookMethod,
      url: webhookUrl,
      headers: webhookHeaders,
      data: webhookBody,
      timeout: 10000, // 10 seconds
    });

    if (response.status >= 400) {
      throw new Error(`Webhook failed with status ${response.status}`);
    }

    this.logger.log(`✅ Webhook successful: ${response.status}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCHEDULED AUTOMATIONS (Cron-based)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Process scheduled automations (called by cron job)
   * Add @Cron decorator in automation.module.ts
   */
  async processScheduledAutomations(): Promise<void> {
    this.logger.log('Processing scheduled automations...');

    // Find automations with schedule triggers
    const automations = await this.automationRepo
      .createQueryBuilder('a')
      .where("a.trigger->>'type' = :type", { type: 'schedule' })
      .andWhere('a.enabled = :enabled', { enabled: true })
      .andWhere('a.status != :error', { error: AutomationStatus.ERROR })
      .getMany();

    this.logger.log(`Found ${automations.length} scheduled automations`);

    for (const automation of automations) {
      try {
        if (automation.canExecute()) {
          await this.executeAction(automation);
        }
      } catch (error: any) {
        this.logger.error(`Error executing scheduled automation ${automation.id}:`, error.message);
      }
    }
  }
}