// src/main.ts
//
// Imported first, for its side effect: resolves and loads the .env file before
// any other module is evaluated. Several modules read process.env at import
// time (gateway decorators, AppDataSource), so this must not move.
import '@/config/load-env';

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@modules/index.service';
import compression from 'compression';
import helmet from 'helmet';
import { join } from 'path';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from '@common/filters/index.filter';
import {
  TimeoutInterceptor,
  TransformInterceptor,
} from '@common/interceptors/index.interceptor';
import { envBoolean, envList, envNumber, envString } from '@/config/env.utils';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Debug and verbose are noise in production and can leak request payloads
    // into aggregated logs, so the level set follows LOG_LEVEL.
    logger: resolveLogLevels(process.env.LOG_LEVEL, process.env.NODE_ENV),
    rawBody: true,
  });

  const logger = new Logger('Bootstrap');
  const configService = app.get(ConfigService);

  const nodeEnv = configService.get<string>('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';
  const isDevelopment = !isProduction;

  // ── Validation ─────────────────────────────────────────────────────────────
  // whitelist: strips properties not in the DTO
  // transform: auto-converts primitives (string → number etc.)
  // forbidNonWhitelisted: throws if unknown properties are sent
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // Validation messages can echo submitted values back to the caller.
      // Fine while developing, not something to hand to anonymous clients.
      disableErrorMessages: isProduction
        ? envBoolean(process.env.HIDE_VALIDATION_ERRORS, false)
        : false,
    }),
  );

  // ── Security ───────────────────────────────────────────────────────────────
  if (isDevelopment) {
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
      }),
    );
  } else {
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: [`'self'`],
            styleSrc: [`'self'`, `'unsafe-inline'`, 'https:'],
            scriptSrc: [`'self'`, `'unsafe-inline'`, `'unsafe-eval'`, 'https:'],
            imgSrc: [`'self'`, 'data:', 'https:', 'validator.swagger.io'],
            connectSrc: [`'self'`, 'https:'],
            fontSrc: [`'self'`, 'https:', 'data:'],
            objectSrc: [`'none'`],
            mediaSrc: [`'self'`],
            frameSrc: [`'none'`],
          },
        },
        crossOriginEmbedderPolicy: false,
      }),
    );
  }

  app.use(compression());

  // ── Trust proxy ────────────────────────────────────────────────────────────
  // Behind nginx / a cloud load balancer, Express sees the proxy's IP for every
  // request. Without this the rate limiter buckets the entire internet into one
  // client, and audit logs record the proxy instead of the caller.
  if (envBoolean(process.env.TRUST_PROXY, isProduction)) {
    app.set('trust proxy', envString(process.env.TRUST_PROXY_HOPS, '1'));
  }

  // ── Static uploads ─────────────────────────────────────────────────────────
  // Everything written under the upload directory (images, floor plans,
  // firmware, solution template images) is served read-only at /uploads/**.
  // Registered after helmet so these headers win: helmet's default
  // Cross-Origin-Resource-Policy is same-origin, which would block the frontend
  // from rendering an <img>. The CSP + nosniff pair neutralises an uploaded SVG
  // opened directly.
  //
  // The path now follows UPLOAD_PATH rather than assuming ./uploads, so a
  // deployment mounting a volume elsewhere actually serves the files it writes.
  const uploadPath = envString(process.env.UPLOAD_PATH, './uploads')!;
  app.useStaticAssets(join(process.cwd(), uploadPath), {
    prefix: envString(process.env.UPLOAD_URL_PREFIX, '/uploads'),
    index: false,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  // ── API prefix ─────────────────────────────────────────────────────────────
  // There is a real inconsistency in this repo, and it is deliberately NOT
  // resolved by fiat here:
  //
  //   * app.config.ts reads API_PREFIX (default 'api') — but nothing ever
  //     called setGlobalPrefix, so routes are served from the root: /auth/login.
  //   * The Postman collection agrees with the root: {{base_url}}/auth/login.
  //   * The OAuth callback URLs in .env.production.example do NOT:
  //     http://localhost:5000/api/auth/google/callback.
  //
  // The likely explanation is a reverse proxy stripping /api in front of the
  // app. Turning the prefix on unconditionally would therefore break every
  // existing client and every saved OAuth redirect URI, so it is opt-in:
  // API_PREFIX_ENABLED=true switches it on when you are ready to move the
  // clients over. Default is the current behaviour — no prefix.
  const apiPrefix = envString(process.env.API_PREFIX, 'api')!;
  if (envBoolean(process.env.API_PREFIX_ENABLED, false)) {
    // Health and metrics stay unprefixed so probes and Prometheus scrape
    // configs do not have to be updated in lockstep.
    app.setGlobalPrefix(apiPrefix, {
      exclude: ['health', 'metrics'],
    });
  }

  // ── CORS ───────────────────────────────────────────────────────────────────
  // Previously `allowedOrigins` was computed and then never used — the
  // enableCors call was commented out, so the browser fell back to same-origin
  // and every cross-origin frontend request failed. It is applied now.
  const allowedOrigins = envList(process.env.CORS_ORIGIN, ['*']);
  const allowCredentials = envBoolean(process.env.CORS_CREDENTIALS, true);

  // Deliberate "allow any origin" mode, opt-in via CORS_ALLOW_ANY_ORIGIN.
  //
  // This REFLECTS the caller's Origin header rather than sending a literal "*".
  // The distinction matters: the CORS spec forbids `Access-Control-Allow-Origin: *`
  // on credentialed requests, so a literal wildcard silently breaks cookie auth
  // and any fetch sent with credentials:'include'. Reflecting the origin is
  // equally permissive and does not have that failure mode.
  //
  // Understand what this gives up: every website on the internet can make
  // browser requests to this API and read the responses. The JWT guard is then
  // the ONLY thing standing between a hostile page and your data. Turn it on
  // knowingly, and prefer listing origins once you know them.
  const allowAnyOrigin = envBoolean(process.env.CORS_ALLOW_ANY_ORIGIN, false);
  const wildcardInList = allowedOrigins.includes('*');

  if (allowAnyOrigin) {
    logger.warn(
      'CORS_ALLOW_ANY_ORIGIN is enabled — every origin is accepted. ' +
        'Replace it with an explicit CORS_ORIGIN list before this reaches real users.',
    );
  } else if (wildcardInList && allowCredentials) {
    // A literal "*" and credentials are mutually exclusive per spec; sending
    // both looks configured but silently breaks credentialed requests.
    logger.warn(
      'CORS_ORIGIN is "*" while CORS_CREDENTIALS is enabled — credentials are being ' +
        'disabled for this run. Set CORS_ALLOW_ANY_ORIGIN=true to accept any origin ' +
        'with credentials intact, or list explicit origins.',
    );
  }

  // When CORS_ALLOWED_HEADERS is unset, the header list is left undefined so the
  // cors package reflects Access-Control-Request-Headers — i.e. it allows whatever
  // the browser asks for. An explicit list here is STRICTER than no configuration
  // at all, which is a trap: a frontend that adds one custom header starts failing
  // preflight with no obvious cause.
  const configuredHeaders = envList(process.env.CORS_ALLOWED_HEADERS, []);

  app.enableCors({
    origin: allowAnyOrigin || wildcardInList ? true : allowedOrigins,
    credentials: !wildcardInList || allowAnyOrigin ? allowCredentials : false,
    methods: envList(process.env.CORS_METHODS, [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ]),
    allowedHeaders:
      configuredHeaders.length > 0 ? configuredHeaders : undefined,
    maxAge: envNumber(process.env.CORS_MAX_AGE, 86400),
  });

  // ── Filters ────────────────────────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Interceptors ───────────────────────────────────────────────────────────
  // Note: AuditInterceptor, MetricsInterceptor, UsageTrackingInterceptor are
  // registered as APP_INTERCEPTOR in AppModule so they have DI access.
  // Only stateless interceptors (no constructor dependencies) can go here.
  app.useGlobalInterceptors(
    new TransformInterceptor(), // wraps all responses
    new TimeoutInterceptor(configService), // enforces REQUEST_TIMEOUT
  );

  // ── Swagger ────────────────────────────────────────────────────────────────
  // ENABLE_SWAGGER existed in the env and in app.config.ts but nothing checked
  // it — the full API surface, including every DTO shape, was published on
  // /docs in production. It is gated now and defaults to off in production.
  const swaggerEnabled = envBoolean(process.env.ENABLE_SWAGGER, !isProduction);
  const swaggerPath = envString(process.env.SWAGGER_PATH, 'docs')!;
  const appName = envString(process.env.APP_NAME, 'Smart Life IoT Platform')!;

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle(`${appName} API`)
      .setDescription(
        envString(
          process.env.SWAGGER_DESCRIPTION,
          'Enterprise IoT Management Platform API Documentation',
        )!,
      )
      .setVersion(envString(process.env.APP_VERSION, '1.0')!)
      .addBearerAuth()
      .addServer(envString(process.env.BACKEND_URL, '/')!)
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(swaggerPath, app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
      },
      customSiteTitle: `${appName} API`,
      customCss: '.swagger-ui .topbar { display: none }',
    });
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────
  // Without this, OnApplicationShutdown never fires — Redis, Kafka and MQTT
  // connections are torn down by process exit rather than closed, which on a
  // rolling deploy drops in-flight messages.
  app.enableShutdownHooks();

  // ── Start ──────────────────────────────────────────────────────────────────
  const port = envNumber(process.env.PORT, 5000);
  const host = envString(process.env.HOST, '0.0.0.0')!;
  await app.listen(port, host);

  // Prefer the real bound address over BACKEND_URL: the old log printed
  // `undefined` whenever BACKEND_URL was unset, and printed the public URL even
  // when the app was listening somewhere else entirely.
  const publicUrl = envString(process.env.BACKEND_URL) ?? (await app.getUrl());

  logger.log(`🚀 ${appName} listening on ${host}:${port} (${nodeEnv})`);
  logger.log(`🔗 Public URL: ${publicUrl}`);
  logger.log(
    envBoolean(process.env.API_PREFIX_ENABLED, false)
      ? `📍 Routes served under /${apiPrefix}`
      : '📍 Routes served from the root (set API_PREFIX_ENABLED=true to use API_PREFIX)',
  );
  logger.log(
    swaggerEnabled
      ? `📚 API documentation: ${publicUrl}/${swaggerPath}`
      : '📚 API documentation disabled (set ENABLE_SWAGGER=true to enable)',
  );
}

/**
 * Maps LOG_LEVEL to the Nest logger levels, which are cumulative rather than a
 * single threshold. Falls back to a production-safe set when unrecognised.
 */
function resolveLogLevels(
  level: string | undefined,
  nodeEnv: string | undefined,
): ('error' | 'warn' | 'log' | 'debug' | 'verbose')[] {
  const ladder: Record<
    string,
    ('error' | 'warn' | 'log' | 'debug' | 'verbose')[]
  > = {
    error: ['error'],
    warn: ['error', 'warn'],
    info: ['error', 'warn', 'log'],
    log: ['error', 'warn', 'log'],
    debug: ['error', 'warn', 'log', 'debug'],
    verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
  };

  const normalized = (level ?? '').trim().toLowerCase();
  if (ladder[normalized]) return ladder[normalized];

  return nodeEnv === 'production' ? ladder.info : ladder.debug;
}

// Explicitly voided: the lint rule requires a floating promise be marked, and
// there is nothing meaningful to do with a bootstrap failure beyond crashing.
void bootstrap();