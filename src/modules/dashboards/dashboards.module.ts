import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';
import { Dashboard } from './entities/dashboard.entity';
import { WebsocketModule } from '@modules/websocket/websocket.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Dashboard]),
    WebsocketModule, // DashboardsService uses WebsocketGateway to notify clients
                     // when widgets are added/removed (device subscription changes)
  ],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}