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

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    cors: true, // Enable CORS at creation time
  });

  const telemetryConsumer = app.get(TelemetryConsumer);
  await telemetryConsumer.start();

  const configService = app.get(ConfigService);
  const isDevelopment = configService.get('NODE_ENV') !== 'production';

  // ✅ CORS Configuration - MUST come before helmet
  app.enableCors({
    origin: true, // This allows all origins
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
    ],
    exposedHeaders: [
      'Content-Length',
      'Content-Type',
      'X-Total-Count',
    ],
    maxAge: 86400, // 24 hours
  });

  // Security - Configure helmet AFTER CORS
  if (isDevelopment) {
    // In development, use minimal helmet configuration
    app.use(
      helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: false,
      }),
    );
  } else {
    // In production, configure helmet to work with CORS
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: [`'self'`],
            styleSrc: [`'self'`, `'unsafe-inline'`, 'https:'],
            scriptSrc: [`'self'`, `'unsafe-inline'`, `'unsafe-eval'`, 'https:'],
            imgSrc: [`'self'`, 'data:', 'https:', 'validator.swagger.io'],
            connectSrc: [`'self'`, 'https:', 'wss:', 'ws:'],
            fontSrc: [`'self'`, 'https:', 'data:'],
            objectSrc: [`'none'`],
            mediaSrc: [`'self'`],
            frameSrc: [`'none'`],
          },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
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
    .addServer(configService.get('BACKEND_URL') || 'http://localhost:5000', 'API Server')
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

  const backendUrl = configService.get('BACKEND_URL') || `http://localhost:${port}`;
  console.log(`🚀 Application is running on: ${backendUrl}`);
  console.log(`📚 API Documentation: ${backendUrl}/docs`);
  console.log(`🌍 CORS: Enabled for all origins`);
  console.log(`🔒 Environment: ${isDevelopment ? 'Development' : 'Production'}`);
}

bootstrap();