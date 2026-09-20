import { RedisConfig } from '@/common/interfaces/common.interface';
import { registerAs } from '@nestjs/config';
import { envBoolean, envNumber, envRequired, envString } from './env.utils';

export default registerAs(
  'redis',
  (): RedisConfig => ({
    // Connection.
    // REDIS_HOST is required: defaulting to localhost meant a deploy with a
    // missing variable would start, fail every cache read against a Redis that
    // is not there, and look like a Redis outage rather than a config mistake.
    host: envRequired('REDIS_HOST', process.env.REDIS_HOST),
    port: envNumber(process.env.REDIS_PORT, 6379),
    password: envString(process.env.REDIS_PASSWORD),
    db: envNumber(process.env.REDIS_DB, 0),

    // Connection Options
    keyPrefix: envString(process.env.REDIS_KEY_PREFIX, 'smartlife:'),
    retryAttempts: envNumber(process.env.REDIS_RETRY_ATTEMPTS, 3),
    retryDelay: envNumber(process.env.REDIS_RETRY_DELAY, 1000),

    // Timeouts
    connectTimeout: envNumber(process.env.REDIS_CONNECT_TIMEOUT, 10000),
    commandTimeout: envNumber(process.env.REDIS_COMMAND_TIMEOUT, 5000),

    // Cache TTL (seconds)
    ttl: envNumber(process.env.REDIS_TTL, 3600),

    // Connection Pool
    maxRetriesPerRequest: envNumber(process.env.REDIS_MAX_RETRIES, 3),
    enableReadyCheck: envBoolean(process.env.REDIS_READY_CHECK, true),
    enableOfflineQueue: envBoolean(process.env.REDIS_OFFLINE_QUEUE, true),
  }),
);
