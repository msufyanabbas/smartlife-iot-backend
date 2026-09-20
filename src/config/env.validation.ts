// src/config/env.validation.ts
//
// Fail-fast validation of the environment, run by `ConfigModule.forRoot()`.
//
// Written by hand rather than with Joi/zod on purpose: the project has neither
// as a dependency, and adding one for a single schema means every deploy target
// has to reinstall before it can boot. This has no imports.
//
// The rule the platform now follows: anything that is a *secret* or points at
// *infrastructure* has no default. If it is missing the process refuses to
// start, in production, with the variable named. A service that silently falls
// back to `localhost` or `smartlife123` looks healthy in the logs and then
// fails at the first request — usually in front of a customer.
//
// Tuning knobs (timeouts, pool sizes, page sizes) do keep defaults. Those are
// safe to omit and there is no security consequence to getting them wrong.

type Rule = {
  /** Required in every environment. */
  required?: boolean;
  /** Required only when NODE_ENV=production. */
  requiredInProduction?: boolean;
  kind?: 'string' | 'number' | 'boolean' | 'url' | 'email' | 'list';
  /** Minimum length — used for secrets. */
  minLength?: number;
  /** Allowed values. */
  oneOf?: string[];
  /** Values that must never reach production (shipped placeholders). */
  forbiddenInProduction?: string[];
};

const TRUE_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'off'];

// Placeholders that ship in .env.production.example. If one of these is still
// in place in production, the deploy was never configured.
const EXAMPLE_JWT_SECRETS = [
  'your-super-secret-jwt-key-change-this-in-production',
  'your-super-secret-refresh-key-change-this-in-production',
  'verification_secret',
  'reset_secret',
  'changeme',
  'secret',
];

const SCHEMA: Record<string, Rule> = {
  // ── Application ───────────────────────────────────────────────────────────
  NODE_ENV: {
    required: true,
    oneOf: ['development', 'test', 'staging', 'production'],
  },
  PORT: { kind: 'number' },
  API_PREFIX: { kind: 'string' },
  APP_NAME: { kind: 'string' },
  BACKEND_URL: { requiredInProduction: true, kind: 'url' },
  FRONTEND_URL: { requiredInProduction: true, kind: 'url' },
  CORS_ORIGIN: { requiredInProduction: true, kind: 'list' },
  CORS_ALLOW_ANY_ORIGIN: { kind: 'boolean' },

  // ── Database ──────────────────────────────────────────────────────────────
  DB_HOST: { required: true },
  DB_PORT: { kind: 'number' },
  DB_USERNAME: { required: true },
  DB_PASSWORD: { required: true, minLength: 8 },
  DB_DATABASE: { required: true },
  DB_SYNCHRONIZE: { kind: 'boolean' },
  DB_LOGGING: { kind: 'boolean' },
  DB_SSL: { kind: 'boolean' },
  DB_SSL_REJECT_UNAUTHORIZED: { kind: 'boolean' },
  DB_RUN_MIGRATIONS: { kind: 'boolean' },
  DB_POOL_SIZE: { kind: 'number' },
  DB_RETRY_ATTEMPTS: { kind: 'number' },
  DB_RETRY_DELAY: { kind: 'number' },

  // ── Redis ─────────────────────────────────────────────────────────────────
  REDIS_HOST: { required: true },
  REDIS_PORT: { kind: 'number' },
  REDIS_PASSWORD: { requiredInProduction: true },
  REDIS_DB: { kind: 'number' },
  REDIS_TTL: { kind: 'number' },

  // ── JWT ───────────────────────────────────────────────────────────────────
  JWT_SECRET: {
    required: true,
    minLength: 32,
    forbiddenInProduction: EXAMPLE_JWT_SECRETS,
  },
  JWT_REFRESH_SECRET: {
    required: true,
    minLength: 32,
    forbiddenInProduction: EXAMPLE_JWT_SECRETS,
  },
  JWT_VERIFICATION_SECRET: { forbiddenInProduction: EXAMPLE_JWT_SECRETS },
  JWT_RESET_SECRET: { forbiddenInProduction: EXAMPLE_JWT_SECRETS },

  // ── MQTT ──────────────────────────────────────────────────────────────────
  MQTT_BROKER_URL: { required: true },
  MQTT_PORT: { kind: 'number' },
  MQTT_QOS: { oneOf: ['0', '1', '2'] },
  MQTT_SSL: { kind: 'boolean' },
  MQTT_KEEP_ALIVE: { kind: 'number' },

  // ── Kafka ─────────────────────────────────────────────────────────────────
  KAFKA_BROKERS: { required: true, kind: 'list' },

  // ── Security ──────────────────────────────────────────────────────────────
  BCRYPT_SALT_ROUNDS: { kind: 'number' },
  THROTTLE_TTL: { kind: 'number' },
  THROTTLE_LIMIT: { kind: 'number' },
  REQUEST_TIMEOUT: { kind: 'number' },

  // ── Features ──────────────────────────────────────────────────────────────
  ENABLE_SWAGGER: { kind: 'boolean' },
  ENABLE_METRICS: { kind: 'boolean' },
  ENABLE_CACHING: { kind: 'boolean' },

  // ── Uploads ───────────────────────────────────────────────────────────────
  MAX_FILE_SIZE: { kind: 'number' },
  MAX_DWG_FILE_SIZE: { kind: 'number' },
  DEFAULT_PAGE_SIZE: { kind: 'number' },
  MAX_PAGE_SIZE: { kind: 'number' },

  // ── Mail ──────────────────────────────────────────────────────────────────
  SMTP_PORT: { kind: 'number' },
  SMTP_FROM: { kind: 'email' },

  // ── Protocol adapters ─────────────────────────────────────────────────────
  COAP_ENABLED: { kind: 'boolean' },
  COAP_PORT: { kind: 'number' },
  BLE_ENABLED: { kind: 'boolean' },
  BLE_AUTO_CONNECT: { kind: 'boolean' },
  ZIGBEE_ENABLED: { kind: 'boolean' },
  MODBUS_ENABLED: { kind: 'boolean' },
  AUTO_REGISTER_DEVICES: { kind: 'boolean' },
  REQUIRE_API_KEY: { kind: 'boolean' },
};

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function checkKind(
  key: string,
  raw: string,
  kind: Rule['kind'],
): string | null {
  const value = raw.trim();

  switch (kind) {
    case 'number':
      return Number.isFinite(Number(value))
        ? null
        : `${key} must be a number (received "${raw}")`;

    case 'boolean':
      return [...TRUE_VALUES, ...FALSE_VALUES].includes(value.toLowerCase())
        ? null
        : `${key} must be a boolean — true/false (received "${raw}")`;

    case 'url':
      try {
        new URL(value);
        return null;
      } catch {
        return `${key} must be an absolute URL including the scheme, e.g. https://api.example.com (received "${raw}")`;
      }

    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
        ? null
        : `${key} must be a valid email address (received "${raw}")`;

    case 'list':
      return value.split(',').every((part) => part.trim().length > 0)
        ? null
        : `${key} must be a comma-separated list with no empty entries (received "${raw}")`;

    default:
      return null;
  }
}

