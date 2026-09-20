// src/config/app.config.ts
import { AppConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { envBoolean, envList, envNumber, envString } from './env.utils';

export default registerAs(
  'app',
  (): AppConfig => ({
    // Application Info
    name: envString(process.env.APP_NAME, 'Smart Life IoT Platform'),
    environment: envString(process.env.NODE_ENV, 'development'),
    port: envNumber(process.env.PORT, 5000),
    apiPrefix: envString(process.env.API_PREFIX, 'api'),

    // URLs.
    // No localhost fallbacks: these end up inside password-reset links,
    // invitation emails and OAuth redirects. A silent fallback sends customers
    // a link to a machine that does not exist, and the failure only shows up in
    // their inbox — never in the logs.
    frontendUrl: envString(process.env.FRONTEND_URL),
    backendUrl: envString(process.env.BACKEND_URL),

    // Security
    corsOrigins: envList(process.env.CORS_ORIGIN, ['*']),

    // Logging
    logLevel: envString(process.env.LOG_LEVEL, 'info'),
    logFilePath: envString(process.env.LOG_FILE_PATH, './logs'),

    // Rate Limiting (milliseconds; see AppModule for the seconds/ms handling)
    throttleTtl: envNumber(process.env.THROTTLE_TTL, 60000),
    throttleLimit: envNumber(process.env.THROTTLE_LIMIT, 100),

    // File Upload
    maxFileSize: envNumber(process.env.MAX_FILE_SIZE, 10485760), // 10MB
    uploadPath: envString(process.env.UPLOAD_PATH, './uploads'),
    allowedFileTypes: envList(process.env.ALLOWED_FILE_TYPES, [
      'image/jpeg',
      'image/png',
      'application/pdf',
    ]),

    // Pagination
    defaultPageSize: envNumber(process.env.DEFAULT_PAGE_SIZE, 10),
    maxPageSize: envNumber(process.env.MAX_PAGE_SIZE, 100),

    // Email
    smtp: {
      host: envString(process.env.SMTP_HOST),
      port: envNumber(process.env.SMTP_PORT, 587),
      user: envString(process.env.SMTP_USER),
      pass: envString(process.env.SMTP_PASS),
      // Was hardcoded to iot@smart-life.sa. A wrong From address on a shared
      // SMTP relay gets the whole domain marked as spam.
      from: envString(process.env.SMTP_FROM),
    },

    // Features
    features: {
      enableSwagger: envBoolean(
        process.env.ENABLE_SWAGGER,
        process.env.NODE_ENV !== 'production',
      ),
      enableMetrics: envBoolean(process.env.ENABLE_METRICS, true),
      enableCaching: envBoolean(process.env.ENABLE_CACHING, true),
    },
  }),
);
