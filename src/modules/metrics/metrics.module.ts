// src/metrics/metrics.module.ts
import { Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { CustomMetricsService } from './custom-metrics.service';
import { metricsProviders } from './metrics.provider';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
        config: {
          prefix: 'smartlife_',
        },
      },
    }),
  ],
  // No controllers needed!
  providers: [CustomMetricsService, ...metricsProviders],
  exports: [CustomMetricsService],
})
export class MetricsModule {}