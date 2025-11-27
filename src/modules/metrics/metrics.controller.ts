import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { register } from 'prom-client';

@ApiTags('Metrics')
@Controller()
export class MetricsController {
  @Get('metrics')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Get Prometheus metrics' })
  @ApiResponse({ status: 200, description: 'Returns metrics in Prometheus format' })
  async getMetrics(@Res() res: Response) {
    res.setHeader('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
  }
}