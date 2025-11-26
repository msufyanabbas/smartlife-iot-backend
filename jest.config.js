// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.spec.ts',
    '**/__tests__/**/*.test.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/types/**',
    '!src/migrations/**',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 80,
      statements: 80,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
      '^@lib/(.*)$': '<rootDir>/src/lib/$1', // covers both kafka and 
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@database/(.*)$': '<rootDir>/src/database/$1',
    '^@decorators/(.*)$': '<rootDir>/src/common/decorators/$1',
    '^@filters/(.*)$': '<rootDir>/src/common/filters/$1',
    '^@guards/(.*)$': '<rootDir>/src/common/guards/$1',
    '^@interceptors/(.*)$': '<rootDir>/src/common/interceptors/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup/jest.setup.ts'],
  testTimeout: 10000,
  maxWorkers: '50%',
  verbose: true,
};