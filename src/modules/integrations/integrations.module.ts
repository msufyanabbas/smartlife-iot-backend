import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { Integration } from './entities/integration.entity';
import { User } from '../users/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { DeviceCredentials } from '../devices/entities/device-credentials.entity';
import { Telemetry } from '../telemetry/entities/telemetry.entity';
import { IntegrationDispatchService } from './integration-dispatch.service';
import { TuyaSyncService } from './tuya-sync.service';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [
    // Device/DeviceCredentials/Telemetry are registered as repositories rather
    // than by importing DevicesModule or TelemetryModule, both of which import
    // their way back here. The dispatcher only reads Device (to resolve
    // deviceType/assetId for filters); TuyaSyncService writes all three when it
    // mirrors a Tuya project into the platform.
    TypeOrmModule.forFeature([
      Integration,
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
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, IntegrationDispatchService, TuyaSyncService],
  exports: [IntegrationsService, IntegrationDispatchService, TuyaSyncService],
})
export class IntegrationsModule {}
