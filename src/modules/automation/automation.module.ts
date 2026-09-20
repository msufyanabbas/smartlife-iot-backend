import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AutomationConsumer } from './automation.consumer';
import { AutomationListener } from './automation.listener';
import { AutomationScheduler } from './automation.scheduler';
import {
  Automation,
  AutomationLog,
  Device,
  Alarm,
  User,
} from '@modules/index.entities';
import { KafkaModule } from '@/lib/kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeviceCommandsModule } from '../device-commands/device-commands.module';
import { AttributesModule } from '../attributes/attributes.module';
import { RulesModule } from '../rules/rules.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Automation, AutomationLog, Device, Alarm, User]),
    // Kafka consumer for the telemetry.device.validated topic.
    KafkaModule,
    // Action targets. Each of these exports the service the engine calls.
    forwardRef(() => NotificationsModule),
    forwardRef(() => DeviceCommandsModule),
    forwardRef(() => AttributesModule),
    // RuleEngineService, for the TRIGGER_RULE_CHAIN action.
    forwardRef(() => RulesModule),
  ],
  controllers: [AutomationController],
  providers: [
    AutomationService,
    AutomationConsumer,
    AutomationListener,
    AutomationScheduler,
  ],
  exports: [AutomationService],
})
export class AutomationModule {}
