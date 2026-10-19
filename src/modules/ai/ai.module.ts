import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModel } from './entities/ai-model.entity';
import { AiService } from './ai.service';
import { AiInsightsService } from './ai-insights.service';
import { AiController } from './ai.controller';

/**
 * `AiService` is exported because the `ai_request` rule node resolves models
 * through it — the node must never hold credentials of its own (see
 * AiModel's doc comment).
 *
 * TelemetryModule is deliberately NOT imported. The insights service resolves
 * TelemetryService through ModuleRef at runtime instead, because importing it
 * closes a module-load cycle back through NotificationsService that crashes
 * bootstrap() — see the comment in ai-insights.service.ts.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiModel]),
  ],
  controllers: [AiController],
  providers: [AiService, AiInsightsService],
  exports: [AiService, AiInsightsService],
})
export class AiModule {}
