import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

@ApiTags('Metrics')
@Controller()
export class MetricsController extends PrometheusController {
  @Get('metrics')
  @ApiExcludeEndpoint() // Optional: exclude from Swagger docs since it's not JSON
  @ApiOperation({ summary: 'Get Prometheus metrics' })
  @ApiResponse({ status: 200, description: 'Returns metrics in Prometheus format' })
  async index(@Res() response: Response) {
    return super.index(response);
  }
}