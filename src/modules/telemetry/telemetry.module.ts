import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryConsumer } from './telemetry.consumer';
import { TelemetryProcessor } from './processors/telemetry.processor';
import { Telemetry } from './entities/telemetry.entity';
import { TelemetryRollup } from './entities/telemetry-rollup.entity';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetryRetentionService } from './telemetry-retention.service';
import { TelemetryMaintenanceService } from './telemetry-maintenance.service';
import { Subscription } from '@modules/subscriptions/entities/subscription.entity';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { RedisModule } from '@/lib/redis/redis.module';
import { AutomationModule } from '@modules/automation/automation.module';
import { WebsocketModule } from '@modules/websocket/websocket.module';
import { AlarmsModule } from '@modules/alarms/alarms.module';
import { ProfilesModule } from '@modules/profiles/profiles.module';
import { IntegrationsModule } from '@modules/integrations/integrations.module';
import { WsAuthorizationModule } from '@common/websocket/ws-authorization.module';
import { TelemetryGateway } from './telemetry.gateway';
import { CalculatedFieldsService } from './calculated-fields.service';
import { TelemetryLatestCacheService } from './telemetry-latest-cache.service';
import { Asset } from '@modules/assets/entities/asset.entity';
import { Attribute } from '@modules/attributes/entities/attribute.entity';
import { Device } from '../index.entities';

@Module({
  imports: [
    // Subscription is registered here rather than by importing
    // SubscriptionsModule: TelemetryRetentionService only reads
    // `limits.dataRetentionDays`, and FloorPlansService already reads
    // subscription limits the same way to avoid a module cycle.
    // Asset and Attribute are registered as repositories for the same reason
    // Subscription is: CalculatedFieldsService only READS them (device → asset
    // → assetProfile, plus the asset's attribute rows), and importing
    // AssetsModule or AttributesModule would pull their whole graphs in —
    // AssetsModule is also owned by a different change in flight.
    TypeOrmModule.forFeature([
      Telemetry,
      TelemetryRollup,
      Device,
      Subscription,
      Asset,
      Attribute,
    ]),
    KafkaModule,
    RedisModule,
    // exports AutomationService -> TelemetryService calls
    // evaluateTelemetryTriggers() on the HTTP ingestion path, which skips Kafka
    // and therefore never reaches AutomationConsumer.
    forwardRef(() => AutomationModule),
    WebsocketModule,
    AlarmsModule, // exports AlarmsService → needed by TelemetryProcessor
    // exports ProfileAlarmService → device-profile alarm rules, and
    // AssetProfilesService → the calculated-field expression sandbox that
    // CalculatedFieldsService calls rather than reimplementing.
    ProfilesModule,
    // exports IntegrationDispatchService → outbound fan-out to external systems.
    // No forwardRef needed: IntegrationsModule imports only TypeOrmModule and
    // HttpModule, so there is no cycle back to TelemetryModule.
    IntegrationsModule,
    // Carries WsSubscriptionAuthorizer to TelemetryGateway. Repository-only, so
    // it adds no cycle — see the module's own comment.
    WsAuthorizationModule,
    // The queue TelemetryProcessor consumes. It was already registered — what
    // was missing until TelemetryMaintenanceService was added is anything that
    // produces onto it.
    BullModule.registerQueue({ name: 'telemetry' }),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    { provide: 'TelemetryService', useExisting: TelemetryService },
    TelemetryConsumer,
    TelemetryProcessor,
    TelemetryRollupService,
    TelemetryRetentionService,
    // The @Cron producer. ScheduleModule.forRoot() in AppModule is what makes
    // its decorators live, exactly as for IntegrationEventsService.prune() and
    // DevicesService.checkOfflineDevices().
    TelemetryMaintenanceService,
    // Was dead code: declared in no module, so the /telemetry namespace did not
    // exist and its @OnEvent handlers never ran. Registered rather than deleted
    // — see the note on the class. Cross-replica delivery for it comes from the
    // Socket.IO Redis adapter in main.ts, which is set on the shared server and
    // therefore covers every namespace.
    TelemetryGateway,
    // Evaluates an asset profile's calculated fields against each arriving
    // reading and merges the results into the row before it is persisted.
    CalculatedFieldsService,
    // Sole owner of the `telemetry:latest:*` Redis key. Both ingest paths
    // (TelemetryService for HTTP, TelemetryConsumer for Kafka) write it
    // through this one class, which is what keeps the entries identical.
    TelemetryLatestCacheService,
  ],
  exports: [
    TelemetryService,
    TelemetryRollupService,
    TelemetryRetentionService,
    CalculatedFieldsService,
    // String alias. AiInsightsService resolves telemetry through ModuleRef
    // rather than importing TelemetryModule, because the import closes a
    // module-load cycle through NotificationsService that crashes
    // bootstrap(). ModuleRef needs a token it can name WITHOUT importing the
    // class, so the class is also registered under its own name.
    'TelemetryService',
  ],
})
export class TelemetryModule {}
