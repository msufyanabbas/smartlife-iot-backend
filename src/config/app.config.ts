// src/config/app.config.ts
import { AppConfig } from '@common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';

const parseBoolean = (value: string | undefined, defaultValue = false): boolean => {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
};

export default registerAs(
  'app',
  (): AppConfig => ({
    // Application Info
    name: process.env.APP_NAME || 'Smart Life IoT Platform',
    environment: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '5000', 10),
    apiPrefix: process.env.API_PREFIX || 'api',

    // URLs
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',

    // Security
    corsOrigins: process.env.CORS_ORIGIN?.split(',').map(o => o.trim()) || ['*'],

    // Logging
    logLevel: process.env.LOG_LEVEL || 'info',
    logFilePath: process.env.LOG_FILE_PATH || './logs',

    // Rate Limiting
    throttleTtl: parseInt(process.env.THROTTLE_TTL || '60000', 10), // milliseconds
    throttleLimit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),

    // File Upload
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
    uploadPath: process.env.UPLOAD_PATH || './uploads',
    allowedFileTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || [
      'image/jpeg',
      'image/png',
      'application/pdf',
    ],

    // Pagination
    defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE || '10', 10),
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '100', 10),

    // Email
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || 'iot@smart-life.sa',
    },

    // Features
    features: {
      enableSwagger: parseBoolean(process.env.ENABLE_SWAGGER, true),
      enableMetrics: parseBoolean(process.env.ENABLE_METRICS, true),
      enableCaching: parseBoolean(process.env.ENABLE_CACHING, true),
    },
  }),
);