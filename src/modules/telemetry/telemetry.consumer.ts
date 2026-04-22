import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Alarm, Device, Telemetry } from '@modules/index.entities';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { AutomationProcessor } from '@modules/automation/automation.processor';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';
import { CodecRegistryService } from '../devices/codecs/codec-registry.service';
import { AlarmsService } from '../index.service';
import { AlarmStatus } from '@/common/enums/alarm.enum';

@Injectable()
export class TelemetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(TelemetryConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    @InjectRepository(Telemetry)
    private readonly telemetryRepo: Repository<Telemetry>,
    private readonly automationProcessor: AutomationProcessor,
    private readonly websocketGateway: WebsocketGateway,
    private readonly codecService: CodecRegistryService,
     private readonly alarmsService: AlarmsService, // 
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting telemetry consumer...');

    try {
      await this.kafka.createConsumer(
        'telemetry-processor-group',
        ['telemetry.device.raw'],
        this.handleMessage.bind(this),
      );
      this.logger.log('Telemetry consumer started');
    } catch (error) {
      this.logger.error(`Failed to start telemetry consumer: ${(error as Error).message}`);
    }
  }

private async checkAlarms(deviceId: string, data: Record<string, any>): Promise<void> {
  const flat = this.flattenData(data);
  const keys = Object.keys(flat).filter(k => {
    const v = flat[k];
    return v !== null && v !== undefined && typeof v !== 'object';
  });

  if (keys.length === 0) return;

  // ← Call the batch version instead of per-key
  await this.alarmsService.checkAlarmConditionsBatch(deviceId, flat, keys);
}

private flattenData(obj: Record<string, any>, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, this.flattenData(val, fullKey));
    } else {
      result[fullKey] = val;
      // ← NO "if (!prefix) result[key] = val" line here
    }
  }
  return result;
}

  private async handleMessage({ message }: any): Promise<void> {
    try {
      const payload = JSON.parse(message.value.toString());
      this.logger.debug(`Received telemetry for device: ${payload.deviceId}`);

      if (!payload.deviceId) throw new Error('Missing deviceId in telemetry payload');
      if (!payload.tenantId) throw new Error('Missing tenantId in telemetry payload');

      // ── Step 1: Persist ────────────────────────────────────────────────────
      const telemetry = await this.storeTelemetry(payload);

         // ── Step 2: Check alarms ───────────────────────────────────────────────
    try {
      await this.checkAlarms(payload.deviceId, payload.data);
    } catch (alarmError) {
      this.logger.error(`Alarm check failed: ${(alarmError as Error).message}`);
    }

      // ── Step 2: Run automations ────────────────────────────────────────────
      try {
        await this.automationProcessor.processTelemetry(telemetry);
      } catch (automationError) {
        // Log but don't fail the pipeline — automation errors must not drop telemetry
        this.logger.error(`Automation processing failed: ${(automationError as Error).message}`);
      }

      // ── Step 3: Broadcast via WebSocket ────────────────────────────────────
      // broadcastDeviceTelemetry() is the correct method on WebsocketGateway.
      // Do NOT call broadcastToDevice() — that's on TelemetryGateway (different class).
      this.websocketGateway.broadcastDeviceTelemetry(payload.deviceId, telemetry);

      // ── Step 4: Forward to validated topic ────────────────────────────────
      await this.kafka.sendMessage(
        'telemetry.device.validated',
        {
          ...payload,
          telemetryId: telemetry.id,
          validated: true,
          processedAt: Date.now(),
        },
        payload.deviceId,
      );

      // ── Step 5: Forward to rule engine ────────────────────────────────────
      await this.kafka.sendMessage(
        'rules.input',
        {
          entityId: payload.deviceId,
          entityType: 'DEVICE',
          eventType: 'TELEMETRY',
          data: payload.data,
          timestamp: Date.now(),
        },
        payload.deviceId,
      );

      this.logger.log(`Telemetry persisted and forwarded: ${telemetry.id}`);
    } catch (error) {
      this.logger.error(`Failed to process telemetry: ${(error as Error).message}`);

      // Send to dead-letter queue — do NOT rethrow so Kafka continues
      try {
        await this.kafka.sendMessage('telemetry.device.invalid', {
          originalMessage: message.value.toString(),
          error: (error as Error).message,
          failedAt: Date.now(),
        });
      } catch (dlqError) {
        this.logger.error(`Failed to send to DLQ: ${(dlqError as Error).message}`);
      }
    }
  }

private async storeTelemetry(payload: any): Promise<Telemetry> {
  console.log("payload is ", payload);
    // const d = this.codecService.decode(payload.data.data ?? {}, payload.metadata);  // decoded data object from DeviceListenerService
    const d = payload.data;
 
    const telemetry = this.telemetryRepo.create({
      tenantId:       payload.tenantId,
      deviceId:       payload.deviceId,
      deviceKey:      payload.deviceKey,
      timestamp:      new Date(payload.timestamp ?? payload.receivedAt ?? Date.now()),
      // ── Store the full decoded data blob ──────────────────────────────
      // This includes ALL codec-decoded fields (switch_1…8, voltage, etc.)
      // as well as standard telemetry fields.
      data: d,
      // ── Standard columns — codec fields win, fall back to envelope ───
      temperature:   d.temperature    ?? payload.temperature,
      humidity:      d.humidity       ?? payload.humidity,
      pressure:      d.pressure       ?? payload.pressure,
      latitude:      d.latitude       ?? payload.latitude,
      longitude:     d.longitude      ?? payload.longitude,
      batteryLevel:  d.batteryLevel   ?? d.battery          ?? payload.batteryLevel,
      signalStrength: d.signalStrength ?? d.rssi             ?? payload.signalStrength,
      metadata: payload.metadata ?? { source: 'mqtt', receivedAt: payload.receivedAt },
    });
 
    return this.telemetryRepo.save(telemetry);
  }
}