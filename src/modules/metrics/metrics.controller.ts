// src/metrics/metrics.controller.ts
import { Controller, Get, Inject } from '@nestjs/common';
import {
  PrometheusController,
  PrometheusOptions
} from '@willsoto/nestjs-prometheus';

@Controller()
export class MetricsController extends PrometheusController {
  constructor(
    @Inject()
    private readonly options: any
  ) {
    super(); 
  }

  @Get('/metrics')
  async index() {
    return super.index(this.options);
  }
}
