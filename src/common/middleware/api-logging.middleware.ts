// src/common/middleware/api-logging.middleware.ts
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { NextFunction, Request, Response } from 'express';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';
import {
  API_LOG_BYTES,
  API_LOG_HANDLED,
  API_LOG_START,
  buildApiLogRow,
  shouldSkipApiLog,
} from '@common/interceptors/api-logging.interceptor';

/**
 * The half of API logging an interceptor cannot do.
 *
 * Nest's execution order is middleware → guards → interceptors → pipes →
 * handler. Anything a GUARD rejects never reaches an interceptor, so the
 * previous implementation silently lost every 401 (JwtAuthGuard), 403
 * (Roles/Permission/Feature/SubscriptionLimit guards) and 429
 * (CustomThrottlerGuard) — precisely the requests worth monitoring. Unmatched
 * routes (404) were lost for the same reason.
 *
 * This middleware runs for every request and does two things:
 *
 *  1. Counts response bytes and stamps the start time, for BOTH capture paths.
 *  2. On 'finish', writes the row itself IF no interceptor claimed the request
 *     (ApiLoggingInterceptor sets API_LOG_HANDLED synchronously when it runs).
 *
 * Listener order is load-bearing: this middleware registers its 'finish'
 * listener before the interceptor registers its own, so the byte count is
 * always populated before the interceptor reads it.
 */
@Injectable()
export class ApiLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ApiLoggingMiddleware.name);

  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (shouldSkipApiLog(req)) return next();

    (req as any)[API_LOG_START] = Date.now();

    let bytes = 0;
    let errorBody = '';

    const capture = (chunk: unknown): void => {
      if (chunk == null || typeof chunk === 'function') return;
      const isBuffer = Buffer.isBuffer(chunk);
      bytes += isBuffer
        ? (chunk as Buffer).length
        : Buffer.byteLength(String(chunk));
      // Keep the head of error bodies so a guard rejection can carry its
      // message — guards throw before any interceptor, so this is the only
      // place the reason is observable without rewriting HttpExceptionFilter.
      if (res.statusCode >= 400 && errorBody.length < 2048) {
        errorBody += isBuffer ? (chunk as Buffer).toString('utf8') : String(chunk);
      }
    };

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    res.write = function (chunk: any, ...args: any[]): boolean {
      capture(chunk);
      return (originalWrite as any)(chunk, ...args);
    } as typeof res.write;

    res.end = function (chunk: any, ...args: any[]): Response {
      capture(chunk);
      return (originalEnd as any)(chunk, ...args);
    } as typeof res.end;

    res.once('finish', () => {
      (req as any)[API_LOG_BYTES] = bytes;

      // A route handler ran — ApiLoggingInterceptor owns this row (it has the
      // controller name and the thrown error; we would only duplicate it).
      if ((req as any)[API_LOG_HANDLED]) return;

      const row = buildApiLogRow(req, res, {
        responseTime: Date.now() - ((req as any)[API_LOG_START] ?? Date.now()),
        errorMessage: this.extractMessage(errorBody, res.statusCode),
      });

      this.apiLogRepository
        .insert(row as any)
        .catch((err) =>
          this.logger.debug(
            `Failed to save API log: ${(err as Error).message}`,
          ),
        );
    });

    next();
  }

  /** Pull `message` out of the standard HttpExceptionFilter error envelope. */
  private extractMessage(body: string, statusCode: number): string | undefined {
    if (statusCode < 400) return undefined;
    if (!body) return `Request rejected with ${statusCode}`;
    try {
      const parsed = JSON.parse(body);
      const message = parsed?.message ?? parsed?.error;
      if (Array.isArray(message)) return message.join('; ');
      if (typeof message === 'string') return message;
    } catch {
      // Truncated or non-JSON body — fall through to the raw head.
    }
    return body.slice(0, 500);
  }
}
