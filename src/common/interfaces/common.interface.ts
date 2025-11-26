// App Configuration
export interface AppConfig {
  // Application Info
  name: string | undefined;
  environment: string | undefined;
  port: number | undefined;
  apiPrefix: string | undefined;

  // URLs
  frontendUrl: string | undefined;
  backendUrl: string | undefined;

  // Security
  corsOrigins: string[] | undefined;

  // Logging
  logLevel: string | undefined;
  logFilePath: string | undefined;

  // Rate Limiting
  throttleTtl: number | undefined;
  throttleLimit: number | undefined;

  // File Upload
  maxFileSize: number | undefined;
  uploadPath: string | undefined;
  allowedFileTypes: string[] | undefined;

  // Pagination
  defaultPageSize: number | undefined;
  maxPageSize: number | undefined;

  // Email
  smtp: {
    host: string | undefined;
    port: number | undefined;
    user: string | undefined;
    pass: string | undefined;
    from: string | undefined;
  };

  // Features
  features: {
    enableSwagger: boolean | undefined;
    enableMetrics: boolean | undefined;
    enableCaching: boolean | undefined;
  };
}

// Database Configuration
export interface DatabaseConfig {
  type: 'postgres';
  host: string | undefined;
  port: number | undefined;
  username: string | undefined;
  password: string | undefined;
  database: string | undefined;
  synchronize: boolean | undefined;
  logging: boolean | undefined;
  ssl?: boolean | { rejectUnauthorized: boolean } | undefined;
  autoLoadEntities: boolean | undefined;
  retryAttempts: number | undefined;
  retryDelay: number | undefined;
  extra: {
    max: number | undefined;
    connectionTimeoutMillis: number | undefined;
    idleTimeoutMillis: number | undefined;
  };
}

// JWT Configuration
export interface JwtConfig {
  // Access Token
  secret: string | undefined;
  expiresIn: string | undefined;

  // Refresh Token
  refreshSecret: string | undefined;
  refreshExpiresIn: string | undefined;

  // Email Verification Token
  verificationSecret: string | undefined;
  verificationExpiresIn: string | undefined;

  // Password Reset Token
  resetSecret: string | undefined;
  resetExpiresIn: string | undefined;

  // Token Options
  issuer: string | undefined;
  audience: string | undefined;
}

// Redis Configuration
export interface RedisConfig {
  // Connection
  host: string | undefined;
  port: number | undefined;
  password: string | undefined;
  db: number | undefined;

  // Connection Options
  keyPrefix: string | undefined;
  retryAttempts: number | undefined;
  retryDelay: number | undefined;

  // Timeouts
  connectTimeout: number | undefined;
  commandTimeout: number | undefined;

  // Cache TTL
  ttl: number | undefined;

  // Connection Pool
  maxRetriesPerRequest: number | undefined;
  enableReadyCheck: boolean | undefined;
  enableOfflineQueue: boolean | undefined;
}

// MQTT Configuration
export interface MqttConfig {
  // Broker Connection
  brokerUrl: string | undefined;
  clientId: string | undefined;
  username: string | undefined;
  password: string | undefined;

  // Connection Options
  protocol: string | 'mqtt' | 'mqtts' | 'ws' | 'wss' | undefined;
  port: number | undefined;
  keepAlive: number | undefined;
  connectTimeout: number | undefined;
  reconnectPeriod: number | undefined;

  // QoS (Quality of Service)
  qos: 0 | 1 | 2;

  // Topics
  topics: {
    telemetry: string | undefined;
    commands: string | undefined;
    status: string | undefined;
    alerts: string | undefined;
  };

  // SSL/TLS
  ssl: boolean | undefined;
  rejectUnauthorized: boolean | undefined;

  // Features
  cleanSession: boolean | undefined;
  retainMessages: boolean | undefined;
}

// Migration Configuration
export interface MigrationConfig {
  // Database Connection
  type: 'postgres';
  host: string | undefined;
  port: number | undefined;
  username: string | undefined;
  password: string | undefined;
  database: string | undefined;

  // Migration Settings
  entities: string[] | undefined;
  migrations: string[] | undefined;
  migrationsTableName: string | undefined;
  synchronize: boolean | undefined;
  logging: boolean | undefined;

  // Connection Options
  ssl: boolean | undefined;
  extra?: {
    ssl?: {
      rejectUnauthorized: boolean | undefined;
    };
  };
}

// Request with authenticated user
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

// Pagination options
export interface PaginationOptions {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

// Sort options
export interface SortOptions {
  field: string;
  order: 'ASC' | 'DESC';
}

// Filter options
export interface FilterOptions {
  search?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  [key: string]: any;
}

// Query options combining pagination, sort, and filter
export interface QueryOptions {
  pagination?: PaginationOptions;
  sort?: SortOptions;
  filter?: FilterOptions;
}

// Generic list response
export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// File upload
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer?: Buffer;
}

// MQTT Message
export interface MqttMessage {
  topic: string;
  payload: Buffer | string;
  qos: 0 | 1 | 2;
  retain: boolean;
}

// Device Telemetry
export interface DeviceTelemetry {
  deviceId: string;
  timestamp: Date;
  data: Record<string, any>;
  metadata?: Record<string, any>;
}

// API Response
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  timestamp: string;
}

// Error Response
export interface ErrorResponse {
  success: false;
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path?: string;
}

// JWT Payload
export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

// Refresh Token Payload
export interface RefreshTokenPayload extends JwtPayload {
  tokenId: string;
}

// User Session
export interface UserSession {
  userId: string;
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  lastActivity: Date;
  expiresAt: Date;
}

// Audit Log
export interface AuditLog {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}

// Notification
export interface Notification {
  userId: string;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

// WebSocket Event
export interface WebSocketEvent<T = any> {
  event: string;
  data: T;
  timestamp: Date;
}

// Health Check
export interface HealthCheck {
  status: 'ok' | 'error';
  info?: Record<string, any>;
  error?: Record<string, any>;
  details?: Record<string, any>;
}
