import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsService } from './integrations.service';
import { IntegrationsController } from './integrations.controller';
import { Integration } from './entities/integration.entity';
import { User } from '../users/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { IntegrationDispatchService } from './integration-dispatch.service';

@Module({
  imports: [
    // Device is read-only here — the dispatcher resolves deviceType/assetId
    // when an integration filters on them. Registered as a repository rather
    // than importing DevicesModule, which would create a cycle back through
    // TelemetryModule.
    TypeOrmModule.forFeature([Integration, User, Device]),
    HttpModule,
  ],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, IntegrationDispatchService],
  exports: [IntegrationsService, IntegrationDispatchService],
})
export class IntegrationsModule {}
