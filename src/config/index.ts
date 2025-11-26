/**
 * Configuration Module Exports
 *
 * Imported all configuration modules here for easy access
 * throughout the application.
 */

import appConfig from './app.config';
import databaseConfig from './database.config';
import jwtConfig from './jwt.config';
import redisConfig from './redis.config';
import mqttConfig from './mqtt.config';
import migrationConfig from './migration.config';

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
  migrationConfig,
];
