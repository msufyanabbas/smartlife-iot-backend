// src/test/setup/jest.setup.ts
// This file runs BEFORE all tests

// Set test environment
process.env.NODE_ENV = 'test';

// Set test database (if you use different DB for tests)
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_DATABASE = 'postgres';
process.env.DB_USERNAME = 'postgres';
process.env.DB_PASSWORD = '123456';

// Kafka/Redis for tests (mocked, so these don't matter)
process.env.KAFKA_BROKERS = 'localhost:9093';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';

// Increase timeout for tests
jest.setTimeout(30000); // 30 seconds

// Global test setup
beforeAll(async () => {
  console.log('🧪 Setting up tests...');
  // You can add global setup here if needed
});

// Global test teardown
afterAll(async () => {
  console.log('✅ Tests completed');
  // Cleanup if needed
});

// Mock console.log in tests to reduce noise
global.console = {
  ...console,
  log: jest.fn(), // Mock console.log
  debug: jest.fn(), // Mock console.debug
  info: jest.fn(), // Mock console.info
  warn: console.warn, // Keep warnings
  error: console.error, // Keep errors
};
