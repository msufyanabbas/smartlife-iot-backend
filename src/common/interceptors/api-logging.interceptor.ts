// src/common/interceptors/api-logging.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request, Response } from 'express';
import { APILog } from '@modules/api-monitoring/entities/api-log.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Shared request-scoped state
//
// Symbols, not string keys — nothing else can collide with them, and they are
// invisible to JSON.stringify if a request object is ever serialised.
// ─────────────────────────────────────────────────────────────────────────────

/** Set by this interceptor: "the request reached a route handler". */
export const API_LOG_HANDLED = Symbol('apiLog.handled');
/** Set by ApiLoggingMiddleware: bytes the handler wrote to the socket. */
export const API_LOG_BYTES = Symbol('apiLog.bytes');
/** Set by ApiLoggingMiddleware: high-resolution start time. */
export const API_LOG_START = Symbol('apiLog.start');

const DEFAULT_SKIP_PATHS = [
  '/health',
  '/metrics',
  '/favicon.ico',
  '/docs',
  '/socket.io',
  '/uploads',
  '/ping',
];

/**
 * Paths never written to api_logs. Override with API_LOG_SKIP_PATHS
 * (comma-separated); set it to an empty string to log everything.
 *
 * Why this matters: the docker healthcheck curls /health every 30s forever.
 * Before this list existed those probes were 94.7% of the table.
 */
export function apiLogSkipPaths(): string[] {
  const configured = process.env.API_LOG_SKIP_PATHS;
  if (configured === undefined) return DEFAULT_SKIP_PATHS;
  return configured
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function shouldSkipApiLog(req: Request): boolean {
  if (req.method === 'OPTIONS') return true;
  const url = req.originalUrl || req.url || '';
  const path = url.split('?')[0];
  return apiLogSkipPaths().some((p) => path === p || path.startsWith(`${p}/`));
}

const SENSITIVE_KEYS = /^(password|token|secret|apikey|api_key|authorization|clientsecret|client_secret|local_key|refreshtoken|code)$/i;

/** Query/path params minus anything that smells like a credential. */
function sanitiseParams(input: unknown): Record<string, any> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    if (SENSITIVE_KEYS.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
    } else if (value !== null && typeof value === 'object') {
      out[key] = '[object]';
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The route TEMPLATE (/devices/:id), not the raw URL.
 *
 * req.route is populated by Express once a handler matches, which has happened
 * by the time an interceptor runs. Falling back to the raw path would put UUIDs
 * and query strings into the grouping key and shred every per-endpoint stat.
 */
export function resolveEndpoint(req: Request): string {
  const route = (req as any).route?.path;
  if (route) return route;
  const url = req.originalUrl || req.url || '/';
  return url.split('?')[0];
}

export function resolveIp(req: Request): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    first?.split(',')[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined
  );
}

function toInt(value: unknown): number {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Builds the row both the interceptor and the middleware persist, so the two
 * capture paths can never drift apart.
 */
export function buildApiLogRow(
  req: Request,
  res: Response,
  extra: {
    responseTime: number;
    errorMessage?: string;
    errorStack?: string;
    route?: string;
  },
): Partial<APILog> {
  const user = (req as any).user;
  const statusCode = res.statusCode;
  const bytes = (req as any)[API_LOG_BYTES];

  return {
    requestId: (req as any).id,
    tenantId: user?.tenantId ?? undefined,
    customerId: user?.customerId ?? undefined,
    userId: user?.id ?? undefined,
    userRole: user?.role ?? undefined,
    method: req.method,
    endpoint: resolveEndpoint(req),
    url: (req.originalUrl || req.url || '').slice(0, 2048),
    statusCode,
    responseTime: extra.responseTime,
    isError: statusCode >= 400,
    ip: resolveIp(req),
    userAgent: req.headers['user-agent']?.slice(0, 512),
    requestSize: toInt(req.headers['content-length']),
    responseSize: typeof bytes === 'number' ? bytes : toInt(res.getHeader('content-length')),
    request: sanitiseParams(req.query)
      ? { query: sanitiseParams(req.query), params: sanitiseParams((req as any).params) }
      : undefined,
    // Stack traces only for 5xx, and truncated — GET /api-monitoring/errors
    // returns this field to tenant admins.
    errorMessage: extra.errorMessage?.slice(0, 2000),
    errorStack: statusCode >= 500 ? extra.errorStack?.slice(0, 4000) : undefined,
    metadata: extra.route ? { route: extra.route, executionTime: extra.responseTime } : undefined,
    timestamp: new Date(),
  };
}

/**
 * Persists one api_logs row per HTTP request that reaches a route handler.
 *
 * Deliberate design choices, each one fixing a defect in the interceptor this
 * replaces (common/interceptors/logging.interceptor.ts):
 *
 *  - Status code is read in res.on('finish'), not in tap(). Nest applies the
 *    handler's status (201 for POST, @HttpCode, etc.) AFTER the interceptor
 *    chain completes, so anything read inside tap() is still the default 200.
 *  - endpoint is the route template; the raw URL goes to `url`.
 *  - The write is fire-and-forget and never rejects, so a logging failure
 *    cannot fail or delay a request.
 *
 * Requests rejected BEFORE the handler (401 from JwtAuthGuard, 403 from
 * PermissionGuard, 429 from the throttler, 404 unmatched) never reach an
 * interceptor at all — ApiLoggingMiddleware covers those.
 */
@Injectable()
export class ApiLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ApiLoggingInterceptor.name);

  constructor(
    @InjectRepository(APILog)
    private readonly apiLogRepository: Repository<APILog>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    if (shouldSkipApiLog(req)) return next.handle();

    // Claim the request so the middleware's fallback stands down.
    (req as any)[API_LOG_HANDLED] = true;

    const startTime = (req as any)[API_LOG_START] ?? Date.now();
    const route = `${context.getClass().name}.${context.getHandler().name}`;

    const write = (errorMessage?: string, errorStack?: string) => {
      // 'finish' fires once the response is fully flushed — the only point at
      // which res.statusCode and the byte count are final.
      res.once('finish', () => {
        this.save(
          buildApiLogRow(req, res, {
            responseTime: Date.now() - startTime,
            errorMessage,
            errorStack,
            route,
          }),
        );
      });
    };

    return next.handle().pipe(
      tap(() => write()),
      catchError((error) => {
        write(error?.message ?? 'Internal server error', error?.stack);
        return throwError(() => error);
      }),
    );
  }

  private save(row: Partial<APILog>): void {
    // Not awaited: the response is already sent, and nothing downstream needs
    // the row. Errors are swallowed at debug level — a full disk must not turn
    // every request into a 500.
    this.apiLogRepository
      .insert(row as any)
      .catch((err) =>
        this.logger.debug(`Failed to save API log: ${(err as Error).message}`),
      );
  }
}