/**
 * Passed to `ConfigModule.forRoot({ validate })`. Returns the config untouched
 * on success and throws with every problem listed on failure — one restart to
 * see all of them, rather than fixing variables one at a time.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const isProduction = config.NODE_ENV === 'production';
  const errors: string[] = [];

  for (const [key, rule] of Object.entries(SCHEMA)) {
    const raw = config[key] as string | undefined;

    if (isBlank(raw)) {
      if (rule.required) {
        errors.push(`${key} is required but was not set`);
      } else if (rule.requiredInProduction && isProduction) {
        errors.push(`${key} is required when NODE_ENV=production`);
      }
      continue;
    }

    const value = String(raw).trim();

    if (rule.kind) {
      const kindError = checkKind(key, value, rule.kind);
      if (kindError) errors.push(kindError);
    }

    if (rule.oneOf && !rule.oneOf.includes(value)) {
      errors.push(
        `${key} must be one of: ${rule.oneOf.join(', ')} (received "${value}")`,
      );
    }

    if (rule.minLength && value.length < rule.minLength) {
      errors.push(
        `${key} must be at least ${rule.minLength} characters (received ${value.length})`,
      );
    }

    if (
      isProduction &&
      rule.forbiddenInProduction?.some(
        (bad) => bad.toLowerCase() === value.toLowerCase(),
      )
    ) {
      errors.push(
        `${key} is still set to the example placeholder — generate a real value before deploying (openssl rand -hex 32)`,
      );
    }
  }

  // Cross-field rules that no single-variable check can express.
  if (isProduction) {
    if (config.JWT_SECRET && config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
      errors.push(
        'JWT_SECRET and JWT_REFRESH_SECRET must differ — sharing one secret lets an access token be replayed as a refresh token',
      );
    }

    if (String(config.DB_SYNCHRONIZE).toLowerCase() === 'true') {
      errors.push(
        'DB_SYNCHRONIZE must not be true in production — it rewrites the schema on boot and can drop columns; use migrations instead',
      );
    }

    // A bare "*" is still rejected, because it is nearly always an accident and
    // it silently breaks credentialed requests. Accepting any origin on purpose
    // is a different thing and has its own explicit switch, so the intent is
    // visible in the env file rather than hidden in a wildcard.
    const allowAny = ['true', '1', 'yes', 'on'].includes(
      String(config.CORS_ALLOW_ANY_ORIGIN ?? '').trim().toLowerCase(),
    );

    if (!allowAny && String(config.CORS_ORIGIN).trim() === '*') {
      errors.push(
        'CORS_ORIGIN must not be "*" in production — list the frontend origins explicitly, ' +
          'or set CORS_ALLOW_ANY_ORIGIN=true if accepting any origin is genuinely intended',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors
        .map((message) => `  • ${message}`)
        .join('\n')}\n\nCompare your .env against .env.production.example.`,
    );
  }

  return config;
}