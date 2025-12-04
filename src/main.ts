import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from '@common/filters/http-exception.filter';
import { TelemetryConsumer } from './modules/telemetry/telemetry.consumer';
import {
  TimeoutInterceptor,
  LoggingInterceptor,
  TransformInterceptor,
} from './common/interceptors/index';
import { SubscriptionsService } from './modules/subscriptions/subscriptions.service';
import { ApiUsageInterceptor } from './common/interceptors/api-usage.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );

  
  // const subscriptionService = app.get(SubscriptionsService);
  // app.useGlobalInterceptors(new ApiUsageInterceptor(subscriptionService));

  const telemetryConsumer = app.get(TelemetryConsumer);
  await telemetryConsumer.start();

  const configService = app.get(ConfigService);

  // ✅ CORS - Parse comma-separated origins
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

  // Security - Disable helmet in development or configure it properly for Swagger
  const isDevelopment = configService.get('NODE_ENV') !== 'production';

  if (isDevelopment) {
    // In development, use minimal helmet configuration
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
      }),
    );
  } else {
    // In production, use stricter helmet configuration
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

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
    // new TimeoutInterceptor(configService),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Smart Life IoT Platform API')
    .setDescription('Enterprise IoT Management Platform API Documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
    customSiteTitle: 'Smart Life IoT Platform API',
    customCss: '.swagger-ui .topbar { display: none }',
  });

  const port = configService.get('PORT', 5000);
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Application is running on: ${process.env.BACKEND_URL}`);
  console.log(`📚 API Documentation: ${process.env.BACKEND_URL}/docs`);
}

bootstrap();
