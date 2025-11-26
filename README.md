# IoT Platform Backend API

Enterprise-grade IoT Management Platform backend built with NestJS and TypeScript.

## 🚀 Tech Stack

- **Framework**: NestJS 10
- **Language**: TypeScript 5
- **Database**: PostgreSQL 15
- **ORM**: TypeORM
- **Cache**: Redis
- **Queue**: Bull
- **WebSocket**: Socket.io
- **IoT Protocol**: MQTT
- **Authentication**: JWT + Passport
- **Validation**: class-validator
- **Documentation**: Swagger/OpenAPI
- **Logging**: Winston
- **Testing**: Jest

## 📦 Installation

```bash
# Install dependencies
npm install

# Run in development mode
npm run start:dev

# Run in production mode
npm run build
npm run start:prod

# Run tests
npm run test
npm run test:e2e
npm run test:cov
```

## 🗄️ Database Setup

```bash
# Create PostgreSQL database
createdb iot_platform

# Run migrations
npm run migration:run

# Revert migrations
npm run migration:revert

# Create new migration
npm run migration:create
```

## 🐳 Docker Setup (Recommended)

```bash
# Start PostgreSQL and Redis
docker-compose up -d postgres redis

# Start MQTT broker
docker-compose up -d mqtt
```

## 🔧 Environment Configuration

Copy `.env.example` to `.env.development` and configure:

```env
NODE_ENV=development
PORT=5000
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=postgres
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=your-secret-key
```

## 🏗️ Project Architecture

### Modular Structure
Each feature module follows this pattern:

```
module/
├── module.module.ts      # Module definition
├── module.controller.ts  # HTTP endpoints
├── module.service.ts     # Business logic
├── module.gateway.ts     # WebSocket (optional)
├── dto/                  # Data Transfer Objects
├── entities/             # Database entities
└── repositories/         # Data access layer
```

### Core Modules

- **Auth**: JWT authentication, refresh tokens
- **Users**: User management, roles, permissions
- **Tenants**: Multi-tenancy support
- **Devices**: IoT device management
- **Telemetry**: Time-series data handling
- **Attributes**: Device attributes and metadata
- **Rules**: Rule engine for automation
- **Alarms**: Alarm management and notifications
- **Dashboards**: Dashboard configuration
- **MQTT**: IoT device communication
- **WebSocket**: Real-time updates

## 📡 API Documentation

Swagger UI available at: `http://localhost:5000/api/docs`

## 🔐 Authentication

The API uses JWT Bearer tokens:

```bash
# Login
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password"
}

# Response
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}

# Use token in headers
Authorization: Bearer <accessToken>
```

## 🔄 Real-time Communication

### WebSocket Events
```typescript
// Connect
socket.connect('http://localhost:5000');

// Subscribe to device telemetry
socket.emit('subscribe', { deviceId: '123' });

// Receive telemetry updates
socket.on('telemetry', (data) => {
  console.log(data);
});
```

### MQTT Topics
```
devices/{deviceId}/telemetry    # Device telemetry data
devices/{deviceId}/attributes   # Device attributes
devices/{deviceId}/rpc/request  # RPC commands
devices/{deviceId}/rpc/response # RPC responses
```

## 📊 Database Schema

### Key Entities
- **Tenant**: Multi-tenant isolation
- **User**: User accounts with roles
- **Device**: IoT devices
- **DeviceProfile**: Device type configuration
- **Telemetry**: Time-series data
- **Attribute**: Device properties
- **RuleChain**: Automation workflows
- **RuleNode**: Rule components
- **Alarm**: System alarms
- **Dashboard**: Visualization config

## 🎯 Features

### Multi-tenancy
- Tenant isolation at database level
- Row-level security
- Tenant context middleware

### Rule Engine
- Visual flow-based rule editor
- Pre-built rule nodes
- Custom JavaScript execution
- Event-driven processing

### Real-time Telemetry
- High-throughput data ingestion
- Time-series optimization
- Aggregation and downsampling
- Real-time streaming to clients

### Alarm Management
- Configurable alarm rules
- Severity levels
- Alarm propagation
- Multi-channel notifications

### Security
- JWT authentication
- Role-based access control (RBAC)
- API rate limiting
- Input validation
- SQL injection prevention
- XSS protection

## 🧪 Testing

```bash
# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

## 📈 Performance

- Database connection pooling
- Redis caching layer
- Bull queue for async jobs
- Indexed database queries
- Pagination support
- Bulk operations

## 📝 Code Style

- ESLint + Prettier
- TypeScript strict mode
- Conventional commits
- Automated formatting

## 🔍 Monitoring

- Health check endpoint: `/health`
- Metrics endpoint: `/metrics`
- Winston structured logging
- Request/response logging

## 🚀 Deployment

```bash
# Build
npm run build

# Start production
npm run start:prod

# Docker
docker build -t iot-platform-api .
docker run -p 5000:5000 iot-platform-api
```

## 📚 Additional Resources

- [NestJS Documentation](https://docs.nestjs.com)
- [TypeORM Documentation](https://typeorm.io)
- [Swagger/OpenAPI Spec](http://localhost:5000/api/docs)

## 🤝 Contributing

1. Follow the module structure
2. Write tests for new features
3. Update API documentation
4. Follow TypeScript best practices