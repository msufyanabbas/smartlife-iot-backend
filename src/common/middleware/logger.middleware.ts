import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private logger = new Logger('HTTP');

  use(request: Request, response: Response, next: NextFunction): void {
    const { method, originalUrl, ip } = request;
    const userAgent = request.get('user-agent') || '';
    const startTime = Date.now();

    // Log request
    this.logger.log(`Incoming ${method} ${originalUrl} - ${ip} - ${userAgent}`);

    // Log response
    response.on('finish', () => {
      const { statusCode } = response;
      const responseTime = Date.now() - startTime;
      const contentLength = response.get('content-length') || 0;

      this.logger.log(
        `Completed ${method} ${originalUrl} - ${statusCode} - ${responseTime}ms - ${contentLength}bytes`,
      );
    });

    next();
  }
}
