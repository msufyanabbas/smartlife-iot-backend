import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SolutionTemplatesService } from './solution-template.service';
import { SolutionTemplatesController } from './solution-templates.controller';
import { SolutionTemplate } from './entities/solution-template.entity';
import { TemplateInstallation } from './entities/template-installation.entity';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    // Device / Dashboard / RuleChain / Node / Alarm / DeviceProfile /
    // DeviceCredentials are all written through the transaction's
    // EntityManager, which resolves entities from the global DataSource —
    // they need no forFeature registration here.
    TypeOrmModule.forFeature([SolutionTemplate, TemplateInstallation]),
    SubscriptionsModule,
  ],
  controllers: [SolutionTemplatesController],
  providers: [SolutionTemplatesService],
  exports: [SolutionTemplatesService],
})
export class SolutionTemplatesModule {}
