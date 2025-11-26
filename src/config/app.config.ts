import { AppConfig } from '@/common/interfaces/common.interface';
import { parseBoolean } from '@/common/utils/helpers';
import { registerAs } from '@nestjs/config';

export default registerAs(
  'app',
  (): AppConfig => ({
    // Application Info
    name: process.env.APP_NAME,
    environment: process.env.NODE_ENV,
    port: parseInt(process.env.PORT || '5000', 10),
    apiPrefix: process.env.API_PREFIX,

    // URLs
    frontendUrl: process.env.FRONTEND_URL,
    backendUrl: process.env.BACKEND_URL,

    // Security
    corsOrigins: process.env.CORS_ORIGIN?.split(',') || [],

    // Logging
    logLevel: process.env.LOG_LEVEL,
    logFilePath: process.env.LOG_FILE_PATH,

    // Rate Limiting
    throttleTtl: parseInt(process.env.THROTTLE_TTL || '60', 10),
    throttleLimit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),

    // File Upload
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
    uploadPath: process.env.UPLOAD_PATH,
    allowedFileTypes: process.env.ALLOWED_FILE_TYPES?.split(','),

    // Pagination
    defaultPageSize: parseInt(process.env.DEFAULT_PAGE_SIZE || '10', 10),
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '100', 10),

    // Email
    smtp: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM,
    },

    // Features
    features: {
      enableSwagger: parseBoolean(process.env.ENABLE_SWAGGER),
      enableMetrics: parseBoolean(process.env.ENABLE_METRICS),
      enableCaching: parseBoolean(process.env.ENABLE_CACHING),
    },
  }),
);
