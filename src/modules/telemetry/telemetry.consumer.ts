import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Alarm, Device, Telemetry } from '@modules/index.entities';
import { KafkaService } from '@/lib/kafka/kafka.service';
import { WebsocketGateway } from '@modules/websocket/websocket.gateway';
import { CodecRegistryService } from '../devices/codecs/codec-registry.service';
import { AlarmsService } from '../index.service';
import { AlarmStatus } from '@/common/enums/alarm.enum';
import { ProfileAlarmService } from '@modules/profiles/profile-alarm.service';
import { IntegrationDispatchService } from '@modules/integrations/integration-dispatch.service';
import { CalculatedFieldsService } from './calculated-fields.service';
import { TelemetryLatestCacheService } from './telemetry-latest-cache.service';

@Injectable()
export class TelemetryConsumer implements OnModuleInit {
  private readonly logger = new Logger(TelemetryConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    @InjectRepository(Telemetry)
    private readonly telemetryRepo: Repository<Telemetry>,
    private readonly websocketGateway: WebsocketGateway,
    private readonly codecService: CodecRegistryService,
    private readonly alarmsService: AlarmsService, //
    private readonly profileAlarmService: ProfileAlarmService,
    private readonly integrationDispatch: IntegrationDispatchService,
    // Asset-profile calculated fields, merged into the reading at step 0.
    private readonly calculatedFields: CalculatedFieldsService,
    // The other writer of `telemetry:latest:*`. Injected rather than reaching
    // for TelemetryService, whose dependency graph this consumer has no need
    // of — and whose own cache write covers only the HTTP path.
    private readonly telemetryCache: TelemetryLatestCacheService,
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
      this.logger.error(
        `Failed to start telemetry consumer: ${(error as Error).message}`,
      );
    }
  }

  private async checkAlarms(
    deviceId: string,
    data: Record<string, any>,
  ): Promise<void> {
    const flat = this.flattenData(data);
    const keys = Object.keys(flat).filter((k) => {
      const v = flat[k];
      return v !== null && v !== undefined && typeof v !== 'object';
    });

    if (keys.length === 0) return;

    // ← Call the batch version instead of per-key
    await this.alarmsService.checkAlarmConditionsBatch(deviceId, flat, keys);
  }

  private flattenData(
    obj: Record<string, any>,
    prefix = '',
  ): Record<string, any> {
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

      if (!payload.deviceId)
        throw new Error('Missing deviceId in telemetry payload');
      if (!payload.tenantId)
        throw new Error('Missing tenantId in telemetry payload');

      // ── Step 0: Calculated fields ─────────────────────────────────────────
      // An asset profile's calculated fields are evaluated against this
      // reading (plus the device's and asset's attributes) and merged into
      // `payload.data` BEFORE anything else happens to it.
      //
      // The position is the whole design. Everything after this line —
      // persistence at step 1, both alarm evaluations at step 2, the WebSocket
      // broadcast at step 3, the integration fan-out, the
      // `telemetry.device.validated` topic that drives automations and
      // `rules.input` — all read `payload.data`. Merging here means a derived
      // value charts, alarms, triggers automations and reaches external systems
      // exactly like a reported one, with no change to any of those paths. Do
      // not move this below step 1.
      //
      // Non-fatal and silent on failure, like the alarm checks: a tenant's
      // broken formula must not stop telemetry ingestion. The service already
      // swallows its own errors; this guard is a backstop.
      try {
        const calculated =
          await this.calculatedFields.computeForTelemetry(
            payload.deviceId,
            payload.tenantId,
            payload.data ?? {},
          );
        if (Object.keys(calculated).length > 0) {
          // Calculated values are applied UNDER the reading, never over it:
          // the service already drops any name that collides, and the spread
          // order makes that structurally true rather than only true by
          // convention.
          payload.data = { ...calculated, ...(payload.data ?? {}) };
          this.logger.debug(
            `Calculated ${Object.keys(calculated).length} field(s) for device ${payload.deviceId}`,
          );
        }
      } catch (calcError) {
        this.logger.error(
          `Calculated field evaluation failed: ${(calcError as Error).message}`,
        );
      }

      // ── Step 1: Persist ────────────────────────────────────────────────────
      const telemetry = await this.storeTelemetry(payload);

      // ── Step 1b: Write through the latest-reading cache ───────────────────
      // `TelemetryService.getLatest()` reads this key, and it serves devices
      // on BOTH ingest paths. Before this, only the HTTP path
      // (TelemetryService.create) wrote it — so for every MQTT, CoAP, Modbus,
      // SNMP, BACnet and LwM2M device, which is most of them, the cache would
      // have held nothing or a stale HTTP reading while the dashboard showed
      // it as current. A cache maintained by one of two writers is not a slow
      // cache, it is a wrong answer; this is the other writer.
      //
      // Non-fatal: the row is already committed, and no Redis failure may
      // dead-letter a reading that was persisted successfully.
      await this.telemetryCache
        .write(payload.deviceId, telemetry)
        .catch((err) =>
          this.logger.error(
            `latest-telemetry cache write failed for ${payload.deviceId}: ${(err as Error).message}`,
          ),
        );

      // ── Step 2: Check alarms ───────────────────────────────────────────────
      // Two independent sources, both non-fatal:
      //   a) per-device Alarm rows configured by hand (AlarmsService)
      //   b) alarm rule templates on the device's DeviceProfile
      try {
        await this.checkAlarms(payload.deviceId, payload.data);
      } catch (alarmError) {
        this.logger.error(
          `Alarm check failed: ${(alarmError as Error).message}`,
        );
      }

      try {
        // Pass the raw payload — ProfileAlarmService normalises the
        // {ts, values:{…}} envelope itself so rules can name bare keys.
        await this.profileAlarmService.evaluateProfileAlarmRules(
          payload.deviceId,
          payload.data ?? {},
        );
      } catch (profileAlarmError) {
        this.logger.error(
          `Device profile alarm check failed: ${
            (profileAlarmError as Error).message
          }`,
        );
      }

      // ── Step 3: Broadcast via WebSocket ────────────────────────────────────
      // broadcastDeviceTelemetry() is the correct method on WebsocketGateway.
      // Do NOT call broadcastToDevice() — that's on TelemetryGateway (different class).
      this.websocketGateway.broadcastDeviceTelemetry(
        payload.deviceId,
        telemetry,
      );

      // ── Step 3b: Fan out to external integrations ─────────────────────────
      // Fire-and-forget: an external endpoint can be slow or down, and neither
      // may delay persistence or the Kafka hand-off below. The service already
      // swallows its own errors; the .catch() is a backstop against an
      // unhandled rejection taking down the process.
      void this.integrationDispatch
        .dispatchTelemetry({
          deviceId: payload.deviceId,
          deviceKey: payload.deviceKey,
          tenantId: payload.tenantId,
          deviceType: payload.deviceType,
          assetId: payload.assetId,
          data: payload.data ?? {},
          timestamp: new Date(),
        })
        .catch((err) =>
          this.logger.error(`Integration dispatch error: ${err.message}`),
        );

      // ── Step 4: Forward to validated topic ────────────────────────────────
      // AutomationConsumer subscribes to this topic and runs TELEMETRY-trigger
      // automations. It is NOT called inline here so a slow action (a webhook,
      // a delayed action) cannot stall the telemetry consumer group.
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
          tenantId: payload.tenantId,
          entityId: payload.deviceId,
          entityType: 'DEVICE',
          eventType: 'TELEMETRY',
          data: payload.data,
          deviceKey: payload.deviceKey,
          timestamp: Date.now(),
        },
        payload.deviceId,
      );

      this.logger.log(`Telemetry persisted and forwarded: ${telemetry.id}`);
    } catch (error) {
      // ── Rethrow. This is a change in behaviour and it is the point. ───────
      //
      // This handler used to catch everything, push the raw value straight to
      // `telemetry.device.invalid` and return. Two things were wrong with that:
      //
      //   • There was no retry. A frame that failed because Postgres was
      //     momentarily unavailable — a lock wait, a failover, a connection
      //     pool exhaustion — was dead-lettered on its first failure and the
      //     reading was gone, even though retrying it 250ms later would have
      //     persisted it.
      //   • The DLQ send happened while the producer might be the thing that
      //     is broken, and its own failure was logged and dropped.
      //
      // `KafkaService.runHandler()` now retries this KAFKA_CONSUMER_MAX_ATTEMPTS
      // times with backoff and only then dead-letters — to
      // `telemetry.device.invalid`, which TOPIC_REGISTRY names as this
      // stream's DLQ, so the destination has not changed. The offset still
      // advances either way: a poison frame must not block its partition.
      this.logger.error(
        `Failed to process telemetry: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async storeTelemetry(payload: any): Promise<Telemetry> {
    console.log('payload is ', payload);
    // const d = this.codecService.decode(payload.data.data ?? {}, payload.metadata);  // decoded data object from DeviceListenerService
    const d = payload.data;

    const telemetry = this.telemetryRepo.create({
      tenantId: payload.tenantId,
      deviceId: payload.deviceId,
      deviceKey: payload.deviceKey,
      timestamp: new Date(
        payload.timestamp ?? payload.receivedAt ?? Date.now(),
      ),
      // ── Store the full decoded data blob ──────────────────────────────
      // This includes ALL codec-decoded fields (switch_1…8, voltage, etc.)
      // as well as standard telemetry fields.
      data: d,
      // ── Standard columns — codec fields win, fall back to envelope ───
      temperature: d.temperature ?? payload.temperature,
      humidity: d.humidity ?? payload.humidity,
      pressure: d.pressure ?? payload.pressure,
      latitude: d.latitude ?? payload.latitude,
      longitude: d.longitude ?? payload.longitude,
      batteryLevel: d.batteryLevel ?? d.battery ?? payload.batteryLevel,
      signalStrength: d.signalStrength ?? d.rssi ?? payload.signalStrength,
      metadata: payload.metadata ?? {
        source: 'mqtt',
        receivedAt: payload.receivedAt,
      },
    });

    return this.telemetryRepo.save(telemetry);
  }
}
