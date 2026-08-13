// src/modules/edge/edge.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EdgeService } from './edge.service';
import { EdgeController } from './edge.controller';
import { Edge } from './entities/edge.entity';
import { EdgeEvent } from './entities/edge-event.entity';
import { EdgeCommand } from './entities/edge-command.entity';
import { EdgeMetricsSnapshot } from './entities/edge-metrics-snapshot.entity';

import { Device } from '@modules/devices/entities/device.entity';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { Dashboard } from '@modules/dashboards/entities/dashboard.entity';
import { Node } from '@modules/nodes/entities/node.entity';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { WebsocketModule } from '@modules/websocket/websocket.module';

@Module({
  imports: [
    // Read-only repositories for the resources an edge syncs (Device, RuleChain,
    // Dashboard, Node) are registered directly rather than by importing their
    // modules — same approach FloorPlansModule uses, and it avoids cycles.
    TypeOrmModule.forFeature([
      Edge,
      EdgeEvent,
      EdgeCommand,
      EdgeMetricsSnapshot,
      Device,
      RuleChain,
      Dashboard,
      Node,
    ]),

    NotificationsModule,

    // WebsocketModule is imported through forwardRef: the websocket gateway
    // reaches back into feature modules, so a direct import risks a cycle.
    forwardRef(() => WebsocketModule),

    // ScheduleModule.forRoot() and EventEmitterModule.forRoot() are NOT
    // registered here. Both are global and already registered once in AppModule;
    // a second forRoot() adds another ScheduleExplorer, which re-registers every
    // @Cron in the application and makes each one fire twice.
  ],
  controllers: [EdgeController],
  providers: [EdgeService],
  exports: [EdgeService],
})
export class EdgeModule {}
