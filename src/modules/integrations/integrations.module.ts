import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { Integration } from './entities/integration.entity';
import { IntegrationEvent } from './entities/integration-event.entity';
import { User } from '../users/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { DeviceCredentials } from '../devices/entities/device-credentials.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { TuyaSyncService } from './tuya-sync.service';
import { LorawanService } from './lorawan.service';
import { IntegrationEventsService } from './integration-events.service';
import { IntegrationUplinkService } from './integration-uplink.service';
import { IntegrationMqttInboundService } from './integration-mqtt-inbound.service';
import { WebsocketModule } from '../websocket/websocket.module';
import { ProtocolsModule } from '../protocols/protocols.module';

@Module({
  imports: [
    // Device/DeviceCredentials/Telemetry are registered as repositories rather
    // than by importing DevicesModule or TelemetryModule, both of which import
    // their way back here. The dispatcher only reads Device (to resolve
    // deviceType/assetId for filters); TuyaSyncService writes all three when it
    // mirrors a Tuya project into the platform.
    TypeOrmModule.forFeature([
      Integration,
      IntegrationEvent,
      User,
      Device,
      DeviceCredentials,
      Telemetry,
    ]),
    // Safe as a plain import: WebsocketModule pulls in only repositories and
    // JwtModule, so there is no cycle back to this module and no forwardRef is
    // needed. @nestjs/schedule is registered globally by AppModule, so
    // TuyaSyncService's @Cron needs nothing here.
    WebsocketModule,
    HttpModule,
    // LorawanService hands uplinks to DeviceListenerService, the platform's
    // unified ingestion entry point (same path MQTT and CoAP use), rather than
    // reimplementing decode + Kafka publish. forwardRef because TelemetryModule
    // imports this module and ProtocolsModule reaches it transitively.
    forwardRef(() => ProtocolsModule),
  ],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationDispatchService,
    IntegrationEventsService,
    IntegrationUplinkService,
    // Opens a persistent client per MQTT integration that declares a subscribe
    // topic. @nestjs/schedule is global, so its reconcile @Cron needs nothing
    // registered here.
    IntegrationMqttInboundService,
    TuyaSyncService,
    LorawanService,
  ],
  exports: [
    IntegrationsService,
    IntegrationDispatchService,
    IntegrationEventsService,
    TuyaSyncService,
    LorawanService,
  ],
})
export class IntegrationsModule {}
