import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import {
  INodeProcessor,
  NodeMessage,
  NodeProcessorResult,
} from './nodes-processor.interface';
import { MailService } from '../mail/mail.service';
import { MQTTService } from '@/lib/mqtt/mqtt.service';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { Alarm } from '../alarms/entities/alarm.entity';
import { Attribute } from '../attributes/entities/attribute.entity';
import {
  AlarmCondition,
  AlarmSeverity,
  AlarmStatus,
  AttributeScope,
  DataType,
} from '@common/enums/index.enum';

@Injectable()
export class ActionNodeProcessor implements INodeProcessor {
  private readonly logger = new Logger(ActionNodeProcessor.name);

  constructor(
    @InjectRepository(Telemetry)
    private readonly telemetryRepo: Repository<Telemetry>,
    @InjectRepository(Alarm)
    private readonly alarmRepo: Repository<Alarm>,
    @InjectRepository(Attribute)
    private readonly attributeRepo: Repository<Attribute>,
    private readonly mailService: MailService,
    private readonly mqttService: MQTTService,
  ) {}

  async process(input: NodeMessage, config: any): Promise<NodeProcessorResult> {
    try {
      let actionResult: any;

      switch (config.actionType) {
        case 'save_telemetry':
          actionResult = await this.saveTelemetry(input, config);
          break;
        case 'save_attributes':
          actionResult = await this.saveAttributes(input, config);
          break;
        case 'create_alarm':
          actionResult = await this.createAlarm(input, config);
          break;
        case 'send_email':
          actionResult = await this.sendEmail(input, config);
          break;
        case 'rest_api_call':
          actionResult = await this.restApiCall(input, config);
          break;
        case 'mqtt_publish':
          actionResult = await this.mqttPublish(input, config);
          break;
        default:
          throw new Error(`Unknown action type: ${config.actionType}`);
      }

      return {
        success: true,
        output: {
          ...input,
          metadata: {
            ...input.metadata,
            actionExecuted: config.actionType,
            actionResult,
            executedAt: Date.now(),
          },
        },
        route: 'success',
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        route: 'failure',
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ACTION IMPLEMENTATIONS
  // ══════════════════════════════════════════════════════════════════════════

  private async saveTelemetry(input: NodeMessage, config: any): Promise<any> {
    const tenantId = input.metadata?.tenantId as string;
    const deviceKey = input.metadata?.deviceKey as string;

    if (!tenantId || !input.originator?.id) {
      throw new Error(
        'saveTelemetry requires tenantId and originator.id in message metadata',
      );
    }

    const telemetry = this.telemetryRepo.create({
      tenantId,
      deviceId: input.originator.id,
      deviceKey: deviceKey ?? input.originator.id,
      timestamp: new Date(input.timestamp),
      data: input.data,
      temperature: input.data?.temperature,
      humidity: input.data?.humidity,
      pressure: input.data?.pressure,
      latitude: input.data?.latitude,
      longitude: input.data?.longitude,
      batteryLevel: input.data?.batteryLevel ?? input.data?.battery,
      signalStrength: input.data?.signalStrength ?? input.data?.rssi,
      metadata: { source: 'rule-engine', ...config.metadata },
    });

    const saved = await this.telemetryRepo.save(telemetry);
    this.logger.log(
      `[save_telemetry] saved id=${saved.id} device=${input.originator.id}`,
    );
    return { telemetryId: saved.id };
  }

  private async saveAttributes(input: NodeMessage, config: any): Promise<any> {
    const tenantId = input.metadata?.tenantId as string;
    if (!tenantId || !input.originator?.id) {
      throw new Error(
        'saveAttributes requires tenantId and originator.id in message metadata',
      );
    }

    const entityType = config.entityType ?? input.originator.type ?? 'DEVICE';
    const scope: AttributeScope = config.scope ?? AttributeScope.SERVER;
    const dataToSave: Record<string, any> =
      config.attributes ?? input.data ?? {};

    const saved: string[] = [];

    for (const [key, value] of Object.entries(dataToSave)) {
      const dataType = this.inferDataType(value);
      const existing = await this.attributeRepo.findOne({
        where: {
          tenantId,
          entityType,
          entityId: input.originator.id,
          attributeKey: key,
          scope,
        },
      });

      if (existing) {
        existing.dataType = dataType;
        existing.stringValue = typeof value === 'string' ? value : undefined;
        existing.numberValue = typeof value === 'number' ? value : undefined;
        existing.booleanValue = typeof value === 'boolean' ? value : undefined;
        existing.jsonValue = typeof value === 'object' ? value : undefined;
        existing.lastUpdateTs = Date.now();
        await this.attributeRepo.save(existing);
      } else {
        const attr = this.attributeRepo.create({
          tenantId,
          entityType,
          entityId: input.originator.id,
          attributeKey: key,
          scope,
          dataType,
          stringValue: typeof value === 'string' ? value : undefined,
          numberValue: typeof value === 'number' ? value : undefined,
          booleanValue: typeof value === 'boolean' ? value : undefined,
          jsonValue: typeof value === 'object' ? value : undefined,
          lastUpdateTs: Date.now(),
          userId: 'rule-engine',
        });
        await this.attributeRepo.save(attr);
      }
      saved.push(key);
    }

    this.logger.log(
      `[save_attributes] saved ${saved.length} keys for ${input.originator.id}`,
    );
    return { saved };
  }

  private async createAlarm(input: NodeMessage, config: any): Promise<any> {
    const tenantId = input.metadata?.tenantId as string;
    if (!tenantId) {
      throw new Error('createAlarm requires tenantId in message metadata');
    }

    const alarm = this.alarmRepo.create({
      tenantId,
      name: config.alarmType ?? config.name ?? 'Rule Engine Alarm',
      description: config.description,
      severity: config.severity ?? AlarmSeverity.WARNING,
      status: AlarmStatus.ACTIVE,
      deviceId:
        input.originator?.type === 'DEVICE' ? input.originator.id : undefined,
      rule: config.alarmRule ?? {
        // No threshold applies: the rule chain already decided this alarm should
        // fire, so the rule row records "this key was present" rather than a
        // comparison. 'ANY' was not a member of AlarmCondition — the string
        // literal is what forced the `as any` cast on this object, which in turn
        // made create() resolve to its array overload and broke `saved.id` below.
        telemetryKey: Object.keys(input.data ?? {})[0] ?? 'unknown',
        condition: AlarmCondition.EXISTS,
        value: 0,
      },
      isEnabled: true,
    });

    const saved = await this.alarmRepo.save(alarm);
    this.logger.log(`[create_alarm] id=${saved.id} severity=${alarm.severity}`);
    return { alarmId: saved.id };
  }

  private async sendEmail(input: NodeMessage, config: any): Promise<any> {
    const actionConfig = config.actionConfig ?? config;
    const recipients: string[] = actionConfig.recipients ?? [];

    if (recipients.length === 0) {
      throw new Error('sendEmail requires at least one recipient');
    }

    const subject = this.interpolate(
      actionConfig.subject ?? `IoT Alert: ${config.actionType}`,
      input.data,
    );
    const body = this.interpolate(
      actionConfig.template ?? actionConfig.body ?? JSON.stringify(input.data),
      input.data,
    );

    let sent = 0;
    for (const to of recipients) {
      const ok = await this.mailService.sendEmail({
        to,
        subject,
        html: body,
        text: body,
      });
      if (ok) sent++;
    }

    this.logger.log(`[send_email] sent=${sent}/${recipients.length}`);
    return { sent, total: recipients.length };
  }

  private async restApiCall(input: NodeMessage, config: any): Promise<any> {
    const url = config.url ?? config.webhookUrl;
    if (!url) throw new Error('restApiCall requires config.url');

    const method = (
      config.method ??
      config.webhookMethod ??
      'POST'
    ).toLowerCase();
    const headers = config.headers ?? config.webhookHeaders ?? {};
    const body = config.body ?? config.webhookBody ?? input.data;

    const response = await axios({
      method,
      url,
      headers,
      data: body,
      timeout: config.timeout ?? 10_000,
    });

    if (response.status >= 400) {
      throw new Error(`REST API returned HTTP ${response.status}`);
    }

    this.logger.log(
      `[rest_api_call] ${method.toUpperCase()} ${url} → ${response.status}`,
    );
    return { statusCode: response.status };
  }

  private async mqttPublish(input: NodeMessage, config: any): Promise<any> {
    const topic = config.topic ?? config.mqttTopic;
    if (!topic) throw new Error('mqttPublish requires config.topic');

    const payload = config.payload ?? config.message ?? input.data;
    await this.mqttService.publish(
      topic,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );

    this.logger.log(`[mqtt_publish] topic=${topic}`);
    return { published: true, topic };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPER
  // ══════════════════════════════════════════════════════════════════════════

  private inferDataType(value: any): DataType {
    if (typeof value === 'string') return DataType.STRING;
    if (typeof value === 'number') return DataType.NUMBER;
    if (typeof value === 'boolean') return DataType.BOOLEAN;
    return DataType.JSON;
  }

  private interpolate(template: string, data: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = data?.[key];
      return val !== undefined ? String(val) : `{{${key}}}`;
    });
  }
}
