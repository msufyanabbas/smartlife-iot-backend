import { RedisConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';

export default registerAs(
  'redis',
  (): RedisConfig => ({
    // Connection
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0', 10),

    // Connection Options
    keyPrefix: process.env.REDIS_KEY_PREFIX,
    retryAttempts: parseInt(process.env.REDIS_RETRY_ATTEMPTS || '3', 10),
    retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || '1000', 10),

    // Timeouts
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '10000', 10),
    commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT || '5000', 10),

    // Cache TTL (in seconds)
    ttl: parseInt(process.env.REDIS_TTL || '3600', 10), // 1 hour

    // Connection Pool
    maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
    enableReadyCheck: process.env.REDIS_READY_CHECK !== 'false',
    enableOfflineQueue: process.env.REDIS_OFFLINE_QUEUE !== 'false',
  }),
);
