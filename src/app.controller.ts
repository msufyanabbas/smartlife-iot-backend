import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  @Get()
  @Public()
  healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
  @Get('ping')
  @Public()
  ping() {
    return {
      status: 'pong',
      timestamp: new Date().toISOString(),
    };
  }
}
