import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@modules/index.service';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from '@common/filters/index.filter';
import {
  LoggingInterceptor,
  TimeoutInterceptor,
  TransformInterceptor,
} from '@common/interceptors/index.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  const configService = app.get(ConfigService);
  const isDevelopment = configService.get('NODE_ENV') !== 'production';

  // ── Validation ─────────────────────────────────────────────────────────────
  // Registered once with the full configuration.
  // whitelist: strips properties not in the DTO
  // transform: auto-converts primitives (string → number etc.)
  // forbidNonWhitelisted: throws if unknown properties are sent
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true
      }
    })
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

  // ── CORS ───────────────────────────────────────────────────────────────────
  const corsOrigin = configService.get('CORS_ORIGIN');
  const allowedOrigins = corsOrigin
    ? corsOrigin.split(',').map((origin: string) => origin.trim())
    : '*';

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // ── Filters ────────────────────────────────────────────────────────────────
  app.useGlobalFilters(new HttpExceptionFilter());

  // ── Interceptors ───────────────────────────────────────────────────────────
  // Note: AuditInterceptor, MetricsInterceptor, UsageTrackingInterceptor are
  // registered as APP_INTERCEPTOR in AppModule so they have DI access.
  // Only stateless interceptors (no constructor dependencies) can go here.
  app.useGlobalInterceptors(
    new LoggingInterceptor(),           // logs all requests
    new TransformInterceptor(),         // wraps all responses
    new TimeoutInterceptor(configService), // enforces 30s timeout
  );

  // ── Swagger ────────────────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Smart Life IoT Platform API')
    .setDescription('Enterprise IoT Management Platform API Documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    customSiteTitle: 'Smart Life IoT Platform API',
    customCss: '.swagger-ui .topbar { display: none }',
  });

  // ── Start ──────────────────────────────────────────────────────────────────
  const port = configService.get('PORT', 5000);
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Application is running on: ${process.env.BACKEND_URL}`);
  console.log(`📚 API Documentation: ${process.env.BACKEND_URL}/docs`);
}

bootstrap();
