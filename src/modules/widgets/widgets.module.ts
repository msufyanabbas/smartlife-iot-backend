import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WidgetsController } from './widgets.controller';
import { WidgetTypesService } from './widget-types.service';
import { WidgetBundlesService } from './widget-bundles.service';
import { WidgetType } from './entities/widget-type.entity';
import { WidgetBundle } from './entities/widget-bundle.entity';
import { WebsocketModule } from '@modules/websocket/websocket.module';

// WebsocketModule is imported so DashboardModule (which imports WidgetsModule)
// can access WebsocketGateway to push real-time telemetry to widget subscribers.
// The flow:
//   Device sends data → TelemetryConsumer → WebsocketGateway.broadcastDeviceTelemetry()
//   → frontend widgets subscribed to device:${deviceId} room receive the update.
//
// The frontend subscribes using:
//   socket.emit('device:subscribe', { deviceId }) when a widget mounts
//   socket.emit('device:unsubscribe', { deviceId }) when a widget unmounts
//   socket.on('device:telemetry', handler) to receive updates

@Module({
  imports: [
    TypeOrmModule.forFeature([WidgetType, WidgetBundle]),
    WebsocketModule,
  ],
  controllers: [WidgetsController],
  providers: [WidgetTypesService, WidgetBundlesService],
  exports: [WidgetTypesService, WidgetBundlesService],
})
export class WidgetsModule {}