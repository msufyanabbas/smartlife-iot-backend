/**
 * Configuration Module Exports
 *
 * All configuration namespaces are registered here and loaded by
 * ConfigModule.forRoot({ load: configModules }).
 *
 * Read a namespace with configService.get<T>('redis'), not by reaching for
 * process.env in a service — the namespace is where parsing, defaults and
 * required-value checks live, so bypassing it means those never run.
 */

import appConfig from './app.config';
import databaseConfig from './database.config';
import jwtConfig from './jwt.config';
import redisConfig from './redis.config';
import mqttConfig from './mqtt.config';
import kafkaConfig from './kafka.config';
import migrationConfig from './migration.config';

export { validateEnv } from './env.validation';
export {
  envBoolean,
  envList,
  envNumber,
  envRequired,
  envString,
  normalizeUrl,
} from './env.utils';
export { envFilePaths, loadEnvFiles } from './load-env';

/**
 * All configuration modules array
 * Use this when registering config in modules
 */
export const configModules = [
  appConfig,
  databaseConfig,
  jwtConfig,
  redisConfig,
  mqttConfig,
  kafkaConfig,
  migrationConfig,
];
